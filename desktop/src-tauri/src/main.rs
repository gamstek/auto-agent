#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod updates;
mod support;
mod configuration;

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
    manufacturer_url: String,
    manufacturer_timeout_ms: u64,
    template_directory: String,
    builtin_skills: bool,
    builtin_wiki: bool,
    skill_roots: Vec<String>,
    wiki_roots: Vec<String>,
    wiki_index_roots: Vec<String>,
    max_steps: u32,
    max_input_tokens: u64,
    max_output_tokens: u64,
    model_timeout_ms: u64,
    script_timeout_ms: u64,
    web_allow_private_addresses: bool,
    system_prompt: String,
}
impl Default for Settings {
    fn default() -> Self {
        Self { model: "deepseek-flash".into(), base_url: "https://api.deepseek.com".into(),
            manufacturer_url: "http://127.0.0.1:18080/api/v1".into(), manufacturer_timeout_ms: 5000,
            template_directory: String::new(), builtin_skills: true, builtin_wiki: true,
            skill_roots: vec![], wiki_roots: vec![], wiki_index_roots: vec![], max_steps: 24,
            max_input_tokens: 1_000_000, max_output_tokens: 16000, model_timeout_ms: 60000,
            script_timeout_ms: 30000, web_allow_private_addresses: true, system_prompt: String::new() }
    }
}
impl Settings {
    fn validate(&self) -> Result<(), String> {
        for value in [&self.base_url, &self.manufacturer_url] {
            let url = reqwest::Url::parse(value).map_err(|_| "服务地址不是有效 URL")?;
            if !["http", "https"].contains(&url.scheme()) || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
                return Err("服务地址须为不包含凭据、查询参数或片段的 HTTP/HTTPS 地址".into());
            }
        }
        if !self.manufacturer_url.trim_end_matches('/').ends_with("/api/v1") { return Err("厂家地址需要包含 /api/v1".into()); }
        if self.model.trim().is_empty() || self.model.len() > 200 || !(1..=100).contains(&self.max_steps)
            || self.max_input_tokens == 0 || self.max_output_tokens == 0
            || self.model_timeout_ms == 0 || self.script_timeout_ms == 0
            || !(100..=120000).contains(&self.manufacturer_timeout_ms) || self.system_prompt.len() > 16000 {
            return Err("请检查模型、步数、Token 容量与超时范围".into());
        }
        for paths in [&self.skill_roots, &self.wiki_roots, &self.wiki_index_roots] {
            if paths.iter().any(|p| !Path::new(p).is_absolute()) { return Err("资源目录必须是绝对路径".into()); }
        }
        if !self.template_directory.is_empty() && !Path::new(&self.template_directory).is_absolute() { return Err("模板输出目录须为绝对路径".into()); }
        Ok(())
    }
}
struct Backend { child: Child, url: String, token: String, stream: tauri::async_runtime::JoinHandle<()> }
struct Desktop { root: PathBuf, config_path: PathBuf, backend: Mutex<Option<Backend>>, client: reqwest::Client, pending_apply: AtomicBool, exiting: AtomicBool }
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
fn binary_path() -> Result<PathBuf, String> {
    let executable = std::env::current_exe().map_err(|_| "无法定位应用程序")?;
    let name = if cfg!(windows) { "auto-agent-backend.exe" } else { "auto-agent-backend" };
    let beside = executable.parent().ok_or("应用路径无效")?.join(name);
    if beside.is_file() { return Ok(beside); }
    if cfg!(debug_assertions) {
        let triple = if cfg!(windows) { "x86_64-pc-windows-msvc.exe" } else { "x86_64-unknown-linux-gnu" };
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries").join(format!("auto-agent-backend-{triple}"));
        if path.is_file() { return Ok(path); }
    }
    Err("未找到配套后端程序，请重新安装完整桌面版本".into())
}
async fn event_loop(app: tauri::AppHandle, url: String, token: String) {
    let client = match reqwest::Client::builder().no_proxy().connect_timeout(Duration::from_secs(5)).build() { Ok(c) => c, Err(_) => return };
    loop {
        match client.get(format!("{url}/event")).bearer_auth(&token).send().await {
            Ok(response) if response.status().is_success() => {
                let _ = app.emit("backend-stream", "connected");
                let mut stream = response.bytes_stream();
                let mut pending: Vec<u8> = vec![];
                while let Some(Ok(bytes)) = stream.next().await {
                    pending.extend_from_slice(&bytes);
                    if pending.len() > 512 * 1024 { break; }
                    while let Some(end) = pending.iter().position(|b| *b == b'\n') {
                        let line: Vec<u8> = pending.drain(..=end).collect();
                        if line.starts_with(b"data: ") {
                            if let Ok(event) = serde_json::from_slice::<Value>(&line[6..]) { let _ = app.emit("agent-event", event); }
                        }
                    }
                }
            }
            _ => {}
        }
        let _ = app.emit("backend-stream", "disconnected");
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}
async fn start(app: &tauri::AppHandle, state: &Desktop, slot: &mut Option<Backend>) -> Result<(), String> {
    if state.exiting.load(Ordering::SeqCst) { return Err("应用正在退出或安装更新".into()); }
    if let Some(backend) = slot {
        if backend.child.try_wait().map_err(|_| "无法检查后端进程")?.is_none() { return Ok(()); }
        backend.stream.abort();
    }
    *slot = None;
    let document = configuration::read(&state.config_path)?;
    let key = match std::env::var("AUTO_AGENT_API_KEY").ok().filter(|v| !v.trim().is_empty()) {
        Some(key) => Some(key), None => read_key(&state.root)?,
    };
    let config_path = state.root.join("backend.json");
    write_json(&config_path, &configuration::runtime(&state.config_path, &document.raw)?)?;
    let token = uuid::Uuid::new_v4().to_string();
    let mut command = Command::new(binary_path()?);
    command.args(["serve", "--config"]).arg(config_path).current_dir(state.config_path.parent().ok_or("配置路径无效")?)
        .env_clear().env("AUTO_AGENT_TOKEN", &token).env("AUTO_AGENT_DESKTOP", "1")
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    for name in ["PATH", "SystemRoot", "TEMP", "TMP", "TMPDIR", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"] {
        if let Some(value) = std::env::var_os(name) { command.env(name, value); }
    }
    if let Some(key) = key { command.env("AUTO_AGENT_API_KEY", key); }
    #[cfg(windows)] command.creation_flags(0x08000000);
    let mut child = command.spawn().map_err(|_| "后端启动失败，请检查程序文件与本机权限")?;
    let stderr = child.stderr.take().ok_or("无法读取后端诊断通道")?;
    tauri::async_runtime::spawn(async move { let mut lines = BufReader::new(stderr).lines(); while let Ok(Some(_)) = lines.next_line().await {} });
    let stdout = child.stdout.take().ok_or("无法读取后端启动通道")?;
    let mut lines = BufReader::new(stdout).lines();
    let url = tokio::time::timeout(Duration::from_secs(25), async {
        while let Ok(Some(line)) = lines.next_line().await {
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                if value["event"] == "listening" {
                    if let Some(url) = value["url"].as_str() { return Ok(url.to_string()); }
                }
            }
        }
        Err("后端启动时退出，请检查共享配置、日志以及是否有 CLI 正在占用同一数据目录".to_string())
    }).await.map_err(|_| "后端启动超时，请查看应用日志")??;
    let parsed = reqwest::Url::parse(&url).map_err(|_| "后端监听地址无效")?;
    if parsed.scheme() != "http" || parsed.host_str() != Some("127.0.0.1") || parsed.port().is_none() { return Err("后端未绑定受支持的本机地址".into()); }
    let healthy = state.client.get(format!("{url}/global/health")).send().await.map_err(|_| "后端健康检查失败")?;
    if !healthy.status().is_success() { return Err("后端尚未就绪".into()); }
    tauri::async_runtime::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
    let stream = tauri::async_runtime::spawn(event_loop(app.clone(), url.clone(), token.clone()));
    *slot = Some(Backend { child, url, token, stream });
    if state.pending_apply.swap(false, Ordering::SeqCst) { let _ = app.emit("settings-applied", json!({ "applied": true })); }
    Ok(())
}
async fn stop(state: &Desktop, slot: &mut Option<Backend>) -> Result<(), String> {
    if let Some(backend) = slot {
        if backend.child.try_wait().map_err(|_| "无法检查后端进程")?.is_none() {
            let response = state.client.post(format!("{}/desktop/shutdown", backend.url)).bearer_auth(&backend.token).send().await.map_err(|_| "无法正常停止后端，请查看日志后重试")?;
            if response.status().as_u16() == 409 { return Err("任务仍在执行，请等待完成或明确取消后再应用设置/退出".into()); }
            if !response.status().is_success() { return Err("后端拒绝退出请求".into()); }
            tokio::time::timeout(Duration::from_secs(25), backend.child.wait()).await.map_err(|_| "后端正在清理，请稍后重试退出")?.map_err(|_| "无法等待后端退出")?;
        }
        backend.stream.abort();
    }
    *slot = None;
    Ok(())
}
#[tauri::command]
async fn backend_start(app: tauri::AppHandle, state: State<'_, Desktop>) -> Result<Value, String> {
    let mut slot = state.backend.lock().await; start(&app, &state, &mut slot).await?;
    Ok(json!({ "ready": true }))
}
fn allowed_request(method: &str, path: &str) -> bool {
    if !path.starts_with('/') || path.contains("..") || path.contains(['\\', '#', '\r', '\n']) { return false; }
    let route = path.split('?').next().unwrap_or("");
    if method == "GET" && ["/global/health", "/runtime", "/session", "/wiki", "/wiki/index", "/wiki/search"].contains(&route) { return true; }
    if method == "POST" && route == "/session" { return true; }
    let parts: Vec<_> = route.trim_start_matches('/').split('/').collect();
    if parts.len() == 3 && parts[0] == "session" && uuid::Uuid::parse_str(parts[1]).is_ok() {
        return (method == "GET" && ["message", "state", "review"].contains(&parts[2])) ||
            (method == "POST" && ["prompt_async", "abort", "resolve_review"].contains(&parts[2]));
    }
    method == "GET" && parts.len() == 3 && parts[0] == "wiki" && parts[1] == "source" && parts[2].len() == 64 && parts[2].bytes().all(|b| b.is_ascii_hexdigit())
}
#[tauri::command]
async fn backend_request(state: State<'_, Desktop>, method: String, path: String, body: Option<Value>) -> Result<Value, String> {
    if !allowed_request(&method, &path) { return Err("不支持的桌面接口请求".into()); }
    let slot = state.backend.lock().await;
    let backend = slot.as_ref().ok_or("后端未启动")?;
    if state.exiting.load(Ordering::SeqCst) { return Err("应用正在退出或安装更新".into()); }
    let mut request = state.client.request(if method == "GET" { reqwest::Method::GET } else { reqwest::Method::POST }, format!("{}{}", backend.url, path)).bearer_auth(&backend.token);
    if let Some(body) = body { if body.to_string().len() > 65536 { return Err("请求内容过长".into()); } request = request.json(&body); }
    let response = request.send().await.map_err(|_| "与本地后端连接中断；请刷新状态，不要重复提交任务")?;
    if response.status().as_u16() == 204 { return Ok(Value::Null); }
    let status = response.status();
    let value: Value = response.json().await.map_err(|_| "本地后端返回了无法解析的响应")?;
    if !status.is_success() { return Err(value["message"].as_str().unwrap_or("请求失败").to_string()); }
    Ok(value)
}
#[tauri::command]
fn settings_read(state: State<'_, Desktop>) -> Result<Value, String> {
    let document = configuration::read(&state.config_path)?;
    let environment_key = std::env::var("AUTO_AGENT_API_KEY").ok().is_some_and(|v| !v.trim().is_empty());
    Ok(json!({ "settings": configuration::settings(&state.config_path, &document.raw)?, "configRevision": document.revision,
        "configPath": state.config_path, "apiKeySource": if environment_key { "environment" } else { "keyring" },
        "hasApiKey": environment_key || read_key(&state.root)?.is_some(), "pendingApply": state.pending_apply.load(Ordering::SeqCst),
        "dataDirectory": configuration::data_directory(&state.config_path, &document.raw)?, "version": env!("CARGO_PKG_VERSION") }))
}
async fn has_active_work(state: &Desktop, backend: &Backend) -> Result<bool, String> {
    let response = state.client.get(format!("{}/runtime", backend.url)).bearer_auth(&backend.token).send().await.map_err(|_| "无法确认任务状态；设置已保存，将在恢复连接后应用")?;
    if !response.status().is_success() { return Err("无法确认后端任务状态".into()); }
    let value: Value = response.json().await.map_err(|_| "后端状态响应无效")?;
    let sessions = value["runningSessions"].as_array().ok_or("后端运行状态缺失")?;
    let updating = value["updatingWiki"].as_bool().ok_or("后端更新状态缺失")?;
    Ok(!sessions.is_empty() || updating)
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
    let path = configuration::data_directory(&state.config_path, &document.raw)?.join("logs"); std::fs::create_dir_all(&path).map_err(|_| "无法创建日志目录")?;
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
async fn exit_app(app: tauri::AppHandle, state: State<'_, Desktop>) -> Result<(), String> {
    if state.exiting.swap(true, Ordering::SeqCst) { return Ok(()); }
    let mut slot = state.backend.lock().await;
    if let Err(error) = stop(&state, &mut slot).await {
        state.exiting.store(false, Ordering::SeqCst);
        return Err(error);
    }
    app.exit(0);
    Ok(())
}
fn request_exit(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = exit_app(app.clone(), app.state::<Desktop>()).await {
            app.dialog().message(error).title("暂时无法退出").show(|_| {});
        }
    });
}
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
            let root = if let Some(index) = args.iter().position(|arg| arg == "--data-dir") {
                let path = PathBuf::from(args.get(index + 1).ok_or("--data-dir requires an absolute path")?);
                if !path.is_absolute() { return Err("--data-dir requires an absolute path".into()); }
                path
            } else { app.path().app_data_dir()? };
            std::fs::create_dir_all(&root)?;
            let config_path = if let Some(index) = args.iter().position(|arg| arg == "--config") {
                std::path::absolute(args.get(index + 1).ok_or("--config requires a path")?)?
            } else if args.iter().any(|arg| arg == "--data-dir") {
                root.join("config.json")
            } else { app.path().home_dir()?.join(".auto-agent/config.json") };
            if !args.iter().any(|arg| arg == "--config") { configuration::ensure(&config_path)?; }
            configuration::read(&config_path)?;
            let client = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(30)).build()?;
            app.manage(Desktop { root, config_path, backend: Mutex::new(None), client, pending_apply: AtomicBool::new(false), exiting: AtomicBool::new(false) });
            tauri::async_runtime::spawn(apply_when_idle(app.handle().clone()));
            tauri::WebviewWindowBuilder::new(app, "launcher", tauri::WebviewUrl::App("index.html?launcher".into()))
                .title("AI 助理").inner_size(88.0, 120.0).decorations(false).transparent(true).always_on_top(true).skip_taskbar(true).resizable(false).visible(false).build()?;
            Ok(())
        })
        .on_window_event(|window, event| { if window.label() == "main" { match event {
            tauri::WindowEvent::CloseRequested { api, .. } => { api.prevent_close(); request_exit(window.app_handle().clone()); },
            tauri::WindowEvent::Resized(_) => { let _ = window.emit("main-window-state", ()); },
            _ => {}
        } } })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "launcher-open" => show_main(app.clone()),
            "launcher-exit" => request_exit(app.clone()),
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![updates::update_check, updates::update_install, support::export_diagnostics, backend_start, backend_request, settings_read, settings_save, open_logs, open_link, show_main, hide_main, window_action, drag_launcher, launcher_compact, launcher_menu, exit_app])
        .run(tauri::generate_context!()).expect("Unable to start desktop application");
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn request_scope_is_fixed() {
        assert!(allowed_request("GET", "/runtime"));
        assert!(allowed_request("POST", "/session/12345678-1234-4234-8234-123456789abc/prompt_async"));
        for path in ["//example.com", "/desktop/shutdown", "/session/../../event", "/event", "https://example.com"] { assert!(!allowed_request("GET", path)); }
    }
    #[test] fn settings_validate_paths_and_protocols() {
        assert!(Settings::default().validate().is_ok());
        let mut settings = Settings::default(); settings.base_url = "https://user:password@example.com".into(); assert!(settings.validate().is_err());
        settings = Settings::default(); settings.max_steps = 101; assert!(settings.validate().is_err());
    }
    #[test] fn updater_plugin_configuration_deserializes_without_a_deployment_key() {
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let _: tauri_plugin_updater::Config = serde_json::from_value(config["plugins"]["updater"].clone()).unwrap();
    }
}
