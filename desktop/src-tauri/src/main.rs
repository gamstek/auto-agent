#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod updates;
mod support;
mod configuration;
mod corax;
mod chat_debug;
mod shutdown;
use corax::{CoraxRuntime, start, stop, has_active_work};
use shutdown::request_exit;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{path::{Path, PathBuf}, process::Stdio, time::Duration};
use tauri::{Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_dialog::DialogExt;
use tokio::{io::{AsyncBufReadExt, BufReader}, process::{Child, Command}, sync::Mutex};
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
struct Settings {
    model: String,
    #[serde(rename = "baseURL")]
    base_url: String,
    data_dir: String,
    llm_wiki: configuration::LlmWikiSettings,
    climber: configuration::ClimberSettings,
    max_input_tokens: u64,
    max_output_tokens: u64,
    system_prompt: String,
}
impl Default for Settings {
    fn default() -> Self {
        Self { model: "deepseek-flash".into(), base_url: "https://api.deepseek.com".into(),
            data_dir: ".".into(), llm_wiki: configuration::LlmWikiSettings::default(), climber: configuration::ClimberSettings::default(),
            max_input_tokens: 128000, max_output_tokens: 16000, system_prompt: String::new() }
    }
}
impl Settings {
    fn validate(&self) -> Result<(), String> {
        for value in [&self.base_url] {
            let url = reqwest::Url::parse(value).map_err(|_| "服务地址不是有效 URL")?;
            if !["http", "https"].contains(&url.scheme()) || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
                return Err("服务地址须为不包含凭据、查询参数或片段的 HTTP/HTTPS 地址".into());
            }
        }
        if self.model.trim().is_empty() || self.model.len() > 200 || self.data_dir.trim().is_empty()
            || self.max_input_tokens == 0 || self.max_output_tokens == 0
            || self.system_prompt.chars().count() > 16000 {
            return Err("请检查模型、数据目录、Token 容量与角色提示词".into());
        }
        self.llm_wiki.validate()?;
        self.climber.validate()?;
        Ok(())
    }
}
struct Desktop { root: PathBuf, config_path: PathBuf, backend: Mutex<Option<CoraxRuntime>>, owned_tree: std::sync::Mutex<Option<std::sync::Weak<corax::ProcessTree>>>, client: reqwest::Client, pending_apply: AtomicBool, exiting: AtomicBool }
fn credential(root: &Path) -> Result<keyring::Entry, String> { keyring::Entry::new("com.gamstek.autoagent", &format!("model-api-key:{}", root.display())).map_err(|_| "无法访问系统凭据库".into()) }
fn read_key(root: &Path) -> Result<Option<String>, String> {
    match credential(root)?.get_password() { Ok(key) => Ok(Some(key)), Err(keyring::Error::NoEntry) => Ok(None), Err(_) => Err("无法读取系统凭据库，请检查 Windows 凭据服务".into()) }
}
fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let bytes = serde_json::to_vec_pretty(value).map_err(|_| "无法序列化设置")?;
        std::fs::write(&temporary, bytes).map_err(|_| "无法写入设置文件")?;
        std::fs::rename(&temporary, path).map_err(|_| "无法替换设置文件")
    })();
    let _ = std::fs::remove_file(&temporary);
    result.map_err(String::from)
}
#[tauri::command]
async fn backend_start(app: tauri::AppHandle, state: State<'_, Desktop>) -> Result<Value, String> {
    let mut slot = state.backend.lock().await; start(&app, &state, &mut slot).await?;
    Ok(json!({ "ready": true }))
}
#[tauri::command]
fn settings_read(state: State<'_, Desktop>) -> Result<Value, String> {
    let document = configuration::read(&state.config_path)?;
    let environment_key = std::env::var("AUTO_AGENT_API_KEY").ok().is_some_and(|v| !v.trim().is_empty());
    Ok(json!({ "settings": configuration::settings(&state.config_path, &document.raw)?, "configRevision": document.revision,
        "defaults": {"climber": configuration::ClimberSettings::default()},
        "configPath": configuration::display_path(&state.config_path), "apiKeySource": if environment_key { "environment" } else { "keyring" },
        "hasApiKey": environment_key || read_key(&state.root)?.is_some(), "pendingApply": state.pending_apply.load(Ordering::SeqCst),
        "dataDirectory": configuration::data_directory(&state.config_path, &document.raw)?, "version": env!("CARGO_PKG_VERSION") }))
}
async fn apply_when_idle(app: tauri::AppHandle) {
    loop {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let state = app.state::<Desktop>();
        if state.exiting.load(Ordering::SeqCst) || !state.pending_apply.load(Ordering::SeqCst) { continue; }
        let Ok(mut slot) = state.backend.try_lock() else { continue; };
        if let Some(backend) = slot.as_ref() {
            match has_active_work(&state, backend).await { Ok(false) => {}, _ => continue }
        }
        state.pending_apply.store(false, Ordering::SeqCst);
        let result = async {
            stop(&state, &mut slot).await?;
            let _ = app.emit("backend-stream", "disconnected");
            start(&app, &state, &mut slot).await
        }.await;
        let _ = match result {
            Ok(()) => app.emit("settings-applied", json!({ "applied": true })),
            Err(error) => app.emit("settings-applied", json!({ "applied": false, "error": error })),
        };
    }
}
#[tauri::command]
async fn settings_save(app: tauri::AppHandle, state: State<'_, Desktop>, settings: Settings, config_revision: String, api_key: Option<String>, clear_key: bool) -> Result<Value, String> {
    settings.validate()?;
    if api_key.as_ref().is_some_and(|key| key.len() > 4096 || key.trim().is_empty()) { return Err("API Key 长度或内容无效".into()); }
    if clear_key && api_key.is_some() { return Err("不能同时保存和移除 Key".into()); }
    let mut slot = state.backend.lock().await;
    if configuration::read(&state.config_path)?.revision != config_revision { return Err("共享配置已被外部修改，请重新读取配置后再编辑".into()); }
    configuration::merged(&state.config_path, &configuration::read(&state.config_path)?.raw, &settings)?;
    if clear_key { match credential(&state.root)?.delete_credential() { Ok(()) | Err(keyring::Error::NoEntry) => {}, Err(_) => return Err("无法移除系统凭据".into()) } }
    if let Some(key) = api_key { credential(&state.root)?.set_password(key.trim()).map_err(|_| "无法保存至系统凭据库")?; }
    let config_revision = configuration::save(&state.config_path, &config_revision, &settings)?;
    state.pending_apply.store(true, Ordering::SeqCst);
    if state.exiting.load(Ordering::SeqCst) { return Ok(json!({ "saved": true, "applied": false, "configRevision": config_revision })); }
    if let Some(backend) = slot.as_ref() {
        if has_active_work(&state, backend).await.unwrap_or(true) { return Ok(json!({ "saved": true, "applied": false, "configRevision": config_revision })); }
    }
    state.pending_apply.store(false, Ordering::SeqCst);
    let applied = async {
        stop(&state, &mut slot).await?;
        let _ = app.emit("backend-stream", "disconnected");
        start(&app, &state, &mut slot).await
    }.await;
    Ok(json!({ "saved": true, "applied": applied.is_ok(), "error": applied.err(), "configRevision": config_revision }))
}
#[tauri::command]
fn open_logs(app: tauri::AppHandle, state: State<'_, Desktop>) -> Result<(), String> {
    let document = configuration::read(&state.config_path)?;
    let path = configuration::data_directory(&state.config_path, &document.raw)?.join("corax").join("logs"); std::fs::create_dir_all(&path).map_err(|_| "无法创建日志目录")?;
    app.opener().open_path(path.to_string_lossy(), None::<&str>).map_err(|_| "无法打开日志目录".into())
}
#[tauri::command]
fn open_link(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let parsed = reqwest::Url::parse(&url).map_err(|_| "链接无效")?;
    if !["http", "https"].contains(&parsed.scheme()) || !parsed.username().is_empty() || parsed.password().is_some() { return Err("仅支持普通网页链接".into()); }
    app.opener().open_url(url, None::<&str>).map_err(|_| "无法打开链接".into())
}
#[tauri::command]
fn show_main(app: tauri::AppHandle) { if let Some(window) = app.get_webview_window("main") { let _ = window.show(); let _ = window.unminimize(); let _ = window.set_focus(); } if let Some(window) = app.get_webview_window("launcher") { let _ = window.hide(); } }
#[tauri::command]
fn hide_main(app: tauri::AppHandle) { if let Some(window) = app.get_webview_window("main") { let _ = window.hide(); } if let Some(window) = app.get_webview_window("launcher") { let _ = window.show(); } }
#[tauri::command]
fn window_action(app: tauri::AppHandle, window: tauri::WebviewWindow, action: String) -> Result<Value, String> {
    if window.label() != "main" { return Err("此窗口不支持主窗口操作".into()); }
    match action.as_str() {
        "state" => {},
        "drag" => window.start_dragging().map_err(|_| "无法拖动窗口")?,
        "minimize" => window.minimize().map_err(|_| "无法最小化窗口")?,
        "toggle-maximize" => {
            if window.is_maximized().map_err(|_| "无法读取窗口状态")? {
                window.unmaximize().map_err(|_| "无法还原窗口")?;
            } else { window.maximize().map_err(|_| "无法最大化窗口")?; }
        },
        "close" => request_exit(app),
        _ => return Err("不支持的窗口操作".into()),
    }
    Ok(json!({ "maximized": window.is_maximized().unwrap_or(false), "minimized": window.is_minimized().unwrap_or(false), "visible": window.is_visible().unwrap_or(false), "decorated": window.is_decorated().unwrap_or(true) }))
}
#[tauri::command]
fn drag_launcher(app: tauri::AppHandle) { if let Some(window) = app.get_webview_window("launcher") { let _ = window.start_dragging(); } }
#[tauri::command]
fn launcher_compact(app: tauri::AppHandle, compact: bool) { if let Some(window) = app.get_webview_window("launcher") { let _ = window.set_size(tauri::LogicalSize::new(if compact { 44.0 } else { 88.0 }, if compact { 84.0 } else { 120.0 })); } }
#[tauri::command]
fn launcher_menu(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "launcher" { return Err("此菜单仅用于悬浮助手".into()); }
    let open = tauri::menu::MenuItem::with_id(&app, "launcher-open", "打开 AI 助理", true, None::<&str>).map_err(|_| "无法创建菜单")?;
    let exit = tauri::menu::MenuItem::with_id(&app, "launcher-exit", "退出应用", true, None::<&str>).map_err(|_| "无法创建菜单")?;
    let menu = tauri::menu::Menu::with_items(&app, &[&open, &exit]).map_err(|_| "无法创建菜单")?;
    window.popup_menu(&menu).map_err(|_| "无法打开菜单".into())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show_main(app.clone())))
        .plugin(tauri_plugin_dialog::init()).plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(updates::Updates::default())
        .setup(|app| {
            let args: Vec<String> = std::env::args().collect();
            if args.iter().any(|arg| arg == "--data-dir") && args.iter().any(|arg| arg == "--config") { return Err("--data-dir 与 --config 不能同时指定".into()); }
            let config_path = if let Some(index) = args.iter().position(|arg| arg == "--data-dir") {
                let path = PathBuf::from(args.get(index + 1).ok_or("--data-dir requires an absolute path")?);
                if !path.is_absolute() { return Err("--data-dir requires an absolute path".into()); }
                path.join("config.json")
            } else if let Some(index) = args.iter().position(|arg| arg == "--config") {
                std::path::absolute(args.get(index + 1).ok_or("--config requires a path")?)?
            } else if cfg!(debug_assertions) {
                Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap().join(".auto-agent/config.json")
            } else { app.path().home_dir()?.join(".auto-agent/config.json") };
            let root = config_path.parent().ok_or("配置路径无效")?.to_path_buf();
            std::fs::create_dir_all(&root)?;
            if !args.iter().any(|arg| arg == "--config") { configuration::ensure(&config_path)?; }
            #[cfg(debug_assertions)] {
                let document = configuration::read(&config_path)?;
                let logs = configuration::data_directory(&config_path, &document.raw)?.join("corax/logs");
                chat_debug::initialize(&logs);
            }
            let client = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(30)).build()?;
            app.manage(Desktop { root, config_path, backend: Mutex::new(None), owned_tree: std::sync::Mutex::new(None), client, pending_apply: AtomicBool::new(false), exiting: AtomicBool::new(false) });
            tauri::async_runtime::spawn(apply_when_idle(app.handle().clone()));
            tauri::WebviewWindowBuilder::new(app, "launcher", tauri::WebviewUrl::App("index.html?launcher".into()))
                .title("AI 助理").inner_size(88.0, 120.0).decorations(false).transparent(true).always_on_top(true).skip_taskbar(true).resizable(false).visible(false).build()?;
            Ok(())
        })
        .on_window_event(|window, event| { match event {
            tauri::WindowEvent::CloseRequested { api, .. } if matches!(window.label(), "main" | "launcher") => { api.prevent_close(); request_exit(window.app_handle().clone()); },
            tauri::WindowEvent::Resized(_) if window.label() == "main" => { let _ = window.emit("main-window-state", ()); },
            _ => {}
        } })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "launcher-open" => show_main(app.clone()),
            "launcher-exit" => request_exit(app.clone()),
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![chat_debug::frontend_debug, updates::update_check, updates::update_install, support::export_diagnostics, backend_start, corax::backend_request, corax::backend_watch, corax::backend_chat_open, corax::backend_chat_close, settings_read, settings_save, open_logs, open_link, show_main, hide_main, window_action, drag_launcher, launcher_compact, launcher_menu, shutdown::exit_app])
        .run(tauri::generate_context!()).expect("Unable to start desktop application");
}

#[cfg(test)] mod tests {
    use super::*;
    use corax::allowed_request;
    #[test] fn request_scope_is_fixed() {
        assert!(allowed_request("GET", "/runtime"));
        assert!(allowed_request("GET", "/devices"));
        assert!(allowed_request("POST", "/devices/climber/refresh"));
        for path in ["/devices/climber/start", "/devices/climber/register", "/devices/other/refresh", "/mcp/call", "/desktop/devices/climber/refresh"] { assert!(!allowed_request("POST", path)); }
        assert!(!allowed_request("GET", "/session/wrun_01M6JWQZ0A0QH6MERWTZ96Z7TB/conversation"));
        assert!(allowed_request("GET", "/session/wrun_01M6JWQZ0A0QH6MERWTZ96Z7TB/events"));
        assert!(allowed_request("POST", "/session/wrun_01M6JWQZ0A0QH6MERWTZ96Z7TB/respond"));
        assert!(!allowed_request("GET", "/session/wrun_01M6JWQZ0A0QH6MERWTZ96Z7TB/trace"));
        assert!(!allowed_request("GET", "/wiki/catalog"));
        assert!(!allowed_request("POST", "/wiki/search"));
        assert!(!allowed_request("POST", "/wiki/read"));
        assert!(!allowed_request("POST", "/wiki/sources"));
        assert!(!allowed_request("POST", "/wiki/builds"));
        assert!(allowed_request("POST", "/session/wrun_01M6JWQZ0A0QH6MERWTZ96Z7TB/prompt_async"));
        assert!(!allowed_request("POST", "/session/12345678-1234-4234-8234-123456789abc/prompt_async"));
        for path in ["//example.com", "/desktop/shutdown", "/session/../../event", "/event", "https://example.com"] { assert!(!allowed_request("GET", path)); }
    }
    #[test] fn settings_validate_paths_and_protocols() {
        assert!(Settings::default().validate().is_ok());
        let mut settings = Settings::default(); settings.base_url = "https://user:password@example.com".into(); assert!(settings.validate().is_err());
        settings = Settings::default(); settings.max_input_tokens = 0; assert!(settings.validate().is_err());
    }
    #[test] fn updater_plugin_configuration_deserializes_without_a_deployment_key() {
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let _: tauri_plugin_updater::Config = serde_json::from_value(config["plugins"]["updater"].clone()).unwrap();
    }
}
