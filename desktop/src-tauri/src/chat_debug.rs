//! Development-only timings. Never accept message bodies, paths, IDs or error text.
use serde_json::{json, Value};
use std::time::Instant;

#[cfg(debug_assertions)]
mod output {
    use super::*;
    use std::{fs::{File, OpenOptions}, io::{Seek, SeekFrom, Write}, path::{Path, PathBuf}, sync::{Mutex, OnceLock}};

    const LIMIT: u64 = 2 * 1024 * 1024;
    struct Log { file: File, path: PathBuf, size: u64 }
    static LOG: OnceLock<Mutex<Log>> = OnceLock::new();

    fn open_log(path: &Path) -> std::io::Result<File> {
        // Windows append-only handles cannot truncate. This process owns the
        // writer under LOG's mutex, so seek explicitly instead of O_APPEND.
        let mut file = OpenOptions::new().create(true).truncate(false).write(true).open(path)?;
        file.seek(SeekFrom::End(0))?;
        Ok(file)
    }

    pub fn initialize(root: &Path) {
        let path = root.join("desktop-debug.log");
        match std::fs::create_dir_all(root).and_then(|_| open_log(&path)) {
            Ok(file) => {
                let size = file.metadata().map(|meta| meta.len()).unwrap_or(0);
                let _ = LOG.set(Mutex::new(Log { file, path, size }));
                write(json!({"source":"rust","operation":"startup","stage":"begin"}));
            },
            Err(_) => eprintln!("[desktop-debug] unable to open timing log"),
        }
    }

    pub fn write(mut record: Value) {
        record["timestampMs"] = json!(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis());
        let Some(log) = LOG.get() else { return; };
        let Ok(mut log) = log.lock() else { return; };
        let Ok(mut line) = serde_json::to_vec(&record) else { return; };
        line.push(b'\n');
        if log.size + line.len() as u64 > LIMIT {
            // Keep one bounded previous file and reset the writable handle's cursor.
            if std::fs::copy(&log.path, log.path.with_file_name("desktop-debug.previous.log")).is_err() { return; }
            if log.file.set_len(0).is_err() { return; }
            if log.file.seek(SeekFrom::Start(0)).is_err() { return; }
            log.size = 0;
        }
        if log.file.write_all(&line).is_ok() { log.size += line.len() as u64; }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn reopened_log_preserves_records_and_can_truncate_for_rotation() {
            let root = std::env::temp_dir().join(format!("auto-agent-log-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&root).unwrap();
            let path = root.join("desktop-debug.log");
            {
                let mut file = open_log(&path).unwrap();
                file.write_all(b"first\n").unwrap();
            }
            {
                let mut file = open_log(&path).unwrap();
                file.write_all(b"second\n").unwrap();
                assert_eq!(std::fs::read(&path).unwrap(), b"first\nsecond\n");
                let previous = root.join("desktop-debug.previous.log");
                std::fs::copy(&path, &previous).unwrap();
                file.set_len(0).unwrap();
                file.seek(SeekFrom::Start(0)).unwrap();
                file.write_all(b"new\n").unwrap();
                assert_eq!(std::fs::read(previous).unwrap(), b"first\nsecond\n");
                assert_eq!(std::fs::read(&path).unwrap(), b"new\n");
            }
            std::fs::remove_dir_all(root).unwrap();
        }
    }
}

#[cfg(debug_assertions)]
pub fn initialize(root: &std::path::Path) { output::initialize(root); }

pub struct Span {
    started: Instant,
    operation: &'static str,
    trace: u64,
}
impl Span {
    pub fn new(operation: &'static str) -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let span = Self { started: Instant::now(), operation, trace: NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed) };
        span.mark("begin", json!({}));
        span
    }
    pub fn mark(&self, stage: &'static str, details: Value) {
        #[cfg(debug_assertions)] output::write(json!({"source":"rust","operation":self.operation,"trace":self.trace,"stage":stage,"elapsedMs":self.started.elapsed().as_millis(),"details":details}));
        #[cfg(not(debug_assertions))] let _ = (stage, details, &self.started, self.operation, self.trace);
    }
}
impl Drop for Span { fn drop(&mut self) { self.mark("end", json!({})); } }

#[tauri::command]
pub fn frontend_debug(operation: String, stage: String, trace: u32, elapsed_ms: f64, details: Value) -> Result<(), String> {
    if !["send", "chat-sync", "session-list", "chat-state", "chat-stream"].contains(&operation.as_str())
        || !["begin", "end", "create", "created", "submit", "accepted", "sync", "synced", "list", "listed", "error", "cancelled", "joined", "history", "projection", "watch", "watched", "page", "state", "first-event"].contains(&stage.as_str())
        || !elapsed_ms.is_finite() || elapsed_ms < 0.0 {
        return Err("Invalid timing metadata".into());
    }
    let fields = details.as_object().ok_or("Invalid timing metadata")?;
    if fields.iter().any(|(key, value)| !["count", "cursor", "reset", "loaded", "sending", "loading", "busy", "connected", "initial", "durationMs", "success"].contains(&key.as_str()) || !(value.is_number() || value.is_boolean())) {
        return Err("Invalid timing metadata".into());
    }
    #[cfg(debug_assertions)] output::write(json!({"source":"webview","operation":operation,"stage":stage,"trace":trace,"elapsedMs":elapsed_ms,"details":details}));
    #[cfg(not(debug_assertions))] let _ = trace;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn timing_input_only_accepts_allowlisted_numeric_metadata() {
        assert!(frontend_debug("send".into(), "accepted".into(), 1, 123.0, json!({"initial":true})).is_ok());
        for details in [json!({"message":"private"}), json!({"count":"private"}), json!({"path":3})] {
            assert!(frontend_debug("send".into(), "begin".into(), 1, 0.0, details).is_err());
        }
        assert!(frontend_debug("private".into(), "begin".into(), 1, 0.0, json!({})).is_err());
        assert!(frontend_debug("send".into(), "begin".into(), 1, f64::NAN, json!({})).is_err());
    }
}
