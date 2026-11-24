use std::path::{Path, PathBuf};
use tauri_plugin_opener::OpenerExt;

#[derive(serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalFileAction {
    Open,
    Reveal,
}

fn local_absolute(path: &Path) -> bool {
    if !path.is_absolute() {
        return false;
    }
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        let bytes = text.as_bytes();
        return bytes.first().is_some_and(u8::is_ascii_alphabetic)
            && bytes.get(1) == Some(&b':')
            && !bytes[2..].contains(&b':');
    }
    #[cfg(not(windows))]
    !path.to_string_lossy().starts_with("//")
}

fn resolve_target(path: &str, action: &LocalFileAction) -> Result<PathBuf, String> {
    if path.len() > 4096 || path.chars().any(char::is_control) || !local_absolute(Path::new(path)) {
        return Err("需要本机文件或目录的绝对路径。".into());
    }
    let target = dunce::canonicalize(path).map_err(|_| "文件或目录不存在，或无法访问。")?;
    if !local_absolute(&target) {
        return Err("无法打开非本机路径。".into());
    }
    let metadata = std::fs::metadata(&target).map_err(|_| "无法读取文件或目录。")?;
    if metadata.is_dir() {
        return Ok(target);
    }
    if !metadata.is_file() {
        return Err("仅支持普通文件和目录。".into());
    }
    if matches!(action, LocalFileAction::Open) {
        let ext = target.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
        if !matches!(ext.as_str(), "pdf" | "txt" | "md" | "log" | "json" | "xml" | "csv" | "tsv" | "xlsx" | "xls" | "docx" | "pptx" | "png" | "jpg" | "jpeg" | "gif" | "webp" | "mp4" | "webm" | "sam" | "smp") {
            return Err("此文件类型不支持直接打开，可在文件管理器中定位。".into());
        }
    }
    Ok(target)
}

#[tauri::command]
pub async fn local_file_action(app: tauri::AppHandle, path: String, action: LocalFileAction) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let target = resolve_target(&path, &action)?;
        match action {
            LocalFileAction::Open => app.opener().open_path(target.to_string_lossy(), None::<&str>),
            LocalFileAction::Reveal => app.opener().reveal_item_in_dir(target),
        }
        .map_err(|_| "无法在系统中打开或定位此文件。".into())
    }).await.map_err(|_| "文件操作失败。".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_targets_require_an_existing_absolute_path() {
        assert!(resolve_target("../report.pdf", &LocalFileAction::Open).is_err());
        assert!(resolve_target("https://example.com/report.pdf", &LocalFileAction::Reveal).is_err());
        let source = dunce::canonicalize(Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml")).unwrap();
        assert!(resolve_target(source.to_str().unwrap(), &LocalFileAction::Reveal).is_ok());
        assert!(resolve_target(source.to_str().unwrap(), &LocalFileAction::Open).is_err());
        assert!(resolve_target(source.parent().unwrap().to_str().unwrap(), &LocalFileAction::Open).is_ok());
    }
}
