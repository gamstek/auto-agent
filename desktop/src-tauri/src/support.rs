use super::*;
use std::io::{Read, Write, Cursor};

const EVENTS: &[&str] = &["backend.starting", "backend.ready", "backend.spawn_failed", "backend.start_timeout", "backend.exited", "stream.interrupted", "stream.recovered", "stream.invalid", "session.closed", "session.failed", "turn.failed"];
const CURRENT: &str = "desktop-events.log";
const PREVIOUS: &str = "desktop-events.previous.log";
const NO_RECORDS: &str = "没有可导出的诊断记录，未保存 ZIP。请确认数据目录可写，并在此版本中复现问题后重试。";

fn check_directory(directory: &Path) -> Result<(), String> {
    for path in directory.ancestors() {
        match std::fs::symlink_metadata(path) {
            Ok(meta) if meta.is_dir() && !is_link(&meta) => {},
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {},
            _ => return Err("无法访问日志目录或目录不是普通目录".into()),
        }
    }
    Ok(())
}

// Record transitions, never payloads. Diagnostic IO must not interrupt a run.
pub(super) fn record(data: &Path, event: &'static str) {
    if !EVENTS.contains(&event) { return; }
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = data.join("logs");
    let result = (|| -> Result<(), String> {
        check_directory(&dir)?;
        std::fs::create_dir_all(&dir).map_err(|_| "mkdir")?;
        let path = dir.join(CURRENT);
        match std::fs::symlink_metadata(&path) {
            Ok(meta) if !meta.is_file() || is_link(&meta) => return Err("invalid file".into()),
            Ok(meta) if meta.len() >= 256 * 1024 => std::fs::rename(&path, dir.join(PREVIOUS)).map_err(|_| "rotate")?,
            Ok(_) => {},
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {},
            Err(_) => return Err("stat".into()),
        }
        let mut file = std::fs::OpenOptions::new().create(true).append(true).open(path).map_err(|_| "open")?;
        let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis();
        writeln!(file, "{}", json!({"event":event,"timestampMs":at})).map_err(|_| "write".into())
    })();
    if result.is_err() { eprintln!("[diagnostics] unable to persist runtime event"); }
}

// Export is a projection, not a copy: unknown fields and all free text are omitted.
fn project(value: &Value) -> Value {
    let mut out = serde_json::Map::new();
    if let (Some(event), Some(time)) = (value["event"].as_str().filter(|e| EVENTS.contains(e)), value["timestampMs"].as_u64()) {
        out.insert("event".into(), json!(event));
        out.insert("timestampMs".into(), json!(time));
        if matches!(event, "turn.failed" | "session.failed") {
            if let Some(code @ ("MODEL_CALL_FAILED" | "WORKFLOW_STREAM_WRITE_FAILED" | "OTHER")) = value["errorCode"].as_str() {
                out.insert("errorCode".into(), json!(code));
                if code == "MODEL_CALL_FAILED" {
                    if let Some(status) = value["httpStatus"].as_u64().filter(|n| (400..=599).contains(n)) {
                        out.insert("httpStatus".into(), json!(status));
                    }
                }
            }
        }
    }
    if let Some(time) = value["at"].as_str() {
        if time.len() == 24 && time.bytes().all(|b| b.is_ascii_digit() || b"-:.TZ".contains(&b)) {
            out.insert("at".into(), json!(time));
        }
    }
    if let Some(level) = value["level"].as_str().filter(|level| ["error", "warn", "info", "debug", "trace"].contains(level)) {
        out.insert("level".into(), json!(level));
    }
    if let Some(source) = value["source"].as_str().filter(|source| ["stdout", "stderr"].contains(source)) {
        out.insert("source".into(), json!(source));
    }
    Value::Object(out)
}

fn archive(config_path: &Path) -> Result<(Vec<u8>, usize), String> {
    let document = configuration::read(config_path)?;
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut summary = json!({ "format": 3, "version": env!("CARGO_PKG_VERSION"), "engine": "corax", "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "policy": "Allowlisted metadata only; no credentials, paths, URLs, prompts, conversations, raw errors or script output." });
    let mut count = 0;
    let directory = configuration::data_directory(config_path, &document.raw)?.join("corax").join("logs");
    // Reject symlinks/junctions, including parent directories.
    check_directory(&directory)?;
    let entries = std::fs::read_dir(&directory).map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { NO_RECORDS } else { "无法读取诊断日志目录" })?;
    let mut names: Vec<_> = entries.collect::<Result<Vec<_>, _>>().map_err(|_| "无法读取诊断日志条目")?.into_iter()
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| name.starts_with("dev-") && name.ends_with(".log")).collect();
    names.sort(); names.reverse();
    for (index, name) in [PREVIOUS, CURRENT, "runtime-failures.previous.log", "runtime-failures.log"].map(str::to_owned).into_iter().chain(names.into_iter().take(8)).enumerate() {
            let path = directory.join(&name);
            let Ok(meta) = std::fs::symlink_metadata(&path) else { continue; };
            if !meta.is_file() || is_link(&meta) { continue; }
            let mut bytes = Vec::new();
            std::fs::File::open(&path).map_err(|_| "无法读取日志")?.take(2 * 1024 * 1024).read_to_end(&mut bytes).map_err(|_| "无法读取日志")?;
            let mut started = false;
            for line in bytes.split(|b| *b == b'\n').filter(|line| line.len() <= 16384) {
                if let Ok(value) = serde_json::from_slice::<Value>(line) {
                    let projected = project(&value);
                    if projected.as_object().is_none_or(|o| o.is_empty()) { continue; }
                    if !started {
                        zip.start_file(format!("logs/corax-{index}.jsonl"), options).map_err(|_| "无法创建日志摘要")?;
                        started = true;
                    }
                    writeln!(zip, "{}", projected).map_err(|_| "无法写入日志摘要")?;
                    count += 1;
                }
            }
    }
    if count == 0 { return Err(NO_RECORDS.into()); }
    summary["recordCount"] = json!(count);
    zip.start_file("summary.json", options).map_err(|_| "无法创建诊断包")?;
    zip.write_all(summary.to_string().as_bytes()).map_err(|_| "无法写入诊断包")?;
    Ok((zip.finish().map_err(|_| "无法完成诊断包")?.into_inner(), count))
}
fn is_link(meta: &std::fs::Metadata) -> bool {
    #[cfg(windows)] { use std::os::windows::fs::MetadataExt; meta.file_attributes() & 0x400 != 0 }
    #[cfg(not(windows))] { meta.file_type().is_symlink() }
}

#[tauri::command]
pub async fn export_diagnostics(app: tauri::AppHandle, state: State<'_, Desktop>) -> Result<Option<usize>, String> {
    let config_path = state.config_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (bytes, count) = archive(&config_path)?;
        let Some(file) = app.dialog().file().set_file_name("auto-agent-diagnostics.zip").add_filter("诊断包", &["zip"]).blocking_save_file() else { return Ok(None); };
        let path = file.into_path().map_err(|_| "保存位置无效")?;
        std::fs::write(path, bytes).map_err(|_| "无法保存诊断包")?;
        Ok(Some(count))
    }).await.map_err(|_| "诊断导出任务失败")?
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn installed_runtime_exports_transitions_without_dev_logs() {
        let root = std::env::temp_dir().join(format!("auto-agent-diagnostics-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let config = root.join("config.json");
        std::fs::write(&config, r#"{"dataDir":"data"}"#).unwrap();
        let data = root.join("data/corax");
        assert_eq!(archive(&config).unwrap_err(), NO_RECORDS);
        std::fs::create_dir_all(data.join("logs")).unwrap();
        std::fs::write(data.join("logs").join(CURRENT), b"invalid\n{\"detail\":\"private\"}\n").unwrap();
        assert_eq!(archive(&config).unwrap_err(), NO_RECORDS);
        for event in ["stream.interrupted", "stream.recovered", "turn.failed"] { record(&data, event); }
        std::fs::write(data.join("logs/runtime-failures.log"), br#"{"event":"turn.failed","timestampMs":42,"errorCode":"MODEL_CALL_FAILED","httpStatus":422,"message":"private"}"#).unwrap();
        let (bytes, count) = archive(&config).unwrap();
        assert_eq!(count, 4);
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let summary: Value = serde_json::from_reader(zip.by_name("summary.json").unwrap()).unwrap();
        assert_eq!(summary["recordCount"], 4);
        let failure: Value = serde_json::from_reader(zip.by_name("logs/corax-3.jsonl").unwrap()).unwrap();
        assert_eq!(failure, json!({"event":"turn.failed","timestampMs":42,"errorCode":"MODEL_CALL_FAILED","httpStatus":422}));
        let mut text = String::new();
        zip.by_name("logs/corax-1.jsonl").unwrap().read_to_string(&mut text).unwrap();
        assert!(!text.contains("private"));
        assert!(text.contains("stream.interrupted") && text.contains("turn.failed"));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test] fn export_drops_free_text_and_fake_metadata() {
        let value = project(&json!({"event":"secret-token", "timestamp":"C:\\Users\\private", "runId":"secret", "status":"Bearer abc", "httpStatus":402, "stderr":"private sample", "apiKey":"key", "nested":{"token":"x"}}));
        assert_eq!(value, json!({}));
    }
    #[test] fn export_projects_corax_log_metadata() {
        let value = json!({"at":"2026-11-03T07:49:20.000Z", "level":"error", "source":"stderr", "detail":"SECRET"});
        assert_eq!(project(&value), json!({"at":"2026-11-03T07:49:20.000Z", "level":"error", "source":"stderr"}));
    }
    #[test] fn archive_only_contains_projected_logs_and_summary() {
        let root = std::env::temp_dir().join(format!("auto-agent-support-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("data/corax/logs")).unwrap();
        std::fs::write(root.join("data/corax/logs/dev-test.log"), "{\"level\":\"error\",\"source\":\"stderr\",\"detail\":\"SECRET_SAMPLE\"}\ninvalid\n").unwrap();
        std::fs::write(root.join("data/storage.sqlite"), "SECRET_CHAT").unwrap();
        let config_path = root.join("config.json");
        std::fs::write(&config_path, "{\"dataDir\":\"data\"}").unwrap();
        let (bytes, count) = archive(&config_path).unwrap();
        assert_eq!(count, 1);
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        assert_eq!(zip.len(), 2);
        let mut text = String::new();
        zip.by_name("logs/corax-4.jsonl").unwrap().read_to_string(&mut text).unwrap();
        assert!(text.contains("stderr"));
        assert!(!text.contains("SECRET"));
        assert!(!text.contains("invalid"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
