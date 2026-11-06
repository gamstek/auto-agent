use super::*;
use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::sync::{Arc, Mutex as SyncMutex};

const PROTOCOL_VERSION: u64 = 4;

pub struct CoraxRuntime {
    child: Child,
    connection: Arc<Connection>,
    watches: HashMap<String, tauri::async_runtime::JoinHandle<()>>,
    tree: ProcessTree,
    monitor: Option<tauri::async_runtime::JoinHandle<()>>,
    _ownership: Ownership,
}
pub struct Connection {
    url: String,
    token: String,
    secrets: Vec<String>,
    generation: String,
    pending: SyncMutex<HashMap<String, usize>>,
    dispatch: Mutex<()>,
    in_flight: std::sync::atomic::AtomicUsize,
}
impl std::ops::Deref for CoraxRuntime {
    type Target = Connection;
    fn deref(&self) -> &Connection { &self.connection }
}
struct DispatchGuard(Arc<Connection>);
impl DispatchGuard {
    fn reserve(connection: &Arc<Connection>) -> Self {
        connection.in_flight.fetch_add(1, Ordering::SeqCst);
        Self(Arc::clone(connection))
    }
}
impl Drop for DispatchGuard {
    fn drop(&mut self) { self.0.in_flight.fetch_sub(1, Ordering::SeqCst); }
}

struct Ownership { path: PathBuf, contents: String }
impl Ownership {
    fn acquire(directory: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(directory).map_err(|_| "无法创建 Corax 数据目录")?;
        let path = directory.join(".auto-agent-host.lock");
        let contents = json!({"pid":std::process::id(),"token":uuid::Uuid::new_v4().to_string()}).to_string();
        for _ in 0..3 {
            match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut file) => {
                    let owned = Self { path, contents };
                    file.write_all(owned.contents.as_bytes()).map_err(|_| "无法写入运行目录占用锁")?;
                    return Ok(owned);
                },
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    let recovery = PathBuf::from(format!("{}.recovery", path.display()));
                    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&recovery).map_err(|_| "已有进程正在恢复运行目录占用锁")?;
                    let _recovery = Self { path: recovery, contents: contents.clone() };
                    file.write_all(contents.as_bytes()).map_err(|_| "无法恢复运行目录占用锁")?;
                    let meta = std::fs::symlink_metadata(&path).map_err(|_| "无法检查运行目录占用锁")?;
                    if !meta.is_file() || meta.file_type().is_symlink() { return Err("运行目录占用锁不是普通文件".into()); }
                    let previous = std::fs::read_to_string(&path).map_err(|_| "无法读取运行目录占用锁")?;
                    let owner: Value = serde_json::from_str(&previous).map_err(|_| "运行目录占用锁无效")?;
                    let pid = owner["pid"].as_u64().filter(|pid| *pid > 0 && *pid <= u32::MAX as u64).ok_or("运行目录占用锁无效")? as u32;
                    if process_alive(pid)? { return Err("已有后端正在使用同一 Corax 数据目录".into()); }
                    if std::fs::read_to_string(&path).ok().as_deref() == Some(&previous) { std::fs::remove_file(&path).map_err(|_| "无法释放已退出进程的占用锁")?; }
                },
                Err(_) => return Err("无法取得运行目录占用锁".into()),
            }
        }
        Err("无法取得运行目录占用锁".into())
    }
}
impl Drop for Ownership {
    fn drop(&mut self) {
        if std::fs::read_to_string(&self.path).ok().as_deref() == Some(&self.contents) { let _ = std::fs::remove_file(&self.path); }
    }
}

#[cfg(windows)]
fn process_alive(pid: u32) -> Result<bool, String> {
    use windows_sys::Win32::{Foundation::CloseHandle, System::Threading::{OpenProcess, GetExitCodeProcess, PROCESS_QUERY_LIMITED_INFORMATION}};
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() { return Ok(std::io::Error::last_os_error().raw_os_error() != Some(87)); }
        let mut code = 0;
        let success = GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        if success == 0 { return Err("无法确认运行目录所属进程状态".into()); }
        Ok(code == 259)
    }
}
#[cfg(not(windows))]
fn process_alive(pid: u32) -> Result<bool, String> {
    Ok(unsafe { libc::kill(pid as i32, 0) } == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH))
}

#[cfg(windows)]
struct ProcessTree(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
unsafe impl Send for ProcessTree {}
#[cfg(windows)]
unsafe impl Sync for ProcessTree {}
#[cfg(windows)]
impl ProcessTree {
    fn attach(child: &Child) -> Result<Self, String> {
        use windows_sys::Win32::{Foundation::CloseHandle, System::JobObjects::*};
        unsafe {
            let process = child.raw_handle().ok_or("Corax 进程句柄无效")?;
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() { return Err("无法创建 Corax 进程组".into()); }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits as *const _ as _, std::mem::size_of_val(&limits) as u32) == 0
                || AssignProcessToJobObject(job, process as _) == 0 {
                CloseHandle(job); return Err("无法托管 Corax 子进程".into());
            }
            Ok(Self(job))
        }
    }
    fn stop(&self) { unsafe { windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0, 0); } }
}
#[cfg(windows)]
impl Drop for ProcessTree { fn drop(&mut self) { unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0); } } }
#[cfg(not(windows))]
struct ProcessTree(i32);
#[cfg(not(windows))]
impl ProcessTree {
    fn attach(child: &Child) -> Result<Self, String> { Ok(Self(child.id().ok_or("Corax 进程无效")? as i32)) }
    fn stop(&self) { unsafe { libc::kill(-self.0, libc::SIGTERM); } }
}
#[cfg(not(windows))]
impl Drop for ProcessTree { fn drop(&mut self) { unsafe { libc::kill(-self.0, libc::SIGKILL); } } }

fn cli_path(project: &Path) -> Result<PathBuf, String> {
    let package = project.join("node_modules/@coraxjs/core");
    let manifest: Value = serde_json::from_slice(&std::fs::read(package.join("package.json")).map_err(|_| "未找到 npm @coraxjs/core")?).map_err(|_| "Corax 包清单无效")?;
    let entry = manifest["exports"]["./bin"].as_str().ok_or("Corax 未导出标准 CLI")?;
    Ok(package.join(entry))
}

fn corax_command(runtime: &Path, project: &Path, config: &Path, data: &Path, token: &str, key: Option<&str>) -> Result<Command, String> {
    // Tauri/canonicalize may return \\?\C:\... paths. Node 24's main-module
    // resolver fails on that prefix (EISDIR lstat 'C:'). Simplify compatible paths
    // at the process boundary, before joining the public package export.
    let project = dunce::simplified(project);
    let mut command = Command::new(dunce::simplified(runtime));
    command.arg(cli_path(project)?).current_dir(project)
        .env("AUTO_AGENT_CONFIG", dunce::simplified(config)).env("AUTO_AGENT_PROJECT_ROOT", project)
        .env("CORAX_PROJECT_ROOT", project).env("CORAX_DATA_DIR", dunce::simplified(data)).env("AUTO_AGENT_TOKEN", token)
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    command.env_remove("AUTO_AGENT_API_KEY");
    if let Some(key) = key { command.env("AUTO_AGENT_API_KEY", key); }
    #[cfg(windows)] command.creation_flags(0x08000000);
    #[cfg(unix)] command.process_group(0);
    Ok(command)
}

pub async fn start(app: &tauri::AppHandle, state: &Desktop, slot: &mut Option<CoraxRuntime>) -> Result<(), String> {
    if state.exiting.load(Ordering::SeqCst) { return Err("应用正在退出或安装更新".into()); }
    if let Some(backend) = slot {
        if backend.child.try_wait().map_err(|_| "无法检查 Corax 进程")?.is_none() { return Ok(()); }
    }
    *slot = None;
    let document = configuration::read(&state.config_path)?;
    let data = configuration::data_directory(&state.config_path, &document.raw)?.join("corax");
    let ownership = Ownership::acquire(&data)?;
    let key = match std::env::var("AUTO_AGENT_API_KEY").ok().filter(|value| !value.trim().is_empty()) { Some(key) => Some(key), None => read_key(&state.root)? };
    let token = uuid::Uuid::new_v4().to_string();
    let project = if cfg!(debug_assertions) { Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap().to_path_buf() }
        else { app.path().resource_dir().map_err(|_| "无法定位应用资源")?.join("runtime") };
    let runtime = if cfg!(debug_assertions) { PathBuf::from("node") } else { project.join(if cfg!(windows) { "node.exe" } else { "node" }) };
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|_| "无法分配本机端口")?;
    let url = format!("http://127.0.0.1:{}", listener.local_addr().map_err(|_| "无法读取本机端口")?.port());
    let port = listener.local_addr().unwrap().port().to_string();
    drop(listener);
    let mut command = corax_command(&runtime, &project, &state.config_path, &data, &token, key.as_deref())?;
    command.arg(if cfg!(debug_assertions) { "dev" } else { "start" });
    if cfg!(debug_assertions) { command.arg("--no-ui"); }
    command.args(["--host", "127.0.0.1", "--port", &port]);
    let mut child = command.spawn().map_err(|_| "无法启动 Node/Corax，请检查运行时和应用资源")?;
    let tree = ProcessTree::attach(&child)?;
    let ready = Arc::new(AtomicBool::new(false));
    let output = Arc::new(SyncMutex::new(VecDeque::<String>::new()));
    for pipe in [child.stdout.take().map(|pipe| Box::pin(pipe) as std::pin::Pin<Box<dyn tokio::io::AsyncRead + Send>>), child.stderr.take().map(|pipe| Box::pin(pipe) as std::pin::Pin<Box<dyn tokio::io::AsyncRead + Send>>)] {
        let Some(pipe) = pipe else { continue; };
        let (ready, output, url) = (ready.clone(), output.clone(), url.clone());
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(pipe).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.contains("server listening at") && line.contains(&url) { ready.store(true, Ordering::SeqCst); }
                let mut saved = output.lock().unwrap();
                saved.push_back(line.chars().take(2000).collect());
                if saved.len() > 20 { saved.pop_front(); }
            }
        });
    }
    let secrets: Vec<String> = std::iter::once(token.clone()).chain(key).collect();
    let connection = Arc::new(Connection { url, token, secrets, generation: uuid::Uuid::new_v4().to_string(), pending: SyncMutex::new(HashMap::new()), dispatch: Mutex::new(()), in_flight: std::sync::atomic::AtomicUsize::new(0) });
    let mut backend = CoraxRuntime { child, connection, watches: HashMap::new(), tree, monitor: None, _ownership: ownership };
    let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
    loop {
        if backend.child.try_wait().map_err(|_| "无法检查 Corax 进程")?.is_some() {
            let detail = output.lock().unwrap().iter().cloned().collect::<Vec<_>>().join("\n");
            return Err(redact_text(&format!("Corax 启动时退出：{detail}"), &backend.secrets));
        }
        if ready.load(Ordering::SeqCst) && request(state, &backend, "GET", "/corax/v1/health", None).await.is_ok() { break; }
        if tokio::time::Instant::now() > deadline { return Err("Corax 启动超时".into()); }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let (handle, generation) = (app.clone(), backend.generation.clone());
    backend.monitor = Some(tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let state = handle.state::<Desktop>();
            let Ok(mut slot) = state.backend.try_lock() else { continue; };
            let Some(backend) = slot.as_mut() else { return; };
            if backend.generation != generation { return; }
            if backend.child.try_wait().ok().flatten().is_some() { let _ = handle.emit("backend-stream", "disconnected"); return; }
        }
    }));
    *slot = Some(backend);
    let _ = app.emit("backend-stream", "connected");
    Ok(())
}

pub async fn stop(state: &Desktop, slot: &mut Option<CoraxRuntime>) -> Result<(), String> {
    if let Some(backend) = slot.as_mut() {
        if backend.child.try_wait().map_err(|_| "无法检查 Corax 进程")?.is_none() {
            if has_active_work(state, backend).await? { return Err("任务仍在执行，请完成或取消后再退出".into()); }
            backend.tree.stop();
            tokio::time::timeout(Duration::from_secs(25), backend.child.wait()).await.map_err(|_| "Corax 正在退出，请稍后重试")?.map_err(|_| "无法等待 Corax 退出")?;
        }
    }
    *slot = None;
    Ok(())
}
impl Drop for CoraxRuntime { fn drop(&mut self) { for (_, task) in self.watches.drain() { task.abort(); } if let Some(task) = self.monitor.take() { task.abort(); } } }

fn redact_text(text: &str, secrets: &[String]) -> String {
    let mut text = text.to_string();
    for secret in secrets { if !secret.is_empty() { text = text.replace(secret, "[redacted]"); } }
    text.chars().take(4000).collect()
}
fn redact(value: &mut Value, secrets: &[String]) {
    match value {
        Value::String(text) => { for secret in secrets { if !secret.is_empty() { *text = text.replace(secret, "[redacted]"); } } },
        Value::Array(values) => for value in values { redact(value, secrets); },
        Value::Object(values) => for value in values.values_mut() { redact(value, secrets); },
        _ => {},
    }
}
async fn request(state: &Desktop, backend: &Connection, method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
    let (status, value) = request_status(state, backend, method, path, body).await?;
    if !status.is_success() { return Err(redact_text(value["error"].as_str().unwrap_or("Corax 拒绝请求"), &backend.secrets)); }
    Ok(value)
}
async fn request_status(state: &Desktop, backend: &Connection, method: &str, path: &str, body: Option<Value>) -> Result<(reqwest::StatusCode, Value), String> {
    #[cfg(debug_assertions)] let started = std::time::Instant::now();
    let mut request = state.client.request(if method == "GET" { reqwest::Method::GET } else { reqwest::Method::POST }, format!("{}{path}", backend.url)).basic_auth("auto-agent", Some(&backend.token));
    if path == "/desktop/devices/climber/refresh" { request = request.timeout(Duration::from_secs(70)); }
    if let Some(body) = body { request = request.json(&body); }
    let response = request.send().await.map_err(|_| "与 Corax 连接中断，请读取状态确认结果，不要重复提交")?;
    let status = response.status();
    let mut value: Value = response.json().await.map_err(|_| "Corax 返回了无法解析的响应")?;
    #[cfg(debug_assertions)] if started.elapsed() > Duration::from_millis(250) { eprintln!("[desktop-http] method={method} elapsed_ms={} status={}", started.elapsed().as_millis(), status.as_u16()); }
    redact(&mut value, &backend.secrets);
    Ok((status, value))
}

async fn snapshot(state: &Desktop, backend: &Connection, id: &str, start_index: usize) -> Result<Vec<Value>, String> {
    for attempt in 0..25 {
        #[cfg(debug_assertions)] let started = std::time::Instant::now();
        let response = state.client.get(format!("{}/corax/v1/session/{id}/stream?startIndex={start_index}&follow=false", backend.url)).basic_auth("auto-agent", Some(&backend.token))
            .send().await.map_err(|_| "无法读取 Corax 会话状态")?;
        if response.status().is_success() {
            #[cfg(debug_assertions)] let headers_ms = started.elapsed().as_millis();
            let text = response.text().await.map_err(|_| "Corax 会话记录读取中断")?;
            #[cfg(debug_assertions)] if started.elapsed() > Duration::from_millis(250) { eprintln!("[desktop-history] headers_ms={headers_ms} total_ms={} bytes={}", started.elapsed().as_millis(), text.len()); }
            return text.lines().filter(|line| !line.trim().is_empty()).map(|line| serde_json::from_str(line).map_err(|_| "Corax 事件格式无效".into())).collect();
        }
        if ![404, 409, 425, 503].contains(&response.status().as_u16()) || attempt == 24 { break; }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    Err("Corax 会话记录暂不可读".into())
}
fn admitted(backend: &Connection, id: &str, events: &[Value], start_index: usize) -> bool {
    let mut pending = backend.pending.lock().unwrap();
    let Some(baseline) = pending.get(id).copied() else { return false; };
    if events.iter().skip(baseline.saturating_sub(start_index)).any(|event| ["turn.started", "message.received", "input.resolved", "session.completed", "session.failed"].contains(&event["type"].as_str().unwrap_or(""))) { pending.remove(id); false }
    else { true }
}
async fn activities(state: &Desktop, backend: &Connection, ids: &[String]) -> Result<Vec<Value>, String> {
    let sessions: Vec<_> = {
        let pending = backend.pending.lock().unwrap();
        ids.iter().map(|id| json!({"id":id,"after":pending.get(id)})).collect()
    };
    let body = json!({"sessions":sessions});
    let mut result = None;
    for attempt in 0..25 {
        let (status, value) = request_status(state, backend, "POST", "/desktop/activity", Some(body.clone())).await?;
        if status.is_success() { result = Some(value); break; }
        if status.as_u16() != 503 || attempt == 24 { return Err(value["error"].as_str().unwrap_or("无法确认 Corax 活动状态").into()); }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let result = result.ok_or("无法确认 Corax 活动状态")?;
    let states = result["sessions"].as_array().ok_or("Corax 活动状态响应无效")?;
    if states.len() != ids.len() { return Err("Corax 活动状态响应不完整".into()); }
    for entry in states {
        let id = entry["id"].as_str().ok_or("Corax 会话标识无效")?;
        if !ids.iter().any(|expected| expected == id) || !entry["busy"].is_boolean() || !entry["turnActive"].is_boolean() { return Err("Corax 活动状态响应无效".into()); }
        if entry["closed"] == true || entry["admissionObserved"] == true { backend.pending.lock().unwrap().remove(id); }
    }
    Ok(states.clone())
}
pub async fn has_active_work(state: &Desktop, backend: &CoraxRuntime) -> Result<bool, String> {
    connection_has_active_work(state, backend).await
}
async fn connection_has_active_work(state: &Desktop, backend: &Connection) -> Result<bool, String> {
    if backend.in_flight.load(Ordering::SeqCst) > 0 { return Ok(true); }
    for offset in (0..).step_by(100) {
        let page = request(state, backend, "GET", &format!("/corax/v1/session?limit=100&offset={offset}"), None).await?;
        let sessions = page["sessions"].as_array().ok_or("Corax 会话目录无效")?;
        let ids = sessions.iter().map(|session| session["id"].as_str().map(String::from).ok_or("Corax 会话标识无效")).collect::<Result<Vec<_>, _>>()?;
        if activities(state, backend, &ids).await?.iter().any(|state| state["busy"] == true) { return Ok(true); }
        if sessions.len() < 100 { return Ok(!backend.pending.lock().unwrap().is_empty()); }
    }
    unreachable!()
}

pub fn allowed_request(method: &str, path: &str) -> bool {
    if !path.starts_with('/') || path.contains("..") || path.contains(['\\', '#', '\r', '\n']) { return false; }
    let route = path.split('?').next().unwrap_or("");
    if method == "GET" && ["/global/health", "/runtime", "/capabilities"].contains(&route) { return path == route; }
    if method == "GET" && route == "/session" { return true; }
    if method == "POST" && route == "/session" { return true; }
    if method == "GET" && path == "/devices" { return true; }
    if method == "POST" && path == "/devices/climber/refresh" { return true; }
    let parts: Vec<_> = route.trim_start_matches('/').split('/').collect();
    parts.len() == 3 && parts[0] == "session" && valid_session_id(parts[1]) &&
        ((method == "GET" && parts[2] == "events" && event_cursor(path).is_ok()) || (path == route && method == "POST" && ["prompt_async", "respond", "abort", "clear", "compact", "reset"].contains(&parts[2])))
}
fn valid_session_id(id: &str) -> bool { id.strip_prefix("wrun_").is_some_and(|id| id.len() == 26 && id.bytes().all(|byte| byte.is_ascii_alphanumeric())) }

fn event_cursor(path: &str) -> Result<(usize, Option<String>), String> {
    let Some((_, query)) = path.split_once('?') else { return Ok((0, None)); };
    let mut start = None; let mut generation = None;
    for part in query.split('&') {
        let (key, value) = part.split_once('=').ok_or("事件游标无效")?;
        match key {
            "startIndex" if start.is_none() && !value.is_empty() && value.bytes().all(|c| c.is_ascii_digit()) => start = Some(value.parse::<usize>().map_err(|_| "事件游标无效")?),
            "generation" if generation.is_none() && uuid::Uuid::parse_str(value).is_ok() => generation = Some(value.to_string()),
            _ => return Err("事件游标无效".into()),
        }
    }
    Ok((start.unwrap_or(0), generation))
}

// Match the official client's only safe send retry: an explicit pre-admission rejection.
fn session_not_ready(status: reqwest::StatusCode, value: &Value) -> bool {
    status == reqwest::StatusCode::CONFLICT && value["code"] == "session_not_ready"
}
async fn send_request(state: &Desktop, backend: &Connection, path: &str, payload: Value, wait_ready: bool) -> Result<(reqwest::StatusCode, Value), String> {
    #[cfg(debug_assertions)] let started = std::time::Instant::now();
    #[cfg(debug_assertions)] let mut not_ready = 0;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let mut delay = Duration::from_millis(250);
    loop {
        let result = request_status(state, backend, "POST", path, Some(payload.clone())).await?;
        if !wait_ready || !session_not_ready(result.0, &result.1) || tokio::time::Instant::now() >= deadline {
            #[cfg(debug_assertions)] if not_ready > 0 { eprintln!("[desktop-admission] not_ready_responses={not_ready} wait_ms={} status={}", started.elapsed().as_millis(), result.0.as_u16()); }
            return Ok(result);
        }
        #[cfg(debug_assertions)] { not_ready += 1; }
        tokio::time::sleep(delay.min(deadline.saturating_duration_since(tokio::time::Instant::now()))).await;
        delay = (delay * 2).min(Duration::from_secs(2));
    }
}

fn capability_entry(entry: &Value, dynamic: bool) -> Result<Value, String> {
    let name = entry[if dynamic { "slug" } else { "name" }].as_str().ok_or("Corax 能力名称无效")?;
    let source = entry["owner"]["kind"].as_str().filter(|source| ["framework", "application", "extension"].contains(source)).ok_or("Corax 能力来源无效")?;
    Ok(json!({"name":name,"description":entry["description"].as_str().unwrap_or(""),"source":source,"builtIn":source != "extension"}))
}

fn capability_catalog(info: &Value, configured: &Value) -> Result<Value, String> {
    // Never forward the full info response: it also contains authored instructions,
    // skill bodies, schemas and filesystem bindings which this view does not need.
    let skills = info["skills"]["static"].as_array().ok_or("Corax 技能目录无效")?.iter().map(|entry| capability_entry(entry, false)).collect::<Result<Vec<_>, _>>()?;
    let dynamic_skills = info["skills"]["dynamic"].as_array().ok_or("Corax 动态技能目录无效")?.iter().map(|entry| capability_entry(entry, true)).collect::<Result<Vec<_>, _>>()?;
    let mut tools = std::collections::BTreeMap::new();
    for entry in info["tools"]["static"].as_array().ok_or("Corax 工具目录无效")? {
        let projected = capability_entry(entry, false)?;
        tools.insert(projected["name"].as_str().unwrap().to_string(), projected);
    }
    let providers = configured["providers"].as_array().ok_or("动态工具目录无效")?;
    let mut dynamic = vec![];
    for resolver in info["tools"]["dynamic"].as_array().ok_or("Corax 动态工具目录无效")? {
        let provider = providers.iter().find(|provider| provider["slug"] == resolver["slug"] && resolver["owner"]["kind"] == "application");
        if let Some(provider) = provider {
            for entry in provider["tools"].as_array().ok_or("动态工具列表无效")? {
                let mut entry = entry.clone(); entry["owner"] = resolver["owner"].clone();
                let projected = capability_entry(&entry, false)?;
                tools.entry(projected["name"].as_str().unwrap().to_string()).or_insert(projected);
            }
        } else { dynamic.push(capability_entry(resolver, true)?); }
    }
    Ok(json!({"skills":skills,"tools":tools.into_values().collect::<Vec<_>>(),"dynamicProviders":dynamic,"dynamicSkills":dynamic_skills}))
}

#[tauri::command]
pub async fn backend_request(app: tauri::AppHandle, state: State<'_, Desktop>, method: String, path: String, body: Option<Value>) -> Result<Value, Value> {
    if !allowed_request(&method, &path) { return Err("不支持的桌面接口请求".into()); }
    let read_only = method == "GET" || path == "/devices/climber/refresh";
    #[cfg(debug_assertions)] let lock_started = std::time::Instant::now();
    let (backend, _dispatch_guard) = {
        let slot = state.backend.lock().await;
        let backend = slot.as_ref().ok_or("Corax 尚未启动")?;
        if state.exiting.load(Ordering::SeqCst) { return Err("应用正在退出或安装更新".into()); }
        let connection = Arc::clone(&backend.connection);
        let guard = (!read_only).then(|| DispatchGuard::reserve(&connection));
        (connection, guard)
    };
    #[cfg(debug_assertions)] if lock_started.elapsed() > Duration::from_millis(250) { eprintln!("[desktop-rpc] lifecycle_lock_wait_ms={} read_only={read_only}", lock_started.elapsed().as_millis()); }
    if body.as_ref().is_some_and(|body| body.to_string().len() > 65536) { return Err("请求内容过长".into()); }
    if path == "/global/health" {
        request(&state, &backend, "GET", "/corax/v1/health", None).await?;
        return Ok(json!({"healthy":true,"version":env!("CARGO_PKG_VERSION"),"engine":"corax","protocolVersion":PROTOCOL_VERSION,
            "capabilities":{"devices":{"list":true},"sessions":{"create":true,"send":true,"history":true,"conversation":true,"cancel":true,"clear":true,"compact":true,"reset":true},"messages":{"text":true,"reasoning":true,"toolCalls":true},"events":{"notifications":true,"snapshot":true,"conversationUpdates":true},"interaction":{"respond":true}}}));
    }
    if path == "/runtime" { return Ok(json!({"busy":connection_has_active_work(&state, &backend).await?})); }
    if path == "/capabilities" {
        let (info, configured) = futures_util::future::try_join(request(&state, &backend, "GET", "/corax/v1/info", None), request(&state, &backend, "GET", "/desktop/tools", None)).await?;
        return capability_catalog(&info, &configured).map_err(Value::from);
    }
    if path == "/devices" || path == "/devices/climber/refresh" {
        return request(&state, &backend, &method, &format!("/desktop{path}"), if method == "POST" { Some(json!({})) } else { None }).await.map_err(Value::from);
    }
    let _serialized = if read_only { None } else { Some(backend.dispatch.lock().await) };
    if path.split('?').next() == Some("/session") {
        let value = request(&state, &backend, &method, &format!("/corax/v1{path}"), if method == "POST" { Some(json!({})) } else { None }).await?;
        if method == "GET" { return Ok(value["sessions"].clone()); }
        let id = value["sessionId"].as_str().ok_or("Corax 未返回会话标识")?;
        return Ok(json!({"id":id,"title":"新会话","updatedAt":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64}));
    }
    let route = path.split('?').next().unwrap_or("");
    let parts: Vec<_> = route.trim_start_matches('/').split('/').collect();
    let (id, action) = (parts[1], parts[2]);
    if action == "events" {
        let (cursor, generation) = event_cursor(&path)?;
        let start_index = if generation.as_deref() == Some(backend.generation.as_str()) { cursor } else { 0 };
        let mut events = snapshot(&state, &backend, id, start_index).await?;
        let revision = start_index + events.len();
        let admitted = admitted(&backend, id, &events, start_index);
        for event in &mut events { redact(event, &backend.secrets); }
        return Ok(json!({"sessionId":id,"generation":backend.generation,"startIndex":start_index,"revision":revision,"admitted":admitted,"events":events}));
    }
    let mut payload = body.unwrap_or(json!({}));
    let endpoint = match action {
        "prompt_async" | "respond" => {
            let status = activities(&state, &backend, &[id.to_string()]).await?.pop().ok_or("Corax 会话状态无效")?;
            if status["closed"] == true { return Err("会话已失效，请新建会话".into()); }
            if action == "prompt_async" && (status["turnActive"] == true || backend.pending.lock().unwrap().contains_key(id)) { return Err("会话仍在执行".into()); }
            if action == "prompt_async" {
                let content = payload["content"].as_str().filter(|text| !text.trim().is_empty()).ok_or("消息不能为空")?;
                payload = json!({"message":content});
            } else { payload = json!({"inputResponses":payload["responses"]}); }
            backend.pending.lock().unwrap().insert(id.into(), status["revision"].as_u64().ok_or("Corax 事件游标无效")? as usize);
            format!("/corax/v1/session/{id}")
        },
        "abort" => format!("/corax/v1/session/{id}/cancel"),
        _ => {
            let status = activities(&state, &backend, &[id.to_string()]).await?.pop().ok_or("Corax 会话状态无效")?;
            if status["busy"] == true || backend.pending.lock().unwrap().contains_key(id) { return Err("会话仍在执行".into()); }
            format!("/corax/v1/session/{id}/{action}")
        },
    };
    let result = match send_request(&state, &backend, &endpoint, payload, action == "prompt_async").await {
        Ok((status, value)) if status.is_success() => Ok(value),
        Ok((status, value)) => {
            let rejected = status.is_client_error();
            if rejected && ["prompt_async", "respond"].contains(&action) { backend.pending.lock().unwrap().remove(id); }
            let message = if session_not_ready(status, &value) { "会话仍在准备中，本次消息尚未受理，请稍后发送。" } else { value["error"].as_str().unwrap_or("Corax 拒绝请求") };
            Err(json!({"code":value["code"],"message":redact_text(message, &backend.secrets),"admission":if rejected { "rejected" } else { "unknown" }}))
        },
        Err(error) => Err(Value::from(error)),
    };
    let _ = app.emit("agent-event", json!({"sessionId":id,"type":"session.updated","properties":{}}));
    result
}

#[tauri::command]
pub async fn backend_watch(app: tauri::AppHandle, state: State<'_, Desktop>, session_id: String, start_index: usize, watch_id: String) -> Result<(), String> {
    if !valid_session_id(&session_id) || watch_id.len() > 128 { return Err("会话订阅标识无效".into()); }
    let mut slot = state.backend.lock().await;
    let backend = slot.as_mut().ok_or("Corax 尚未启动")?;
    if let Some(previous) = backend.watches.remove(&session_id) { previous.abort(); }
    let connection = Arc::clone(&backend.connection);
    let (url, token, secrets, generation) = (backend.url.clone(), backend.token.clone(), backend.secrets.clone(), backend.generation.clone());
    let id = session_id.clone();
    let task = tauri::async_runtime::spawn(async move {
        let client = match reqwest::Client::builder().no_proxy().connect_timeout(Duration::from_secs(5)).build() { Ok(client) => client, Err(_) => return };
        let mut cursor = start_index;
        loop {
            let response = client.get(format!("{url}/corax/v1/session/{id}/stream?startIndex={cursor}&streamControlVersion=1")).basic_auth("auto-agent", Some(&token)).send().await;
            let mut terminal = false;
            let mut renewed = false;
            let mut format_error = false;
            if let Ok(response) = response {
                if response.status().is_success() {
                    let mut stream = response.bytes_stream();
                    let mut pending = Vec::<u8>::new();
                    while let Some(Ok(bytes)) = stream.next().await {
                        pending.extend_from_slice(&bytes);
                        if pending.len() > 8 * 1024 * 1024 { format_error = true; break; }
                        let mut events = vec![];
                        let start = cursor;
                        while let Some(end) = pending.iter().position(|byte| *byte == b'\n') {
                            let line: Vec<_> = pending.drain(..=end).collect();
                            if line.iter().all(u8::is_ascii_whitespace) { continue; }
                            let Ok(mut event) = serde_json::from_slice::<Value>(&line) else { format_error = true; break; };
                            if event.get("$corax").is_some() { renewed = true; continue; }
                            if !event["type"].is_string() { format_error = true; break; }
                            terminal |= ["session.completed", "session.failed"].contains(&event["type"].as_str().unwrap_or(""));
                            redact(&mut event, &secrets);
                            events.push(event); cursor += 1;
                        }
                        if !events.is_empty() {
                            admitted(&connection, &id, &events, start);
                            let changed = events.iter().any(|event| ["turn.completed", "turn.failed", "turn.cancelled", "session.waiting", "session.completed"].contains(&event["type"].as_str().unwrap_or("")));
                            let _ = app.emit("corax-events", json!({"sessionId":id,"generation":generation,"watchId":watch_id,"startIndex":start,"events":events}));
                            if changed { let _ = app.emit("agent-event", json!({"sessionId":id,"type":"session.updated","properties":{}})); }
                        }
                        if terminal || format_error { break; }
                    }
                } else if [404, 409, 410].contains(&response.status().as_u16()) {
                    let _ = app.emit("corax-events", json!({"sessionId":id,"watchId":watch_id,"startIndex":cursor,"events":[],"closed":true,"error":"Corax 会话不可继续，历史仍可查看，请新建会话。"}));
                    return;
                }
            }
            if terminal { return; }
            if format_error {
                let _ = app.emit("corax-events", json!({"sessionId":id,"watchId":watch_id,"startIndex":cursor,"events":[],"connectionError":"Corax 事件格式无效或超出单条读取上限，请刷新会话。"}));
                return;
            }
            if renewed { continue; }
            let _ = app.emit("corax-events", json!({"sessionId":id,"watchId":watch_id,"startIndex":cursor,"events":[],"connectionError":"Corax 事件连接中断，正在恢复。"}));
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });
    backend.watches.insert(session_id, task);
    Ok(())
}

#[cfg(test)] mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test] fn node_launcher_accepts_canonical_windows_resource_paths() { tauri::async_runtime::block_on(async {
        let root = std::env::temp_dir().join(format!("auto-agent Node 量仔-{}", uuid::Uuid::new_v4()));
        let package = root.join("node_modules/@coraxjs/core");
        std::fs::create_dir_all(package.join("bin")).unwrap();
        std::fs::write(package.join("package.json"), r#"{"exports":{"./bin":"./bin/corax.js"}}"#).unwrap();
        std::fs::write(package.join("bin/corax.js"), "console.log(JSON.stringify({cwd:process.cwd(),project:process.env.CORAX_PROJECT_ROOT,config:process.env.AUTO_AGENT_CONFIG,data:process.env.CORAX_DATA_DIR,inherited:process.env.NUMBER_OF_PROCESSORS??null}))").unwrap();
        std::fs::write(root.join("config.json"), "{}").unwrap();
        std::fs::create_dir(root.join("corax")).unwrap();
        let project = std::fs::canonicalize(&root).unwrap();
        let config = std::fs::canonicalize(root.join("config.json")).unwrap();
        let data = std::fs::canonicalize(root.join("corax")).unwrap();
        let runtime = std::env::var_os("AUTO_AGENT_TEST_RUNTIME").map(|path| {
            std::fs::canonicalize(PathBuf::from(path).join(if cfg!(windows) { "node.exe" } else { "node" })).unwrap()
        }).unwrap_or_else(|| PathBuf::from("node"));
        let output = corax_command(&runtime, &project, &config, &data, "fixture", None).unwrap().output().await.unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let paths: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(Path::new(paths["cwd"].as_str().unwrap()), dunce::simplified(&project));
        assert_eq!(Path::new(paths["project"].as_str().unwrap()), dunce::simplified(&project));
        assert_eq!(Path::new(paths["config"].as_str().unwrap()), dunce::simplified(&config));
        assert_eq!(Path::new(paths["data"].as_str().unwrap()), dunce::simplified(&data));
        assert_eq!(paths["inherited"], json!(std::env::var("NUMBER_OF_PROCESSORS").ok()));
        if let Some(packaged) = std::env::var_os("AUTO_AGENT_TEST_RUNTIME") {
            // In installer verification, also run the extracted real Corax with
            // this exact launcher, canonical paths and inherited host environment.
            let project = std::fs::canonicalize(packaged).unwrap();
            std::fs::write(&config, r#"{"model":"local","baseURL":"http://127.0.0.1:1/v1"}"#).unwrap();
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port().to_string();
            drop(listener);
            let mut command = corax_command(&runtime, &project, &config, &data, "fixture", Some("local-key")).unwrap();
            command.args(["start", "--host", "127.0.0.1", "--port", &port]).stdout(Stdio::null());
            let mut child = command.spawn().unwrap();
            let tree = ProcessTree::attach(&child).unwrap();
            let mut stderr = child.stderr.take().unwrap();
            let errors = tauri::async_runtime::spawn(async move { let mut bytes = vec![]; let _ = stderr.read_to_end(&mut bytes).await; bytes });
            let client = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(1)).build().unwrap();
            let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
            let mut healthy = false;
            while tokio::time::Instant::now() < deadline {
                if child.try_wait().unwrap().is_some() { break; }
                if client.get(format!("http://127.0.0.1:{port}/corax/v1/health")).basic_auth("auto-agent", Some("fixture")).send().await.is_ok_and(|response| response.status().is_success()) { healthy = true; break; }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            let mut catalog = None;
            if healthy {
                let info: Value = client.get(format!("http://127.0.0.1:{port}/corax/v1/info")).basic_auth("auto-agent", Some("fixture")).timeout(Duration::from_secs(20)).send().await.unwrap().error_for_status().unwrap().json().await.unwrap();
                let configured: Value = client.get(format!("http://127.0.0.1:{port}/desktop/tools")).basic_auth("auto-agent", Some("fixture")).send().await.unwrap().error_for_status().unwrap().json().await.unwrap();
                catalog = Some(capability_catalog(&info, &configured).unwrap());
            }
            tree.stop();
            child.wait().await.unwrap();
            let errors = errors.await.unwrap();
            std::fs::remove_dir_all(&root).unwrap();
            assert!(healthy, "{}", String::from_utf8_lossy(&errors));
            let catalog = catalog.unwrap();
            assert!(catalog["skills"].as_array().unwrap().iter().any(|skill| skill["name"] == "device-automation"));
            let tools = catalog["tools"].as_array().unwrap();
            assert!(tools.iter().any(|tool| tool["name"] == "sam_file"));
            assert!(tools.iter().any(|tool| tool["name"] == "wiki"));
            assert!(!tools.iter().any(|tool| tool["name"] == "climber_start_batch"));
        } else {
            std::fs::remove_dir_all(&root).unwrap();
        }
    }); }

    fn connection(url: String) -> Arc<Connection> {
        Arc::new(Connection { url, token: "fixture".into(), secrets: vec![], generation: uuid::Uuid::new_v4().to_string(), pending: SyncMutex::new(HashMap::new()), dispatch: Mutex::new(()), in_flight: std::sync::atomic::AtomicUsize::new(0) })
    }
    #[test] fn capability_catalog_uses_runtime_entries_and_projects_only_display_metadata() {
        let info = json!({
            "skills":{"static":[{"name":"discovered-skill","description":"Actual skill","owner":{"kind":"application"},"markdown":"SECRET_BODY","binding":{"sourcePath":"SECRET_PATH"}}],"dynamic":[]},
            "tools":{"static":[{"name":"bash","description":"Native tool","owner":{"kind":"framework"}},{"name":"wiki","description":"Application tool","owner":{"kind":"application"}}],
                "dynamic":[{"slug":"climber","owner":{"kind":"application"}},{"slug":"external","owner":{"kind":"extension"}}]},
            "instructions":"SECRET_PROMPT"
        });
        let configured = json!({"providers":[{"slug":"climber","tools":[{"name":"sam_file","description":"Offline SAM"}]}]});
        let value = capability_catalog(&info, &configured).unwrap();
        assert_eq!(value["skills"][0]["name"], "discovered-skill");
        assert_eq!(value["skills"][0]["builtIn"], true);
        assert_eq!(value["tools"].as_array().unwrap().iter().map(|tool| tool["name"].as_str().unwrap()).collect::<Vec<_>>(), vec!["bash", "sam_file", "wiki"]);
        assert_eq!(value["dynamicProviders"][0]["builtIn"], false);
        assert!(!value.to_string().contains("SECRET"));
        assert!(capability_catalog(&json!({}), &configured).is_err());
        let mut without_provider = info.clone();
        without_provider["tools"]["dynamic"] = json!([]);
        assert_eq!(capability_catalog(&without_provider, &configured).unwrap()["tools"].as_array().unwrap().len(), 2);
        assert!(allowed_request("GET", "/capabilities"));
        assert!(!allowed_request("POST", "/capabilities"));
    }
    fn state() -> Desktop {
        Desktop { root: PathBuf::new(), config_path: PathBuf::new(), backend: Mutex::new(None), client: reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(2)).build().unwrap(), pending_apply: AtomicBool::new(false), exiting: AtomicBool::new(false) }
    }
    async fn server(responses: Vec<(u16, Value)>) -> (String, tauri::async_runtime::JoinHandle<usize>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tauri::async_runtime::spawn(async move {
            let mut count = 0;
            for (status, body) in responses {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = [0; 8192]; socket.read(&mut bytes).await.unwrap(); count += 1;
                let body = body.to_string();
                socket.write_all(format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            }
            count
        });
        (url, task)
    }
    #[test] fn send_waits_only_after_explicit_not_ready_rejection() { tauri::async_runtime::block_on(async {
        let (url, task) = server(vec![(409, json!({"code":"session_not_ready","error":"not ready"})), (202, json!({"deliveryId":"accepted-once"}))]).await;
        let result = send_request(&state(), &connection(url), "/session", json!({"message":"local fixture"}), true).await.unwrap();
        assert_eq!(result.0, reqwest::StatusCode::ACCEPTED);
        assert_eq!(task.await.unwrap(), 2);
    }); }
    #[test] fn ambiguous_server_failure_is_never_replayed() { tauri::async_runtime::block_on(async {
        let (url, task) = server(vec![(500, json!({"error":"response uncertain"}))]).await;
        let result = send_request(&state(), &connection(url), "/session", json!({"message":"local fixture"}), true).await.unwrap();
        assert_eq!(result.0, reqwest::StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(task.await.unwrap(), 1);
        assert!(!session_not_ready(reqwest::StatusCode::CONFLICT, &json!({"code":"session_busy"})));
    }); }
    #[test] fn delta_cursors_and_admission_guards_are_scoped() {
        let generation = uuid::Uuid::new_v4().to_string();
        assert_eq!(event_cursor(&format!("/events?startIndex=42&generation={generation}")).unwrap(), (42, Some(generation)));
        for query in ["startIndex=-1", "startIndex=1&startIndex=2", "url=https://example.com", "generation=invalid"] { assert!(event_cursor(&format!("/events?{query}")).is_err()); }
        let connection = connection("http://127.0.0.1".into());
        let guard = DispatchGuard::reserve(&connection);
        assert_eq!(connection.in_flight.load(Ordering::SeqCst), 1);
        connection.pending.lock().unwrap().insert("session".into(), 10);
        assert!(!admitted(&connection, "session", &[json!({"type":"message.received"})], 10));
        drop(guard);
        assert_eq!(connection.in_flight.load(Ordering::SeqCst), 0);
    }
}
