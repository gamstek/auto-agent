use super::*;
use std::future::Future;
use tauri_plugin_dialog::{MessageDialogButtons, MessageDialogKind, MessageDialogResult};

const FORCE_CLOSE: &str = "强制关闭";
const CONTINUE_RUNNING: &str = "继续运行";

fn explicitly_confirmed(result: MessageDialogResult) -> bool {
    matches!(result, MessageDialogResult::Custom(label) if label == FORCE_CLOSE)
}

#[derive(Debug, PartialEq)]
enum ExitOutcome { Exit, Cancelled, InProgress }

struct ExitIntent<'a> { flag: &'a AtomicBool, committed: bool }
impl<'a> ExitIntent<'a> {
    fn acquire(flag: &'a AtomicBool) -> Option<Self> {
        flag.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).ok()
            .map(|_| Self { flag, committed: false })
    }
}
impl Drop for ExitIntent<'_> {
    fn drop(&mut self) { if !self.committed { self.flag.store(false, Ordering::SeqCst); } }
}

async fn attempt_exit<N, C, F>(
    flag: &AtomicBool,
    normal: impl FnOnce() -> N,
    confirm: impl FnOnce(String) -> C,
    force: impl FnOnce() -> F,
) -> Result<ExitOutcome, String>
where N: Future<Output = Result<(), String>>, C: Future<Output = bool>, F: Future<Output = Result<(), String>> {
    let Some(mut intent) = ExitIntent::acquire(flag) else { return Ok(ExitOutcome::InProgress); };
    let timing = chat_debug::Span::new("exit");
    if let Err(reason) = normal().await {
        timing.mark("confirmation", json!({}));
        if !confirm(reason).await {
            timing.mark("cancelled", json!({}));
            return Ok(ExitOutcome::Cancelled);
        }
        timing.mark("force-confirmed", json!({}));
        force().await?;
    }
    timing.mark("stopped", json!({}));
    intent.committed = true;
    Ok(ExitOutcome::Exit)
}

async fn confirm_exit(app: tauri::AppHandle, reason: String) -> bool {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    {
        let mut dialog = app.dialog().message(format!(
            "{reason}\n\n强制关闭会中断本地后台进程，但已下发的仪器任务可能仍在运行。未完成写入的结果需要重新核对。"
        )).title("确认强制关闭应用？").kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(FORCE_CLOSE.into(), CONTINUE_RUNNING.into()));
        let parent = app.get_webview_window("main").filter(|window| window.is_visible().unwrap_or(false))
            .or_else(|| app.get_webview_window("launcher").filter(|window| window.is_visible().unwrap_or(false)));
        if let Some(parent) = parent { dialog = dialog.parent(&parent); }
        dialog.show_with_result(move |result| { let _ = sender.send(explicitly_confirmed(result)); });
    }
    // Dismissal, dialog failure or a dropped callback never authorizes force-close.
    receiver.await.unwrap_or(false)
}

#[tauri::command]
pub async fn exit_app(app: tauri::AppHandle, state: State<'_, Desktop>) -> Result<(), String> {
    let outcome = attempt_exit(
        &state.exiting,
        || async {
            let mut slot = tokio::time::timeout(Duration::from_secs(3), state.backend.lock()).await
                .map_err(|_| "后台生命周期操作尚未完成，无法及时安全退出。".to_string())?;
            corax::stop_for_exit(&state, &mut slot).await
        },
        |reason| confirm_exit(app.clone(), reason),
        || corax::force_exit(&state),
    ).await?;
    if outcome == ExitOutcome::Exit { app.exit(0); }
    Ok(())
}

pub fn request_exit(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = exit_app(app.clone(), app.state::<Desktop>()).await {
            app.dialog().message(error).title("退出失败").show(|_| {});
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test] fn only_the_explicit_force_button_authorizes_force_close() {
        assert!(explicitly_confirmed(MessageDialogResult::Custom(FORCE_CLOSE.into())));
        for result in [MessageDialogResult::Cancel, MessageDialogResult::No, MessageDialogResult::Yes,
            MessageDialogResult::Ok, MessageDialogResult::Custom(CONTINUE_RUNNING.into()),
            MessageDialogResult::Custom("unexpected".into())] {
            assert!(!explicitly_confirmed(result));
        }
    }

    #[test] fn idle_exit_does_not_prompt_or_force() { tauri::async_runtime::block_on(async {
        let flag = AtomicBool::new(false);
        let outcome = attempt_exit(&flag, || async { Ok(()) }, |_| async { panic!("idle exit must not prompt") }, || async { panic!("idle exit must not force") }).await.unwrap();
        assert_eq!(outcome, ExitOutcome::Exit);
        assert!(flag.load(Ordering::SeqCst));
    }); }

    #[test] fn declining_confirmation_keeps_work_running_and_reopens_admission() { tauri::async_runtime::block_on(async {
        let flag = AtomicBool::new(false);
        let outcome = attempt_exit(&flag, || async { Err("busy".into()) }, |reason| std::future::ready({
            assert_eq!(reason, "busy");
            assert!(flag.load(Ordering::SeqCst));
            false
        }), || async { panic!("declining must not force or cancel work") }).await.unwrap();
        assert_eq!(outcome, ExitOutcome::Cancelled);
        assert!(!flag.load(Ordering::SeqCst));
    }); }

    #[test] fn force_runs_only_after_explicit_confirmation_with_admission_blocked() { tauri::async_runtime::block_on(async {
        let flag = AtomicBool::new(false);
        let events = RefCell::new(vec![]);
        let outcome = attempt_exit(&flag,
            || async { events.borrow_mut().push("normal"); Err("busy".into()) },
            |_| async { assert!(flag.load(Ordering::SeqCst)); events.borrow_mut().push("confirmed"); true },
            || async { assert!(flag.load(Ordering::SeqCst)); events.borrow_mut().push("force"); Ok(()) },
        ).await.unwrap();
        assert_eq!(*events.borrow(), vec!["normal", "confirmed", "force"]);
        assert_eq!(outcome, ExitOutcome::Exit);
        assert!(flag.load(Ordering::SeqCst));
    }); }

    #[test] fn duplicate_exit_does_not_prompt_again_or_take_updater_ownership() { tauri::async_runtime::block_on(async {
        let flag = AtomicBool::new(true);
        let outcome = attempt_exit(&flag,
            || async { panic!("existing exit owns shutdown") },
            |_| async { panic!("duplicate prompt") },
            || async { panic!("unconfirmed force") },
        ).await.unwrap();
        assert_eq!(outcome, ExitOutcome::InProgress);
        assert!(flag.load(Ordering::SeqCst));
    }); }

    #[test] fn unavailable_status_can_be_confirmed_but_force_failure_releases_exit_intent() { tauri::async_runtime::block_on(async {
        let flag = AtomicBool::new(false);
        let result = attempt_exit(&flag,
            || async { Err("status unavailable".into()) },
            |reason| std::future::ready({ assert_eq!(reason, "status unavailable"); true }),
            || async { Err("termination failed".into()) },
        ).await;
        assert_eq!(result, Err("termination failed".into()));
        assert!(!flag.load(Ordering::SeqCst));
    }); }

    #[test] fn dropping_an_unfinished_confirmation_never_forces_and_releases_exit_intent() { tauri::async_runtime::block_on(async {
        let flag = AtomicBool::new(false);
        let result = tokio::time::timeout(Duration::from_millis(20), attempt_exit(&flag,
            || async { Err("busy".into()) },
            |_| std::future::pending::<bool>(),
            || async { panic!("no confirmation result") },
        )).await;
        assert!(result.is_err());
        assert!(!flag.load(Ordering::SeqCst));
    }); }
}
