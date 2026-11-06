use super::*;
use std::io::{Read, Write, Cursor};

// Export is a projection, not a copy: unknown fields and all free text are omitted.
fn project(value: &Value) -> Value {
    let mut out = serde_json::Map::new();
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

fn archive(config_path: &Path) -> Result<Vec<u8>, String> {
    let document = configuration::read(config_path)?;
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let summary = json!({ "format": 2, "version": env!("CARGO_PKG_VERSION"), "engine": "corax", "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "policy": "Allowlisted metadata only; no credentials, paths, URLs, prompts, conversations, raw errors or script output." });
    zip.start_file("summary.json", options).map_err(|_| "无法创建诊断包")?;
    zip.write_all(summary.to_string().as_bytes()).map_err(|_| "无法写入诊断包")?;
    let directory = configuration::data_directory(config_path, &document.raw)?.join("corax").join("logs");
    // Reject symlinks/junctions, including parent directories.
    for path in directory.ancestors() {
        if let Ok(meta) = std::fs::symlink_metadata(path) {
            if !meta.is_dir() || is_link(&meta) { return Err("日志目录不是普通目录".into()); }
        }
    }
    let mut names: Vec<_> = std::fs::read_dir(&directory).into_iter().flatten().filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| name.starts_with("dev-") && name.ends_with(".log")).collect();
    names.sort(); names.reverse();
    for (index, name) in names.into_iter().take(8).enumerate() {
            let path = directory.join(&name);
            let Ok(meta) = std::fs::symlink_metadata(&path) else { continue; };
            if !meta.is_file() || is_link(&meta) { continue; }
            let mut bytes = Vec::new();
            std::fs::File::open(&path).map_err(|_| "无法读取日志")?.take(2 * 1024 * 1024).read_to_end(&mut bytes).map_err(|_| "无法读取日志")?;
            zip.start_file(format!("logs/corax-{index}.jsonl"), options).map_err(|_| "无法创建日志摘要")?;
            for line in bytes.split(|b| *b == b'\n').filter(|line| line.len() <= 16384) {
                if let Ok(value) = serde_json::from_slice::<Value>(line) {
                    writeln!(zip, "{}", project(&value)).map_err(|_| "无法写入日志摘要")?;
                }
            }
    }
    Ok(zip.finish().map_err(|_| "无法完成诊断包")?.into_inner())
}
fn is_link(meta: &std::fs::Metadata) -> bool {
    #[cfg(windows)] { use std::os::windows::fs::MetadataExt; meta.file_attributes() & 0x400 != 0 }
    #[cfg(not(windows))] { meta.file_type().is_symlink() }
}

#[tauri::command]
pub async fn export_diagnostics(app: tauri::AppHandle, state: State<'_, Desktop>) -> Result<bool, String> {
    let config_path = state.config_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(file) = app.dialog().file().set_file_name("auto-agent-diagnostics.zip").add_filter("诊断包", &["zip"]).blocking_save_file() else { return Ok(false); };
        let path = file.into_path().map_err(|_| "保存位置无效")?;
        let bytes = archive(&config_path)?;
        std::fs::write(path, bytes).map_err(|_| "无法保存诊断包")?;
        Ok(true)
    }).await.map_err(|_| "诊断导出任务失败")?
}

#[cfg(test)] mod tests {
    use super::*;
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
        let bytes = archive(&config_path).unwrap();
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        assert_eq!(zip.len(), 2);
        let mut text = String::new();
        zip.by_name("logs/corax-0.jsonl").unwrap().read_to_string(&mut text).unwrap();
        assert!(text.contains("stderr"));
        assert!(!text.contains("SECRET"));
        assert!(!text.contains("invalid"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
