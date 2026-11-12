use super::*;
use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::sync::{Arc, Mutex as SyncMutex};
mod history;
use history::HistoryQuery;

const PROTOCOL_VERSION: u64 = 4;

pub struct CoraxRuntime {
    child: Child,
    connection: Arc<Connection>,
    chat: ChatViews,
    tree: Arc<ProcessTree>,
    monitor: Option<tauri::async_runtime::JoinHandle<()>>,
    _ownership: Ownership,
}
pub struct Connection {
    url: String,
    token: String,
    secrets: Vec<String>,
    generation: String,
    config_revision: String,
    pending: SyncMutex<HashMap<String, PendingAdmission>>,
    knowledge_pending: SyncMutex<Option<String>>,
    dispatch: Mutex<()>,
    in_flight: std::sync::atomic::AtomicUsize,
}
#[derive(Debug, PartialEq)]
enum PendingAdmission {
    Cursor(usize),
    Delivery { id: Option<String>, observed: VecDeque<String> },
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

// A foreground read lease owns transport only, never the durable session or writes.
struct ChatView {
    id: String,
    session_id: String,
    closed: tokio::sync::watch::Sender<bool>,
}
impl ChatView {
    async fn read<T>(&self, future: impl std::future::Future<Output = Result<T, String>>) -> Result<T, String> {
        let mut closed = self.closed.subscribe();
        if *closed.borrow() { return Err("会话视图已切换".into()); }
        let cancelled = async { let _ = closed.wait_for(|value| *value).await; };
        futures_util::pin_mut!(cancelled, future);
        match futures_util::future::select(cancelled, future).await {
            futures_util::future::Either::Left(_) => Err("会话视图已切换".into()),
            futures_util::future::Either::Right((result, _)) => result,
        }
    }
}
#[derive(Default)]
struct ChatViews {
    current: Option<Arc<ChatView>>,
    watch: Option<tauri::async_runtime::JoinHandle<()>>,
}
impl ChatViews {
    fn open(&mut self, session_id: String, id: String) {
        if self.current.as_ref().is_some_and(|view| view.id == id && view.session_id == session_id) { return; }
        self.clear();
        let (closed, _) = tokio::sync::watch::channel(false);
        self.current = Some(Arc::new(ChatView { id, session_id, closed }));
    }
    fn selected(&self, id: &str, session_id: &str) -> Result<Arc<ChatView>, String> {
        self.current.as_ref().filter(|view| view.id == id && view.session_id == session_id)
            .cloned().ok_or_else(|| "会话视图已切换".into())
    }
    fn close(&mut self, id: &str) {
        if self.current.as_ref().is_some_and(|view| view.id == id) { self.clear(); }
    }
    fn clear(&mut self) {
        if let Some(view) = self.current.take() { view.closed.send_replace(true); }
        if let Some(task) = self.watch.take() { task.abort(); }
    }
}
impl Drop for ChatViews { fn drop(&mut self) { self.clear(); } }

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
pub(super) struct ProcessTree(windows_sys::Win32::Foundation::HANDLE);
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
    fn force_stop(&self) { self.stop(); }
}
#[cfg(windows)]
impl Drop for ProcessTree { fn drop(&mut self) { unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0); } } }
#[cfg(not(windows))]
pub(super) struct ProcessTree { group: i32, forced: AtomicBool }
#[cfg(not(windows))]
impl ProcessTree {
    fn attach(child: &Child) -> Result<Self, String> { Ok(Self { group: child.id().ok_or("Corax 进程无效")? as i32, forced: AtomicBool::new(false) }) }
    fn stop(&self) { unsafe { libc::kill(-self.group, libc::SIGTERM); } }
    fn force_stop(&self) { if !self.forced.swap(true, Ordering::SeqCst) { unsafe { libc::kill(-self.group, libc::SIGKILL); } } }
}
#[cfg(not(windows))]
impl Drop for ProcessTree { fn drop(&mut self) { self.force_stop(); } }

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
    #[cfg(debug_assertions)] if let Some(root) = project.parent() {
        command.arg("--env-file-if-exists").arg(root.join(".env"));
    }
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
    let project = if cfg!(debug_assertions) { Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap().join("corax") }
        else { app.path().resource_dir().map_err(|_| "无法定位应用资源")?.join("runtime") };
    let runtime = if cfg!(debug_assertions) { PathBuf::from("node") } else { project.join(if cfg!(windows) { "node.exe" } else { "node" }) };
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|_| "无法分配本机端口")?;
    let url = format!("http://127.0.0.1:{}", listener.local_addr().map_err(|_| "无法读取本机端口")?.port());
    let port = listener.local_addr().unwrap().port().to_string();
    drop(listener);
    let mut command = corax_command(&runtime, &project, &state.config_path, &data, &token, key.as_deref())?;
    command.arg(if cfg!(debug_assertions) { "dev" } else { "start" });
    if cfg!(debug_assertions) { command.args(["--no-ui", "--resume"]); }
    command.args(["--host", "127.0.0.1", "--port", &port]);
    if state.exiting.load(Ordering::SeqCst) { return Err("应用正在退出或安装更新".into()); }
    let mut child = command.spawn().map_err(|_| "无法启动 Node/Corax，请检查运行时和应用资源")?;
    let tree = Arc::new(ProcessTree::attach(&child)?);
    *state.owned_tree.lock().unwrap_or_else(|error| error.into_inner()) = Some(Arc::downgrade(&tree));
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
    let connection = Arc::new(Connection { url, token, secrets, generation: uuid::Uuid::new_v4().to_string(), config_revision: document.revision, pending: SyncMutex::new(HashMap::new()), knowledge_pending: SyncMutex::new(None), dispatch: Mutex::new(()), in_flight: std::sync::atomic::AtomicUsize::new(0) });
    let mut backend = CoraxRuntime { child, connection, chat: ChatViews::default(), tree, monitor: None, _ownership: ownership };
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

pub(super) async fn stop_for_update(state: &Desktop, slot: &mut Option<CoraxRuntime>) -> Result<(), String> {
    if let Some(backend) = slot.as_mut() {
        if backend.child.try_wait().map_err(|_| "无法检查 Corax 进程")?.is_some() {
            return Err("后台进程已退出，尚无法确认任务和写入的最终状态。".into());
        }
    }
    stop(state, slot).await
}

pub async fn stop(state: &Desktop, slot: &mut Option<CoraxRuntime>) -> Result<(), String> {
    if let Some(backend) = slot.as_mut() {
        let running = backend.child.try_wait().map_err(|_| "无法检查 Corax 进程")?.is_none();
        if !running && (backend.in_flight.load(Ordering::SeqCst) > 0 || !backend.pending.lock().unwrap().is_empty()) {
            return Err("后台进程已退出，尚无法确认任务和写入的最终状态。".into());
        }
        if running {
            if has_active_work(state, backend).await? { return Err("仍有后台任务在执行，或有写入尚待确认。".into()); }
            backend.tree.stop();
            tokio::time::timeout(Duration::from_secs(25), backend.child.wait()).await.map_err(|_| "Corax 正在退出，请稍后重试")?.map_err(|_| "无法等待 Corax 退出")?;
        }
    }
    *slot = None;
    Ok(())
}

// Rust-only operator action. Never register this as IPC or call it from the
// updater/settings path; shutdown invokes it only after native confirmation.
pub(super) async fn force_stop(slot: &mut Option<CoraxRuntime>) -> Result<(), String> {
    if let Some(backend) = slot.as_mut() {
        if backend.child.try_wait().map_err(|_| "无法检查 Corax 进程")?.is_none() {
            backend.tree.force_stop();
            match tokio::time::timeout(Duration::from_secs(5), backend.child.wait()).await {
                Ok(result) => { result.map_err(|_| "无法等待后台进程退出")?; },
                Err(_) => {
                    backend.child.start_kill().map_err(|_| "无法结束 Corax 进程")?;
                    tokio::time::timeout(Duration::from_secs(5), backend.child.wait()).await
                        .map_err(|_| "后台进程未能及时退出，请稍后重试")?
                        .map_err(|_| "无法等待后台进程退出")?;
                },
            }
        }
    }
    // No cancellation/reconciliation requests and no changes to persisted work.
    *slot = None;
    Ok(())
}

pub(super) async fn force_exit(state: &Desktop) -> Result<(), String> {
    force_exit_with_wait(state, Duration::from_secs(3)).await
}

async fn force_exit_with_wait(state: &Desktop, lock_wait: Duration) -> Result<(), String> {
    // The weak owner handle also covers startup, before the runtime reaches its
    // managed slot. Never use a global process search or an external PID here.
    let tree = state.owned_tree.lock().unwrap_or_else(|error| error.into_inner())
        .as_ref().and_then(std::sync::Weak::upgrade);
    if let Some(tree) = tree { tree.force_stop(); }
    if let Ok(mut slot) = tokio::time::timeout(lock_wait, state.backend.lock()).await {
        force_stop(&mut slot).await?;
    }
    // If another lifecycle operation is stalled, the owned tree was signalled
    // above; explicit native confirmation still permits the UI process to exit.
    Ok(())
}
impl Drop for CoraxRuntime { fn drop(&mut self) { self.chat.clear(); if let Some(task) = self.monitor.take() { task.abort(); } } }

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
fn transport_error(method: &str, path: &str, timeout: bool) -> &'static str {
    if method == "GET" || ["/desktop/activity", "/desktop/knowledge/read", "/desktop/devices/climber/refresh"].contains(&path) {
        if timeout { "读取 Corax 状态超时，尚未取得核验结果，请检查后台连接后重新读取" }
        else { "无法连接 Corax 读取状态，请检查后台连接后重新读取" }
    } else { "与 Corax 连接中断，请读取状态确认结果，不要重复提交" }
}
async fn request_status(state: &Desktop, backend: &Connection, method: &str, path: &str, body: Option<Value>) -> Result<(reqwest::StatusCode, Value), String> {
    let timing = chat_debug::Span::new(timing_operation(method, path));
    #[cfg(debug_assertions)] let started = std::time::Instant::now();
    let mut request = state.client.request(if method == "GET" { reqwest::Method::GET } else { reqwest::Method::POST }, format!("{}{path}", backend.url)).basic_auth("auto-agent", Some(&backend.token));
    if path == "/desktop/devices/climber/refresh" { request = request.timeout(Duration::from_secs(70)); }
    if let Some(body) = body { request = request.json(&body); }
    let response = request.send().await.map_err(|error| transport_error(method, path, error.is_timeout()))?;
    let status = response.status();
    timing.mark("headers", json!({"status":status.as_u16()}));
    let mut value: Value = response.json().await.map_err(|_| "Corax 返回了无法解析的响应")?;
    timing.mark("body", json!({"status":status.as_u16()}));
    #[cfg(debug_assertions)] if started.elapsed() > Duration::from_millis(250) { eprintln!("[desktop-http] method={method} elapsed_ms={} status={}", started.elapsed().as_millis(), status.as_u16()); }
    redact(&mut value, &backend.secrets);
    Ok((status, value))
}

fn admitted(backend: &Connection, id: &str, events: &[Value], start_index: usize) -> bool {
    let mut pending = backend.pending.lock().unwrap();
    let Some(entry) = pending.get_mut(id) else { return false; };
    let observed = match entry {
        PendingAdmission::Cursor(baseline) => events.iter().skip(baseline.saturating_sub(start_index)).any(|event| ["turn.started", "message.received", "input.resolved", "session.completed", "session.failed"].contains(&event["type"].as_str().unwrap_or(""))),
        PendingAdmission::Delivery { id: accepted, observed } => {
            let mut matched = false;
            for event in events {
                if ["session.completed", "session.failed"].contains(&event["type"].as_str().unwrap_or("")) { matched = true; }
                if let Some(deliveries) = event["meta"]["deliveryIds"].as_array() {
                    for delivery in deliveries.iter().filter_map(Value::as_str) {
                        if accepted.as_deref() == Some(delivery) { matched = true; }
                        if accepted.is_none() && delivery.len() <= 256 && !observed.iter().any(|previous| previous == delivery) {
                            observed.push_back(delivery.into());
                            if observed.len() > 256 { observed.pop_front(); }
                        }
                    }
                }
            }
            matched
        },
    };
    if observed { pending.remove(id); false } else { true }
}
fn accept_delivery(backend: &Connection, session: &str, delivery: &str) {
    let mut pending = backend.pending.lock().unwrap();
    if let Some(PendingAdmission::Delivery { id, observed }) = pending.get_mut(session) {
        if observed.iter().any(|previous| previous == delivery) { pending.remove(session); }
        else { *id = Some(delivery.into()); observed.clear(); }
    }
}
async fn activities(state: &Desktop, backend: &Connection, ids: &[String]) -> Result<Vec<Value>, String> {
    let sessions: Vec<_> = {
        let pending = backend.pending.lock().unwrap();
        ids.iter().map(|id| json!({"id":id,"after":match pending.get(id) { Some(PendingAdmission::Cursor(cursor)) => Some(*cursor), _ => None }})).collect()
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
    let knowledge = request(state, backend, "GET", "/desktop/knowledge/operation", None).await?;
    let uncertain = reconcile_knowledge(backend, &knowledge);
    if knowledge["operation"]["state"].as_str().is_some_and(|state| ["running", "cancelling"].contains(&state)) { return Ok(true); }
    if uncertain { return Err("知识整理请求的结果尚未确认，请先刷新知识库状态".into()); }
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
    if method == "POST" && path == "/suggestions" { return true; }
    if method == "GET" && ["/knowledge", "/knowledge/operation"].contains(&path) { return true; }
    if method == "GET" && route == "/knowledge/pages" {
        return path == route || path.strip_prefix("/knowledge/pages?offset=").is_some_and(|query| {
            let (offset, generation) = query.split_once("&generation=").map_or((query, None), |(offset, generation)| (offset, Some(generation)));
            !offset.is_empty() && offset.bytes().all(|byte| byte.is_ascii_digit()) && generation.is_none_or(|generation| uuid::Uuid::parse_str(generation).is_ok())
        });
    }
    if method == "POST" && ["/knowledge/ingest", "/knowledge/cancel", "/knowledge/read"].contains(&path) { return true; }
    let parts: Vec<_> = route.trim_start_matches('/').split('/').collect();
    parts.len() == 3 && parts[0] == "session" && valid_session_id(parts[1]) &&
        ((method == "GET" && parts[2] == "events" && HistoryQuery::parse(path).is_ok()) || (path == route && method == "POST" && ["prompt_async", "respond", "abort", "clear", "compact", "reset"].contains(&parts[2])))
}
fn valid_session_id(id: &str) -> bool { id.strip_prefix("wrun_").is_some_and(|id| id.len() == 26 && id.bytes().all(|byte| byte.is_ascii_alphanumeric())) }

// Match the official client's only safe send retry: an explicit pre-admission rejection.
fn session_not_ready(status: reqwest::StatusCode, value: &Value) -> bool {
    status == reqwest::StatusCode::CONFLICT && value["code"] == "session_not_ready"
}
async fn send_request(state: &Desktop, backend: &Connection, path: &str, payload: Value, wait_ready: bool) -> Result<(reqwest::StatusCode, Value), String> {
    let timing = chat_debug::Span::new("admission");
    #[cfg(debug_assertions)] let started = std::time::Instant::now();
    #[cfg(debug_assertions)] let mut not_ready = 0;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let mut delay = Duration::from_millis(250);
    loop {
        let result = request_status(state, backend, "POST", path, Some(payload.clone())).await?;
        timing.mark("response", json!({"status":result.0.as_u16(),"notReady":session_not_ready(result.0, &result.1)}));
        if !wait_ready || !session_not_ready(result.0, &result.1) || tokio::time::Instant::now() >= deadline {
            #[cfg(debug_assertions)] if not_ready > 0 { eprintln!("[desktop-admission] not_ready_responses={not_ready} wait_ms={} status={}", started.elapsed().as_millis(), result.0.as_u16()); }
            return Ok(result);
        }
        #[cfg(debug_assertions)] { not_ready += 1; }
        tokio::time::sleep(delay.min(deadline.saturating_duration_since(tokio::time::Instant::now()))).await;
        delay = (delay * 2).min(Duration::from_secs(2));
    }
}

// Like the official client, send directly to native admission. A full history
// preflight (including a stream-tail query) grows with the conversation length.
async fn submit_prompt(state: &Desktop, backend: &Connection, id: &str, content: &str) -> Result<Value, Value> {
    if content.trim().is_empty() { return Err("消息不能为空".into()); }
    {
        let mut pending = backend.pending.lock().unwrap();
        if pending.contains_key(id) { return Err("尚有消息受理结果待确认，请先读取会话状态".into()); }
        pending.insert(id.into(), PendingAdmission::Delivery { id: None, observed: VecDeque::new() });
    }
    match send_request(state, backend, &format!("/corax/v1/session/{id}"), json!({"message":content}), true).await {
        Ok((status, value)) if status.is_success() => {
            let Some(delivery) = value["deliveryId"].as_str().filter(|delivery| !delivery.is_empty() && delivery.len() <= 256) else {
                return Err(json!({"message":"Corax 未返回可核对的受理身份，请先读取会话确认结果。","admission":"unknown"}));
            };
            if value["sessionId"].as_str() != Some(id) {
                return Err(json!({"message":"Corax 返回的会话身份不一致，请先读取会话确认结果。","admission":"unknown"}));
            }
            accept_delivery(backend, id, delivery);
            Ok(value)
        },
        Ok((status, value)) => {
            let rejected = status.is_client_error();
            if rejected { backend.pending.lock().unwrap().remove(id); }
            let message = if session_not_ready(status, &value) { "会话仍在准备中，本次消息尚未受理，请稍后发送。" } else { value["error"].as_str().unwrap_or("Corax 拒绝请求") };
            Err(json!({"code":value["code"],"message":redact_text(message, &backend.secrets),"admission":if rejected { "rejected" } else { "unknown" }}))
        },
        Err(error) => Err(Value::from(error)),
    }
}

// Compilation has no conversation or task database. Its only pending host
// admission is reconciled against the same operation identity, never replayed.
fn reconcile_knowledge(backend: &Connection, value: &Value) -> bool {
    let mut pending = backend.knowledge_pending.lock().unwrap();
    if let Some(id) = pending.as_deref() {
        if value["operation"]["id"].as_str() != Some(id) { return true; }
        match value["operation"]["state"].as_str() {
            Some("completed" | "failed" | "cancelled") => { *pending = None; },
            Some("running" | "cancelling") => {},
            _ => return true,
        }
    }
    false
}

async fn knowledge_request(state: &Desktop, backend: &Connection, method: &str, path: &str, body: Option<Value>) -> Result<Value, Value> {
    let mut payload = body.unwrap_or(json!({}));
    let start = path == "/knowledge/ingest";
    let cancel = path == "/knowledge/cancel";
    let mut operation_id = None;
    if start || cancel {
        if payload["generation"].as_str() != Some(backend.generation.as_str()) {
            return Err(json!({"message":"后端连接已经变化，请刷新知识库后操作","admission":"rejected"}));
        }
        if start {
            if payload.as_object().is_none_or(|object| object.keys().any(|key| !["generation", "configRevision", "sourceId"].contains(&key.as_str()))) || payload.get("sourceId").is_some_and(|source| !source.is_null() && !source.is_string()) {
                return Err(json!({"message":"知识整理参数无效","admission":"rejected"}));
            }
            if state.pending_apply.load(Ordering::SeqCst) || payload["configRevision"].as_str() != Some(backend.config_revision.as_str()) || configuration::read(&state.config_path)?.revision != backend.config_revision {
                return Err(json!({"message":"资料配置尚未保存或生效，请等待设置应用","admission":"rejected"}));
            }
            let has_pending = backend.knowledge_pending.lock().unwrap().is_some();
            if has_pending {
                let current = request(state, backend, "GET", "/desktop/knowledge/operation", None).await?;
                if reconcile_knowledge(backend, &current) || backend.knowledge_pending.lock().unwrap().is_some() {
                    return Err(json!({"message":"已有整理请求尚未结束或结果待确认，请刷新状态","admission":"rejected"}));
                }
            }
            let id = uuid::Uuid::new_v4().to_string();
            *backend.knowledge_pending.lock().unwrap() = Some(id.clone());
            payload = if let Some(source) = payload["sourceId"].as_str() { json!({"operationId":id,"configRevision":backend.config_revision,"sourceId":source}) } else { json!({"operationId":id,"configRevision":backend.config_revision}) };
            operation_id = Some(id);
        } else {
            payload = json!({"operationId":payload["operationId"]});
        }
    }
    let (status, mut value) = request_status(state, backend, method, &format!("/desktop{path}"), if method == "POST" { Some(payload) } else { None }).await?;
    if !status.is_success() {
        if start && status.is_client_error() { *backend.knowledge_pending.lock().unwrap() = None; }
        return Err(json!({"message":value["error"].as_str().unwrap_or("知识库请求失败"),"admission":if status.is_client_error() {"rejected"} else {"unknown"}}));
    }
    if operation_id.as_deref().is_some_and(|id| value["operation"]["id"].as_str() != Some(id)) {
        return Err(json!({"message":"整理受理身份不一致，请刷新核对结果","admission":"unknown"}));
    }
    if value.is_object() {
        value["generation"] = json!(backend.generation);
        if value.get("configRevision").is_none() { value["configRevision"] = json!(backend.config_revision); }
        if value.get("operation").is_some() { value["admissionUncertain"] = json!(reconcile_knowledge(backend, &value)); }
    }
    Ok(value)
}

// Fixed labels only: never write a URL, session ID or query string to the timing log.
fn timing_operation(method: &str, path: &str) -> &'static str {
    let route = path.split('?').next().unwrap_or("");
    match route {
        "/session" | "/corax/v1/session" => if method == "GET" { "session-list" } else { "session-create" },
        "/desktop/activity" => "activity-http",
        "/global/health" | "/corax/v1/health" => "health",
        "/runtime" => "runtime",
        "/capabilities" | "/corax/v1/info" | "/desktop/tools" => "capabilities",
        _ if route.starts_with("/session/") && route.ends_with("/events") => "history-rpc",
        _ if route.starts_with("/session/") && route.ends_with("/prompt_async") => "send-rpc",
        _ if route.starts_with("/corax/v1/session/") && route.split('/').count() == 5 => "send-http",
        _ => "other",
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
        if entry["owner"]["kind"] == "framework" { continue; }
        let projected = capability_entry(entry, false)?;
        tools.insert(projected["name"].as_str().unwrap().to_string(), projected);
    }
    let providers = configured["providers"].as_array().ok_or("动态工具目录无效")?;
    let mut dynamic = vec![];
    for resolver in info["tools"]["dynamic"].as_array().ok_or("Corax 动态工具目录无效")? {
        if resolver["owner"]["kind"] == "framework" { continue; }
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

async fn suggestions_request(state: &Desktop, backend: &Connection) -> Result<Value, String> {
    if state.pending_apply.load(Ordering::SeqCst) { return Err("模型设置正在应用，请稍后查看推荐问题".into()); }
    let page = request(state, backend, "GET", "/corax/v1/session?limit=3&offset=0", None).await?;
    let sessions = page["sessions"].as_array().ok_or("Corax 会话目录无效")?.iter().take(3).map(|session| {
        let id = session["id"].as_str().filter(|id| valid_session_id(id)).ok_or("Corax 会话标识无效")?;
        let title: String = session["title"].as_str().unwrap_or("").chars().take(100).collect();
        let updated_at = session["updatedAt"].as_u64().ok_or("Corax 会话时间无效")?;
        Ok(json!({"id":id,"title":title,"updatedAt":updated_at}))
    }).collect::<Result<Vec<_>, String>>()?;
    request(state, backend, "POST", "/desktop/suggestions", Some(json!({"sessions":sessions}))).await
}

#[tauri::command]
pub async fn backend_request(app: tauri::AppHandle, state: State<'_, Desktop>, method: String, path: String, body: Option<Value>, view_id: Option<String>) -> Result<Value, Value> {
    if !allowed_request(&method, &path) { return Err("不支持的桌面接口请求".into()); }
    if view_id.is_some() && (method != "GET" || !path.split('?').next().unwrap_or("").ends_with("/events")) { return Err("视图标识仅用于会话读取".into()); }
    let timing = chat_debug::Span::new(timing_operation(&method, &path));
    let read_only = method == "GET" || path == "/devices/climber/refresh" || path == "/knowledge/read";
    #[cfg(debug_assertions)] let lock_started = std::time::Instant::now();
    let (backend, _dispatch_guard, view) = {
        let slot = state.backend.lock().await;
        let backend = slot.as_ref().ok_or("Corax 尚未启动")?;
        if state.exiting.load(Ordering::SeqCst) && !read_only { return Err("应用正在退出或安装更新".into()); }
        let connection = Arc::clone(&backend.connection);
        let view = view_id.as_ref().map(|view_id| backend.chat.selected(view_id, path.split('/').nth(2).unwrap_or(""))).transpose()?;
        let guard = (!read_only).then(|| DispatchGuard::reserve(&connection));
        (connection, guard, view)
    };
    timing.mark("lifecycle-lock", json!({}));
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
    // Advisory model generation reserves in-flight work, but must never hold
    // the chat dispatch lock or delay ordinary message admission.
    if path == "/suggestions" { return suggestions_request(&state, &backend).await.map_err(Value::from); }
    let _serialized = if read_only { None } else { Some(backend.dispatch.lock().await) };
    timing.mark("dispatch-lock", json!({"readOnly":read_only}));
    if path.starts_with("/knowledge") { return knowledge_request(&state, &backend, &method, &path, body).await; }
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
        let reading = history::read(&state.client, &backend, id, HistoryQuery::parse(&path)?);
        let mut page = if let Some(view) = view {
            let result = view.read(reading).await;
            if *view.closed.borrow() { timing.mark("cancelled", json!({})); }
            result?
        } else { reading.await? };
        timing.mark("history", json!({"count":page.events.len(),"cursor":page.start}));
        let admitted = page.authoritative() && admitted(&backend, id, &page.events, page.start);
        for event in &mut page.events { redact(event, &backend.secrets); }
        timing.mark("redacted", json!({"count":page.events.len()}));
        return Ok(page.into_response(id, &backend.generation, admitted));
    }
    let mut payload = body.unwrap_or(json!({}));
    if action == "prompt_async" {
        let content = payload["content"].as_str().ok_or("消息不能为空")?;
        let result = submit_prompt(&state, &backend, id, content).await;
        timing.mark("response", json!({"success":result.is_ok()}));
        let _ = app.emit("agent-event", json!({"sessionId":id,"type":"session.updated","properties":{}}));
        return result;
    }
    let endpoint = match action {
        "respond" => {
            timing.mark("preflight-begin", json!({}));
            let status = activities(&state, &backend, &[id.to_string()]).await?.pop().ok_or("Corax 会话状态无效")?;
            timing.mark("preflight-end", json!({}));
            if status["closed"] == true { return Err("会话已失效，请新建会话".into()); }
            if backend.pending.lock().unwrap().contains_key(id) { return Err("尚有消息受理结果待确认，请先读取会话状态".into()); }
            payload = json!({"inputResponses":payload["responses"]});
            backend.pending.lock().unwrap().insert(id.into(), PendingAdmission::Cursor(status["revision"].as_u64().ok_or("Corax 事件游标无效")? as usize));
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
    timing.mark("response", json!({"success":result.is_ok()}));
    let _ = app.emit("agent-event", json!({"sessionId":id,"type":"session.updated","properties":{}}));
    result
}

#[tauri::command]
pub async fn backend_chat_open(state: State<'_, Desktop>, session_id: String, view_id: String) -> Result<(), String> {
    if !valid_session_id(&session_id) || uuid::Uuid::parse_str(&view_id).is_err() { return Err("会话视图标识无效".into()); }
    let _timing = chat_debug::Span::new("view-open");
    let mut slot = state.backend.lock().await;
    let backend = slot.as_mut().ok_or("Corax 尚未启动")?;
    backend.chat.open(session_id, view_id);
    Ok(())
}

#[tauri::command]
pub async fn backend_chat_close(state: State<'_, Desktop>, view_id: String) -> Result<(), String> {
    if uuid::Uuid::parse_str(&view_id).is_err() { return Err("会话视图标识无效".into()); }
    let _timing = chat_debug::Span::new("view-close");
    let mut slot = state.backend.lock().await;
    if let Some(backend) = slot.as_mut() { backend.chat.close(&view_id); }
    Ok(())
}

#[tauri::command]
pub async fn backend_watch(app: tauri::AppHandle, state: State<'_, Desktop>, session_id: String, start_index: usize, watch_id: String, view_id: Option<String>) -> Result<(), String> {
    if !valid_session_id(&session_id) || watch_id.len() > 128 { return Err("会话订阅标识无效".into()); }
    let timing = chat_debug::Span::new("watch-rpc");
    let mut slot = state.backend.lock().await;
    timing.mark("lifecycle-lock", json!({}));
    let backend = slot.as_mut().ok_or("Corax 尚未启动")?;
    if let Some(view_id) = view_id { backend.chat.selected(&view_id, &session_id)?; }
    if let Some(previous) = backend.chat.watch.take() { previous.abort(); }
    let connection = Arc::clone(&backend.connection);
    let (url, token, secrets, generation) = (backend.url.clone(), backend.token.clone(), backend.secrets.clone(), backend.generation.clone());
    let id = session_id.clone();
    let task = tauri::async_runtime::spawn(async move {
        let timing = chat_debug::Span::new("watch-stream");
        let client = match reqwest::Client::builder().no_proxy().connect_timeout(Duration::from_secs(5)).build() { Ok(client) => client, Err(_) => return };
        let mut cursor = start_index;
        let mut received = false;
        loop {
            let response = client.get(format!("{url}/corax/v1/session/{id}/stream?startIndex={cursor}&streamControlVersion=1")).basic_auth("auto-agent", Some(&token)).send().await;
            let mut terminal = false;
            let mut renewed = false;
            let mut format_error = false;
            if let Ok(response) = response {
                if !received { timing.mark("headers", json!({"status":response.status().as_u16()})); }
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
                            if !received {
                                received = true;
                                timing.mark("first-event", json!({"count":events.len(),"cursor":start}));
                            }
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
    backend.chat.watch = Some(task);
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
            std::fs::write(&config, r#"{"model":"local","baseURL":"http://127.0.0.1:1/v1","climber":{"enabled":false}}"#).unwrap();
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
        Arc::new(Connection { url, token: "fixture".into(), secrets: vec![], generation: uuid::Uuid::new_v4().to_string(), config_revision: "fixture".into(), pending: SyncMutex::new(HashMap::new()), knowledge_pending: SyncMutex::new(None), dispatch: Mutex::new(()), in_flight: std::sync::atomic::AtomicUsize::new(0) })
    }
    #[test] fn capability_catalog_uses_runtime_entries_and_projects_only_display_metadata() {
        let info = json!({
            "skills":{"static":[{"name":"discovered-skill","description":"Actual skill","owner":{"kind":"application"},"markdown":"SECRET_BODY","binding":{"sourcePath":"SECRET_PATH"}}],"dynamic":[]},
            "tools":{"static":[{"name":"bash","description":"Native tool","owner":{"kind":"framework"}},{"name":"wiki","description":"Application tool","owner":{"kind":"application"}}],
                "dynamic":[{"slug":"climber","owner":{"kind":"application"}},{"slug":"external","owner":{"kind":"extension"}},{"slug":"native-provider","owner":{"kind":"framework"}}]},
            "instructions":"SECRET_PROMPT"
        });
        let configured = json!({"providers":[{"slug":"climber","tools":[{"name":"sam_file","description":"Offline SAM"}]}]});
        let value = capability_catalog(&info, &configured).unwrap();
        assert_eq!(value["skills"][0]["name"], "discovered-skill");
        assert_eq!(value["skills"][0]["builtIn"], true);
        assert_eq!(value["tools"].as_array().unwrap().iter().map(|tool| tool["name"].as_str().unwrap()).collect::<Vec<_>>(), vec!["sam_file", "wiki"]);
        assert_eq!(value["dynamicProviders"][0]["builtIn"], false);
        assert_eq!(value["dynamicProviders"].as_array().unwrap().len(), 1);
        assert!(!value.to_string().contains("SECRET"));
        assert!(capability_catalog(&json!({}), &configured).is_err());
        let mut without_provider = info.clone();
        without_provider["tools"]["dynamic"] = json!([]);
        assert_eq!(capability_catalog(&without_provider, &configured).unwrap()["tools"].as_array().unwrap().len(), 1);
        assert!(allowed_request("GET", "/capabilities"));
        assert!(!allowed_request("POST", "/capabilities"));
    }
    fn state() -> Desktop {
        Desktop { root: PathBuf::new(), config_path: PathBuf::new(), backend: Mutex::new(None), owned_tree: SyncMutex::new(None), client: reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(2)).build().unwrap(), pending_apply: AtomicBool::new(false), exiting: AtomicBool::new(false) }
    }
    #[test] fn read_transport_failures_are_not_reported_as_ambiguous_writes() {
        for (method, path) in [("GET", "/corax/v1/session?limit=100"), ("POST", "/desktop/activity"), ("POST", "/desktop/knowledge/read"), ("POST", "/desktop/devices/climber/refresh")] {
            assert!(transport_error(method, path, true).contains("超时"));
            assert!(!transport_error(method, path, false).contains("不要重复提交"));
        }
        for path in ["/corax/v1/session", "/corax/v1/session/fixture", "/desktop/knowledge/ingest"] {
            assert!(transport_error("POST", path, true).contains("不要重复提交"));
            assert!(transport_error("POST", path, false).contains("不要重复提交"));
        }
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
        assert_eq!(HistoryQuery::parse(&format!("/events?startIndex=42&generation={generation}")).unwrap(), HistoryQuery::From { start: 42, generation: Some(generation) });
        for query in ["startIndex=-1", "startIndex=1&startIndex=2", "url=https://example.com", "generation=invalid"] { assert!(HistoryQuery::parse(&format!("/events?{query}")).is_err()); }
        let connection = connection("http://127.0.0.1".into());
        let guard = DispatchGuard::reserve(&connection);
        assert_eq!(connection.in_flight.load(Ordering::SeqCst), 1);
        connection.pending.lock().unwrap().insert("session".into(), PendingAdmission::Cursor(10));
        assert!(!admitted(&connection, "session", &[json!({"type":"message.received"})], 10));
        drop(guard);
        assert_eq!(connection.in_flight.load(Ordering::SeqCst), 0);
    }
    #[test] fn tail_previews_have_a_separate_bounded_read_contract() {
        let path = "/session/wrun_01M6JWQZ0A0QH6MERWTZ96Z7TB/events";
        for count in [1, 128, 512, 2048] { assert!(allowed_request("GET", &format!("{path}?tail={count}"))); }
        for query in ["tail=0", "tail=2049", "tail=-128", "tail=128&tail=512", "tail=128&startIndex=0", "tail=128&url=private"] { assert!(!allowed_request("GET", &format!("{path}?{query}"))); }
        assert!(!allowed_request("POST", &format!("{path}?tail=128")));
    }
    #[test] fn tail_previews_preserve_global_offsets_and_never_release_pending_admission() { tauri::async_runtime::block_on(async {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = vec![0; 8192];
            let length = socket.read(&mut bytes).await.unwrap();
            assert!(String::from_utf8_lossy(&bytes[..length]).starts_with("GET /corax/v1/session/fixture/stream?startIndex=-2&follow=false&includeTailIndex=1 "));
            let body = "{\"type\":\"message.received\",\"data\":{}}\n{\"type\":\"turn.completed\",\"data\":{}}\n";
            socket.write_all(format!("HTTP/1.1 200 OK\r\nx-corax-stream-tail-index: 329\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        });
        let connection = connection(url);
        connection.pending.lock().unwrap().insert("fixture".into(), PendingAdmission::Cursor(0));
        let page = history::read(&state().client, &connection, "fixture", HistoryQuery::Tail { count: 2 }).await.unwrap();
        assert_eq!((page.start, page.revision, page.events.len()), (328, 330, 2));
        assert!(!page.authoritative());
        assert!(connection.pending.lock().unwrap().contains_key("fixture"));
        task.await.unwrap();
    }); }
    #[test] fn finite_history_streaming_uses_current_generation_and_returns_the_current_response_contract() { tauri::async_runtime::block_on(async {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            for expected in [2, 0] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = vec![0; 8192];
                let length = socket.read(&mut bytes).await.unwrap();
                assert!(String::from_utf8_lossy(&bytes[..length]).starts_with(&format!("GET /corax/v1/session/fixture/stream?startIndex={expected}&follow=false ")));
                let body = "{\"type\":\"message.completed\",\"data\":{\"message\":\"中文\"}}\r\n{\"type\":\"turn.completed\"}";
                socket.write_all(format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len()).as_bytes()).await.unwrap();
                for chunk in body.as_bytes().chunks(7) { socket.write_all(chunk).await.unwrap(); }
            }
        });
        let connection = connection(url);
        for (generation, expected_start) in [(connection.generation.clone(), 2), (uuid::Uuid::new_v4().to_string(), 0)] {
            let page = history::read(&state().client, &connection, "fixture", HistoryQuery::From { start: 2, generation: Some(generation) }).await.unwrap();
            assert!(page.authoritative());
            let value = page.into_response("fixture", &connection.generation, true);
            assert_eq!(value["startIndex"], expected_start);
            assert_eq!(value["revision"], expected_start + 2);
            assert_eq!(value["admitted"], true);
            assert_eq!(value["events"][0]["data"]["message"], "中文");
            assert_eq!(value["generation"], connection.generation);
        }
        task.await.unwrap();
    }); }
    #[test] fn truncated_tail_cannot_be_treated_as_a_complete_history_page() { tauri::async_runtime::block_on(async {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = vec![0; 8192];
            socket.read(&mut bytes).await.unwrap();
            let body = "{\"type\":\"session.started\"}\n";
            socket.write_all(format!("HTTP/1.1 200 OK\r\nx-corax-stream-tail-index: 9\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        });
        let result = history::read(&state().client, &connection(url), "fixture", HistoryQuery::Tail { count: 128 }).await;
        assert!(result.unwrap_err().contains("游标不一致"));
        task.await.unwrap();
    }); }
    #[test] fn oversized_tail_reads_fail_instead_of_returning_truncated_preview_events() { tauri::async_runtime::block_on(async {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = vec![0; 8192];
            let _ = socket.read(&mut bytes).await.unwrap();
            let body = "x".repeat(2 * 1024 * 1024 + 1);
            let _ = socket.write_all(format!("HTTP/1.1 200 OK\r\nx-corax-stream-tail-index: 99\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).as_bytes()).await;
        });
        assert!(history::read(&state().client, &connection(url), "fixture", HistoryQuery::Tail { count: 128 }).await.err().unwrap().contains("预算"));
        task.await.unwrap();
    }); }
    #[test] fn knowledge_routes_and_operation_admission_are_scoped() {
        for (method, path) in [("GET", "/knowledge"), ("GET", "/knowledge/operation"), ("GET", "/knowledge/pages?offset=20"), ("POST", "/knowledge/read"), ("POST", "/knowledge/ingest"), ("POST", "/knowledge/cancel")] {
            assert!(allowed_request(method, path));
        }
        for (method, path) in [("GET", "/knowledge/ingest"), ("POST", "/knowledge/sql"), ("GET", "/knowledge?path=private"), ("GET", "/knowledge/pages?offset=0&path=private")] {
            assert!(!allowed_request(method, path));
        }
        assert!(allowed_request("GET", "/knowledge/pages?offset=20&generation=00000000-0000-4000-8000-000000000099"));
        assert!(!allowed_request("GET", "/knowledge/pages?offset=20&generation=invalid"));
        assert!(!allowed_request("GET", "/knowledge/pages?offset=20&generation=00000000-0000-4000-8000-000000000099&path=private"));
        let connection = connection("http://127.0.0.1".into());
        *connection.knowledge_pending.lock().unwrap() = Some("expected".into());
        assert!(reconcile_knowledge(&connection, &json!({"operation":{"id":"other","state":"completed"}})));
        assert!(connection.knowledge_pending.lock().unwrap().is_some());
        assert!(!reconcile_knowledge(&connection, &json!({"operation":{"id":"expected","state":"cancelling"}})));
        assert!(connection.knowledge_pending.lock().unwrap().is_some());
        assert!(!reconcile_knowledge(&connection, &json!({"operation":{"id":"expected","state":"cancelled"}})));
        assert!(connection.knowledge_pending.lock().unwrap().is_none());
    }
    #[test] fn active_knowledge_compilation_blocks_idle_shutdown_without_a_conversation() { tauri::async_runtime::block_on(async {
        let (url, task) = server(vec![(200, json!({"operation":{"id":"compiler","state":"running"}}))]).await;
        assert!(connection_has_active_work(&state(), &connection(url)).await.unwrap());
        assert_eq!(task.await.unwrap(), 1);
    }); }
    #[test] fn suggestions_use_recent_native_sessions_and_remain_outside_chat_admission() { tauri::async_runtime::block_on(async {
        assert!(allowed_request("POST", "/suggestions"));
        for (method, path) in [("GET", "/suggestions"), ("POST", "/suggestions?url=other"), ("POST", "/suggestions/run")] { assert!(!allowed_request(method, path)); }
        let (url, task) = server(vec![
            (200, json!({"sessions":[{"id":"wrun_01M6JWQZ0A0QH6MERWTZ96Z7TB","title":"材料测试","updatedAt":100}]})),
            (200, json!({"source":"model","questions":["推荐问题"]})),
        ]).await;
        let connection = connection(url);
        let result = suggestions_request(&state(), &connection).await.unwrap();
        assert_eq!(result["source"], "model");
        assert_eq!(task.await.unwrap(), 2);
        assert!(connection.pending.lock().unwrap().is_empty());
        let state = state();
        state.pending_apply.store(true, Ordering::SeqCst);
        assert!(suggestions_request(&state, &connection).await.is_err());
    }); }
    #[test] fn uncertain_knowledge_admission_cannot_be_cleared_by_an_unrelated_completed_operation() { tauri::async_runtime::block_on(async {
        let (url, task) = server(vec![(200, json!({"operation":{"id":"other","state":"completed"}}))]).await;
        let connection = connection(url);
        *connection.knowledge_pending.lock().unwrap() = Some("expected".into());
        assert!(connection_has_active_work(&state(), &connection).await.is_err());
        assert_eq!(task.await.unwrap(), 1);
        assert!(connection.knowledge_pending.lock().unwrap().is_some());
    }); }
    #[test] fn stale_knowledge_requests_are_rejected_before_any_model_dispatch() { tauri::async_runtime::block_on(async {
        let connection = connection("http://127.0.0.1:9".into());
        let result = knowledge_request(&state(), &connection, "POST", "/knowledge/ingest", Some(json!({"generation":"stale","configRevision":"stale"}))).await.unwrap_err();
        assert_eq!(result["admission"], "rejected");
        assert!(connection.knowledge_pending.lock().unwrap().is_none());
        let state = state();
        state.pending_apply.store(true, Ordering::SeqCst);
        let result = knowledge_request(&state, &connection, "POST", "/knowledge/ingest", Some(json!({"generation":connection.generation,"configRevision":"stale"}))).await.unwrap_err();
        assert_eq!(result["admission"], "rejected");
        assert!(connection.knowledge_pending.lock().unwrap().is_none());
    }); }
    #[test] fn knowledge_start_checks_the_saved_revision_and_keeps_ambiguous_admission_reserved() { tauri::async_runtime::block_on(async {
        let root = std::env::temp_dir().join(format!("auto-agent-knowledge-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let mut state = state();
        state.config_path = root.join("config.json");
        std::fs::write(&state.config_path, "{}").unwrap();
        let revision = configuration::read(&state.config_path).unwrap().revision;
        let (url, task) = server(vec![(500, json!({"error":"unknown admission"}))]).await;
        let mut connection = connection(url);
        Arc::get_mut(&mut connection).unwrap().config_revision = revision.clone();
        let stale = knowledge_request(&state, &connection, "POST", "/knowledge/ingest", Some(json!({"generation":connection.generation,"configRevision":"stale"}))).await.unwrap_err();
        assert_eq!(stale["admission"], "rejected");
        assert!(connection.knowledge_pending.lock().unwrap().is_none());
        let error = knowledge_request(&state, &connection, "POST", "/knowledge/ingest", Some(json!({"generation":connection.generation,"configRevision":revision}))).await.unwrap_err();
        assert_eq!(error["admission"], "unknown");
        assert_eq!(task.await.unwrap(), 1);
        assert!(connection.knowledge_pending.lock().unwrap().is_some());
        assert!(reconcile_knowledge(&connection, &json!({"operation":null})));
        std::fs::remove_dir_all(root).unwrap();
    }); }
    #[test] fn prompts_use_only_native_admission_and_match_the_exact_delivery_instead_of_scanning_history() { tauri::async_runtime::block_on(async {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let connection = connection(format!("http://{}", listener.local_addr().unwrap()));
        let task = tauri::async_runtime::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = [0; 8192];
            let count = socket.read(&mut bytes).await.unwrap();
            assert!(String::from_utf8_lossy(&bytes[..count]).starts_with("POST /corax/v1/session/fixture HTTP/1.1\r\n"));
            let body = json!({"sessionId":"fixture","deliveryId":"accepted-current"}).to_string();
            socket.write_all(format!("HTTP/1.1 202 Accepted\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        });
        let result = submit_prompt(&state(), &connection, "fixture", "local message").await.unwrap();
        assert_eq!(result["deliveryId"], "accepted-current");
        task.await.unwrap();
        let unrelated = vec![json!({"type":"turn.started","meta":{"deliveryIds":["older-delivery"]}}); 10000];
        assert!(admitted(&connection, "fixture", &unrelated, 0));
        assert!(!admitted(&connection, "fixture", &[json!({"type":"message.received","meta":{"deliveryIds":["accepted-current"]}})], 10000));
        assert!(connection.pending.lock().unwrap().is_empty());
    }); }
    #[test] fn events_before_the_http_receipt_are_bounded_and_reconciled_by_delivery_identity() {
        let connection = connection("http://127.0.0.1".into());
        connection.pending.lock().unwrap().insert("fixture".into(), PendingAdmission::Delivery { id: None, observed: VecDeque::new() });
        let ids: Vec<_> = (0..1000).map(|index| format!("delivery-{index}")).collect();
        assert!(admitted(&connection, "fixture", &[json!({"type":"turn.started","meta":{"deliveryIds":ids}})], 0));
        match connection.pending.lock().unwrap().get("fixture").unwrap() {
            PendingAdmission::Delivery { observed, .. } => assert_eq!(observed.len(), 256),
            _ => panic!("expected a delivery reservation"),
        }
        accept_delivery(&connection, "fixture", "delivery-999");
        assert!(connection.pending.lock().unwrap().is_empty());
    }
    #[test] fn unknown_prompt_outcomes_are_not_retried_or_cleared_by_unrelated_events() { tauri::async_runtime::block_on(async {
        let (url, task) = server(vec![(500, json!({"error":"uncertain"}))]).await;
        let connection = connection(url);
        let error = submit_prompt(&state(), &connection, "fixture", "local message").await.unwrap_err();
        assert_eq!(error["admission"], "unknown");
        assert_eq!(task.await.unwrap(), 1);
        assert!(admitted(&connection, "fixture", &[json!({"type":"turn.started","meta":{"deliveryIds":["unrelated"]}})], 0));
        assert!(submit_prompt(&state(), &connection, "fixture", "must not be sent").await.is_err());
        assert!(connection_has_active_work(&state(), &connection).await.is_err());
        assert!(connection.pending.lock().unwrap().contains_key("fixture"));
    }); }
    #[test] fn explicit_prompt_rejection_releases_admission_but_an_unidentified_success_does_not() { tauri::async_runtime::block_on(async {
        let (url, task) = server(vec![(400, json!({"error":"rejected"})), (202, json!({"sessionId":"fixture"}))]).await;
        let connection = connection(url);
        let error = submit_prompt(&state(), &connection, "fixture", "local message").await.unwrap_err();
        assert_eq!(error["admission"], "rejected");
        assert!(connection.pending.lock().unwrap().is_empty());
        let error = submit_prompt(&state(), &connection, "fixture", "local message").await.unwrap_err();
        assert_eq!(error["admission"], "unknown");
        assert!(connection.pending.lock().unwrap().contains_key("fixture"));
        assert_eq!(task.await.unwrap(), 2);
    }); }
    #[test] fn stale_view_cleanup_cannot_close_the_new_selection() { tauri::async_runtime::block_on(async {
        let mut views = ChatViews::default();
        views.open("first".into(), "old".into());
        let old = views.selected("old", "first").unwrap();
        views.open("second".into(), "new".into());
        let selected = views.selected("new", "second").unwrap();
        assert!(*old.closed.borrow());
        views.close("old");
        assert!(!*selected.closed.borrow());
        assert!(views.selected("old", "first").is_err());
        assert!(views.selected("new", "first").is_err());
        // A read arriving after cleanup is rejected without starting transport.
        let polled = AtomicBool::new(false);
        let result = old.read(async { polled.store(true, Ordering::SeqCst); Ok(()) }).await;
        assert!(result.is_err());
        assert!(!polled.load(Ordering::SeqCst));
        assert!(selected.read(async { Ok(()) }).await.is_ok());
    }); }
    #[test] fn selecting_another_view_releases_the_previous_subscription() { tauri::async_runtime::block_on(async {
        struct Released(Option<tokio::sync::oneshot::Sender<()>>);
        impl Drop for Released { fn drop(&mut self) { if let Some(sender) = self.0.take() { let _ = sender.send(()); } } }
        let (started, ready) = tokio::sync::oneshot::channel();
        let (released, stopped) = tokio::sync::oneshot::channel();
        let mut views = ChatViews::default();
        views.open("first".into(), "old".into());
        views.watch = Some(tauri::async_runtime::spawn(async move {
            let _release = Released(Some(released));
            started.send(()).unwrap();
            std::future::pending::<()>().await;
        }));
        ready.await.unwrap();
        views.open("second".into(), "new".into());
        tokio::time::timeout(Duration::from_secs(1), stopped).await.unwrap().unwrap();
        assert!(views.watch.is_none());
        assert!(views.selected("new", "second").is_ok());
    }); }
    #[test] fn closing_a_view_drops_its_http_body_read_but_preserves_write_admission() { tauri::async_runtime::block_on(async {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (headers_sent, headers_received) = tokio::sync::oneshot::channel();
        let server = tauri::async_runtime::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![];
            let mut buffer = [0; 1024];
            while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                let count = socket.read(&mut buffer).await.unwrap();
                assert!(count > 0);
                request.extend_from_slice(&buffer[..count]);
            }
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nContent-Length: 1000000\r\nConnection: close\r\n\r\n{\"type\":\"session.started\"}\n").await.unwrap();
            headers_sent.send(()).unwrap();
            // The response intentionally never finishes. A cancelled view must
            // close this owned read, rather than wait for the 30s client timeout.
            tokio::time::timeout(Duration::from_secs(2), socket.read(&mut buffer)).await.unwrap().unwrap()
        });
        let connection = connection(url);
        connection.pending.lock().unwrap().insert("pending-write".into(), PendingAdmission::Cursor(42));
        let write = DispatchGuard::reserve(&connection);
        let mut views = ChatViews::default();
        views.open("first".into(), "view".into());
        let view = views.selected("view", "first").unwrap();
        let read_connection = Arc::clone(&connection);
        let reader = tauri::async_runtime::spawn(async move {
            let state = state();
            view.read(history::read(&state.client, &read_connection, "first", HistoryQuery::From { start: 0, generation: None })).await
        });
        headers_received.await.unwrap();
        views.close("view");
        let result = tokio::time::timeout(Duration::from_secs(1), reader).await.unwrap().unwrap();
        assert!(result.is_err());
        assert_eq!(server.await.unwrap(), 0, "view cleanup must drop the HTTP response body");
        assert_eq!(connection.pending.lock().unwrap().get("pending-write"), Some(&PendingAdmission::Cursor(42)));
        assert_eq!(connection.in_flight.load(Ordering::SeqCst), 1);
        drop(write);
    }); }

    async fn shutdown_fixture(url: String) -> (PathBuf, Option<CoraxRuntime>, Arc<Connection>) {
        let root = std::env::temp_dir().join(format!("auto-agent-exit-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("keep.txt"), "host workspace data").unwrap();
        let ownership = Ownership::acquire(&root).unwrap();
        let mut command = Command::new("node");
        command.args(["-e", "setInterval(() => {}, 1000)"]).current_dir(&root)
            .env_remove("AUTO_AGENT_API_KEY").env_remove("AUTO_AGENT_TOKEN")
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true);
        #[cfg(windows)] command.creation_flags(0x08000000);
        #[cfg(unix)] command.process_group(0);
        let child = command.spawn().unwrap();
        let tree = Arc::new(ProcessTree::attach(&child).unwrap());
        let connection = connection(url);
        let backend = CoraxRuntime { child, connection: Arc::clone(&connection), chat: ChatViews::default(), tree, monitor: None, _ownership: ownership };
        (root, Some(backend), connection)
    }

    #[test] fn normal_stop_blocks_active_work_and_confirmed_force_preserves_workspace_and_unknown_admission() { tauri::async_runtime::block_on(async {
        let (root, mut slot, connection) = shutdown_fixture("http://127.0.0.1:9".into()).await;
        let write = DispatchGuard::reserve(&connection);
        connection.pending.lock().unwrap().insert("unconfirmed-write".into(), PendingAdmission::Cursor(42));
        let result = stop(&state(), &mut slot).await;
        assert!(result.is_err());
        assert!(slot.as_mut().unwrap().child.try_wait().unwrap().is_none());
        force_stop(&mut slot).await.unwrap();
        assert!(slot.is_none());
        assert_eq!(connection.pending.lock().unwrap().get("unconfirmed-write"), Some(&PendingAdmission::Cursor(42)));
        assert_eq!(connection.in_flight.load(Ordering::SeqCst), 1);
        assert_eq!(std::fs::read_to_string(root.join("keep.txt")).unwrap(), "host workspace data");
        drop(write);
        std::fs::remove_dir_all(root).unwrap();
    }); }

    #[test] fn confirmed_force_uses_the_owned_handle_even_when_lifecycle_lock_is_busy() { tauri::async_runtime::block_on(async {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (root, slot, connection) = shutdown_fixture(format!("http://{}", listener.local_addr().unwrap())).await;
        let state = state();
        state.exiting.store(true, Ordering::SeqCst);
        *state.owned_tree.lock().unwrap() = Some(Arc::downgrade(&slot.as_ref().unwrap().tree));
        connection.pending.lock().unwrap().insert("unknown-write".into(), PendingAdmission::Cursor(3));
        *state.backend.lock().await = slot;
        let mut held = state.backend.lock().await;
        force_exit_with_wait(&state, Duration::from_millis(50)).await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), held.as_mut().unwrap().child.wait()).await.unwrap().unwrap();
        assert_eq!(connection.pending.lock().unwrap().get("unknown-write"), Some(&PendingAdmission::Cursor(3)));
        drop(held);
        force_exit_with_wait(&state, Duration::from_millis(50)).await.unwrap();
        assert!(state.backend.lock().await.is_none());
        assert!(tokio::time::timeout(Duration::from_millis(50), listener.accept()).await.is_err(), "confirmed exit must not query health, activity or history");
        assert_eq!(std::fs::read_to_string(root.join("keep.txt")).unwrap(), "host workspace data");
        std::fs::remove_dir_all(root).unwrap();
    }); }

    #[test] fn an_exited_backend_does_not_silently_clear_unknown_write_protection() { tauri::async_runtime::block_on(async {
        let (root, mut slot, connection) = shutdown_fixture("http://127.0.0.1:9".into()).await;
        let backend = slot.as_mut().unwrap();
        backend.tree.force_stop();
        backend.child.wait().await.unwrap();
        connection.pending.lock().unwrap().insert("unknown-write".into(), PendingAdmission::Cursor(9));
        assert!(stop(&state(), &mut slot).await.is_err());
        assert!(slot.is_some());
        force_stop(&mut slot).await.unwrap();
        assert_eq!(connection.pending.lock().unwrap().get("unknown-write"), Some(&PendingAdmission::Cursor(9)));
        std::fs::remove_dir_all(root).unwrap();
    }); }
    #[test] fn an_exited_backend_cannot_bypass_update_safety_checks_or_clear_knowledge_admission() { tauri::async_runtime::block_on(async {
        let (root, mut slot, connection) = shutdown_fixture("http://127.0.0.1:9".into()).await;
        let backend = slot.as_mut().unwrap();
        backend.tree.force_stop();
        backend.child.wait().await.unwrap();
        assert!(stop_for_update(&state(), &mut slot).await.unwrap_err().contains("后台进程已退出"));
        assert!(slot.is_some());
        *connection.knowledge_pending.lock().unwrap() = Some("unknown-compiler".into());
        assert!(stop_for_update(&state(), &mut slot).await.is_err());
        assert_eq!(connection.knowledge_pending.lock().unwrap().as_deref(), Some("unknown-compiler"));
        force_stop(&mut slot).await.unwrap();
        assert_eq!(std::fs::read_to_string(root.join("keep.txt")).unwrap(), "host workspace data");
        std::fs::remove_dir_all(root).unwrap();
    }); }
}
