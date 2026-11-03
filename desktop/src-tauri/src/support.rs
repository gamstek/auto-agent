use super::*;
use std::io::{Read, Write, Cursor};

// Export is a projection, not a copy: unknown fields and all free text are omitted.
fn project(value: &Value) -> Value {
    let mut out = serde_json::Map::new();
    for key in ["runId", "executionId", "sessionId", "messageId"] {
        if let Some(id) = value[key].as_str().and_then(|s| uuid::Uuid::parse_str(s).ok()) {
            out.insert(key.into(), json!(id.to_string()));
        }
    }
    if let Some(event) = value["event"].as_str() {
        let known = ["app.started", "startup.failed", "script.started", "script.finished", "script.failed", "script.diagnostic", "script.result", "execution.outcome", "process.error", "process.exit", "process.result", "process.cleanup", "process.tracker_ready", "process.output_unconfirmed", "skill_log.truncated", "model.diagnostic", "generation.completed", "generation.failed", "review.resolved", "review.reported", "service.stopping", "service.stopped", "api.failed", "cli.failed"];
        out.insert("event".into(), json!(if known.contains(&event) { event } else { "other" }));
    }
    if let Some(time) = value["timestamp"].as_str() {
        if time.len() == 24 && time.bytes().all(|b| b.is_ascii_digit() || b"-:.TZ".contains(&b)) {
            out.insert("timestamp".into(), json!(time));
        }
    }
    for key in ["exitCode", "durationMs", "status", "httpStatus", "inputTokens", "outputTokens", "totalTokens"] {
        if value[key].is_number() { out.insert(key.into(), value[key].clone()); }
    }
    for key in ["clean", "ready", "truncated"] {
        if value[key].is_boolean() { out.insert(key.into(), value[key].clone()); }
    }
    Value::Object(out)
}

fn archive(config_path: &Path) -> Result<Vec<u8>, String> {
    let document = configuration::read(config_path)?;
    let settings = configuration::settings(config_path, &document.raw)?;
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let summary = json!({ "format": 1, "version": env!("CARGO_PKG_VERSION"), "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH, "builtinSkills": settings.builtin_skills, "builtinWiki": settings.builtin_wiki,
        "skillRootCount": settings.skill_roots.len(), "wikiRootCount": settings.wiki_roots.len(),
        "maxSteps": settings.max_steps, "maxInputTokens": settings.max_input_tokens, "maxOutputTokens": settings.max_output_tokens,
        "modelTimeoutMs": settings.model_timeout_ms, "scriptTimeoutMs": settings.script_timeout_ms,
        "policy": "Allowlisted metadata only; no credentials, paths, URLs, prompts, conversations, raw errors or script output." });
    zip.start_file("summary.json", options).map_err(|_| "无法创建诊断包")?;
    zip.write_all(summary.to_string().as_bytes()).map_err(|_| "无法写入诊断包")?;
    let directory = configuration::data_directory(config_path, &document.raw)?.join("logs");
    // Reject symlinks/junctions, including parent directories.
    for path in directory.ancestors() {
        if let Ok(meta) = std::fs::symlink_metadata(path) {
            if !meta.is_dir() || is_link(&meta) { return Err("日志目录不是普通目录".into()); }
        }
    }
    for base in ["agent.jsonl", "skills.jsonl"] {
        for suffix in ["", ".1", ".2", ".3"] {
            let name = format!("{base}{suffix}");
            let path = directory.join(&name);
            let Ok(meta) = std::fs::symlink_metadata(&path) else { continue; };
            if !meta.is_file() || is_link(&meta) { continue; }
            let mut bytes = Vec::new();
            std::fs::File::open(&path).map_err(|_| "无法读取日志")?.take(2 * 1024 * 1024).read_to_end(&mut bytes).map_err(|_| "无法读取日志")?;
            zip.start_file(format!("logs/{name}"), options).map_err(|_| "无法创建日志摘要")?;
            for line in bytes.split(|b| *b == b'\n').filter(|line| line.len() <= 16384) {
                if let Ok(value) = serde_json::from_slice::<Value>(line) {
                    writeln!(zip, "{}", project(&value)).map_err(|_| "无法写入日志摘要")?;
                }
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
        assert_eq!(value, json!({"event":"other", "httpStatus":402}));
    }
    #[test] fn export_preserves_correlation() {
        let id = uuid::Uuid::new_v4().to_string();
        assert_eq!(project(&json!({"runId":id, "event":"model.diagnostic", "timestamp":"2026-11-03T07:49:20.000Z"}))["runId"], id);
    }
    #[test] fn archive_only_contains_projected_logs_and_summary() {
        let root = std::env::temp_dir().join(format!("auto-agent-support-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("data/logs")).unwrap();
        std::fs::write(root.join("data/logs/agent.jsonl"), "{\"event\":\"model.diagnostic\",\"httpStatus\":402,\"stderr\":\"SECRET_SAMPLE\"}\ninvalid\n").unwrap();
        std::fs::write(root.join("data/storage.sqlite"), "SECRET_CHAT").unwrap();
        let config_path = root.join("config.json");
        std::fs::write(&config_path, "{\"dataDir\":\"data\"}").unwrap();
        let bytes = archive(&config_path).unwrap();
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        assert_eq!(zip.len(), 2);
        let mut text = String::new();
        zip.by_name("logs/agent.jsonl").unwrap().read_to_string(&mut text).unwrap();
        assert!(text.contains("402"));
        assert!(!text.contains("SECRET"));
        assert!(!text.contains("invalid"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
