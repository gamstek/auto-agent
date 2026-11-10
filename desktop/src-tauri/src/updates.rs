use super::*;
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct Updates(pub Mutex<Option<Update>>);

fn trusted_download(url: &reqwest::Url) -> bool {
    url.scheme() == "https" && url.host_str() == Some("github.com")
        && url.username().is_empty() && url.password().is_none() && url.port().is_none()
        && url.query().is_none() && url.fragment().is_none()
        && url.path().starts_with("/gamstek/auto-agent/releases/download/v")
        && url.path().ends_with("-setup.exe")
}

#[tauri::command]
pub async fn update_check(app: tauri::AppHandle, updates: State<'_, Updates>) -> Result<Value, String> {
    if !cfg!(all(windows, target_arch = "x86_64")) { return Err("当前更新渠道仅提供 Windows x64 安装包".into()); }
    let mut pending = updates.0.try_lock().map_err(|_| "更新操作正在进行")?;
    *pending = None;
    let key = option_env!("AUTO_AGENT_UPDATER_PUBLIC_KEY").filter(|s| !s.trim().is_empty())
        .ok_or("此构建尚未配置更新签名公钥，请手动安装新版本")?;
    let channel = if env!("CARGO_PKG_VERSION").contains('-') { "beta" } else { "stable" };
    let endpoint = format!("https://github.com/gamstek/auto-agent/releases/download/desktop-{channel}/latest.json");
    let update = app.updater_builder().pubkey(key).target("windows-x86_64")
        .endpoints(vec![endpoint.parse().map_err(|_| "更新地址无效")?]).map_err(|_| "更新配置无效")?
        .timeout(Duration::from_secs(120)).build().map_err(|_| "无法初始化更新服务")?
        .check().await.map_err(|_| "无法检查更新，请检查网络或稍后重试")?;
    if let Some(ref update) = update {
        if !trusted_download(&update.download_url) {
            return Err("更新下载地址不属于可信发布源".into());
        }
        if channel == "stable" && update.version.contains('-') { return Err("稳定渠道不能安装预览版本".into()); }
    }
    let result = json!({ "channel": channel, "version": update.as_ref().map(|u| &u.version), "notes": update.as_ref().and_then(|u| u.body.as_ref()) });
    *pending = update;
    Ok(result)
}

#[tauri::command]
pub async fn update_install(app: tauri::AppHandle, state: State<'_, Desktop>, updates: State<'_, Updates>) -> Result<(), String> {
    if state.exiting.load(Ordering::SeqCst) { return Err("应用正在退出或安装更新".into()); }
    let pending = updates.0.try_lock().map_err(|_| "更新操作正在进行")?;
    let update = pending.as_ref().ok_or("请先检查更新")?;
    // Downloads do not affect local work. Do not scan conversations or hold a
    // backend lifecycle lock before the download/signature verification begins.
    let mut downloaded = 0usize;
    let bytes = update.download(|chunk, total| {
        downloaded += chunk;
        let _ = app.emit("update-progress", json!({ "downloaded": downloaded, "total": total }));
    }, || {}).await.map_err(|_| "更新下载或签名校验失败，尚未安装")?;
    let _ = app.emit("update-stage", "checking");
    if state.exiting.swap(true, Ordering::SeqCst) { return Err("应用正在退出或安装更新".into()); }
    let mut slot = state.backend.lock().await;
    // One authoritative idle-safe stop, under the lifecycle lock and with new
    // writes blocked. An unreadable/busy backend never authorizes installation.
    let result = install_after_safe_stop(
        || corax::stop_for_update(&state, &mut slot),
        || {
            let _ = app.emit("update-stage", "installing");
            update.install(bytes).map_err(|_| "更新安装启动失败，请重试或手动安装".to_string())
        },
    ).await;
    if result.is_err() {
        state.exiting.store(false, Ordering::SeqCst);
        if slot.is_none() { let _ = start(&app, &state, &mut slot).await; }
    }
    result
}

fn backend_stop_error(reason: String) -> String {
    format!("安装包已下载并通过签名校验，但无法安全停止后台：{reason}\n尚未启动安装。请在任务结束并恢复后台连接后重试；也可确认关闭应用后手动运行新版安装包。")
}

async fn install_after_safe_stop<S, F, I>(stop: S, install: I) -> Result<(), String>
where S: FnOnce() -> F, F: std::future::Future<Output = Result<(), String>>, I: FnOnce() -> Result<(), String> {
    stop().await.map_err(backend_stop_error)?;
    install()
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn download_scope_rejects_other_hosts_repositories_and_credentials() {
        assert!(trusted_download(&"https://github.com/gamstek/auto-agent/releases/download/v2.0.0/Auto-Agent_2.0.0_x64-setup.exe".parse().unwrap()));
        for url in [
            "http://github.com/gamstek/auto-agent/releases/download/v2/a-setup.exe",
            "https://github.com/other/app/releases/download/v2/a-setup.exe",
            "https://github.com.evil.test/gamstek/auto-agent/releases/download/v2/a-setup.exe",
            "https://user:secret@github.com/gamstek/auto-agent/releases/download/v2/a-setup.exe",
            "https://github.com/gamstek/auto-agent/releases/download/v2/a-setup.exe?token=secret",
        ] { assert!(!trusted_download(&url.parse().unwrap())); }
    }
    #[test] fn an_unreadable_or_busy_backend_never_starts_the_verified_installer() { tauri::async_runtime::block_on(async {
        for reason in ["读取 Corax 状态超时", "仍有后台任务在执行，或有写入尚待确认。"] {
            let message = install_after_safe_stop(
                || std::future::ready(Err(reason.to_string())),
                || panic!("failed safety check must not launch an installer"),
            ).await.unwrap_err();
            assert!(message.contains("已下载并通过签名校验"));
            assert!(message.contains(reason));
            assert!(message.contains("尚未启动安装"));
            assert!(!message.contains("不要重复提交"));
        }
    }); }
    #[test] fn verified_installer_runs_only_after_one_successful_idle_safe_stop() { tauri::async_runtime::block_on(async {
        let calls = std::cell::RefCell::new(vec![]);
        install_after_safe_stop(
            || { calls.borrow_mut().push("stop"); std::future::ready(Ok(())) },
            || { calls.borrow_mut().push("install"); Ok(()) },
        ).await.unwrap();
        assert_eq!(*calls.borrow(), vec!["stop", "install"]);
    }); }
}
