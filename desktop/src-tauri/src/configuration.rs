use super::*;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::collections::HashSet;

const FIELDS: &[&str] = &["dataDir", "model", "baseURL", "maxInputTokens", "maxOutputTokens", "systemPrompt", "approvalMode", "llmWiki", "climber"];
pub const DATA_LAYOUT: &str = "corax-node-llm-wiki-v1";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct ClimberSettings {
    enabled: bool,
    #[serde(rename = "serviceURL")]
    service_url: String,
    timeout_ms: u64,
}
impl Default for ClimberSettings {
    fn default() -> Self { Self { enabled: true, service_url: "http://127.0.0.1:18080/api/v1".into(), timeout_ms: 5000 } }
}
impl ClimberSettings {
    pub fn validate(&self) -> Result<(), String> {
        if self.timeout_ms < 100 || self.timeout_ms > 60000 || self.service_url.len() > 4096 { return Err("Climber 超时应为100–60000毫秒".into()); }
        if !self.enabled && self.service_url.is_empty() { return Ok(()); }
        let url = reqwest::Url::parse(&self.service_url).map_err(|_| "Climber 地址不是有效 URL")?;
        if !["http", "https"].contains(&url.scheme()) || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() || !["/api/v1", "/api/v1/"].contains(&url.path()) {
            return Err("Climber 地址须为不含凭据、查询参数或片段的 HTTP(S) /api/v1 地址".into());
        }
        Ok(())
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextSource {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    path: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct LlmWikiSettings { sources: Vec<TextSource> }
impl Default for LlmWikiSettings {
    fn default() -> Self { Self { sources: vec![] } }
}
fn identifier(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.as_bytes()[0].is_ascii_alphanumeric()
        && id.bytes().all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
}
impl LlmWikiSettings {
    pub fn validate(&self) -> Result<(), String> {
        if self.sources.len() > 100 { return Err("LLM Wiki 来源数量超过上限".into()); }
        let mut ids = HashSet::new();
        for source in &self.sources {
            if !identifier(&source.id) || !ids.insert(&source.id)
                || !["file", "directory"].contains(&source.kind.as_str()) || source.path.is_empty() || source.path.len() > 4096
                || (source.kind == "file" && !["md", "markdown", "txt"].contains(&Path::new(&source.path).extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase().as_str())) {
                return Err("LLM Wiki 只接受 Markdown/TXT 文本来源，且来源 ID 必须唯一".into());
            }
        }
        Ok(())
    }
}

pub struct Document { pub raw: Value, pub revision: String }
pub fn read(path: &Path) -> Result<Document, String> {
    let bytes = std::fs::read(path).map_err(|_| "无法读取 config.json")?;
    let raw: Value = serde_json::from_slice(&bytes).map_err(|_| "config.json 必须是有效 JSON 对象")?;
    let settings: Settings = serde_json::from_value(raw.clone()).map_err(|_| "配置字段无效；当前版本只接受现行配置结构")?;
    settings.validate()?;
    Ok(Document { raw, revision: format!("{:x}", Sha256::digest(&bytes)) })
}
pub fn display_path(path: &Path) -> PathBuf {
    dunce::simplified(path).components().collect()
}
fn resolve(path: &Path, value: &str) -> String {
    let value = Path::new(value);
    display_path(&if value.is_absolute() { value.to_path_buf() } else { path.parent().unwrap().join(value) }).to_string_lossy().into_owned()
}
pub fn data_directory(path: &Path, raw: &Value) -> Result<PathBuf, String> {
    let settings: Settings = serde_json::from_value(raw.clone()).map_err(|_| "配置字段无效")?;
    Ok(PathBuf::from(resolve(path, &settings.data_dir)))
}
pub fn settings(path: &Path, raw: &Value) -> Result<Settings, String> {
    let mut settings: Settings = serde_json::from_value(raw.clone()).map_err(|_| "配置字段无效")?;
    settings.validate()?;
    settings.data_dir = resolve(path, &settings.data_dir);
    for source in &mut settings.llm_wiki.sources { source.path = resolve(path, &source.path); }
    Ok(settings)
}
pub fn merged(path: &Path, raw: &Value, next: &Settings) -> Result<Value, String> {
    next.validate()?;
    let before = serde_json::to_value(settings(path, raw)?).unwrap();
    let after = serde_json::to_value(next).unwrap();
    let mut result = raw.clone();
    // Keep unchanged relative paths, without translating historical fields or schemas.
    for field in FIELDS { if *field != "llmWiki" && before[*field] != after[*field] { result[*field] = after[*field].clone(); } }
    if before["llmWiki"] != after["llmWiki"] {
        let mut wiki = after["llmWiki"].clone();
        for field in ["sources"] {
            for entry in wiki[field].as_array_mut().unwrap() {
                let previous = before["llmWiki"][field].as_array().unwrap().iter().find(|item| item["id"] == entry["id"]);
                if previous.is_some_and(|item| item["path"] == entry["path"]) {
                    if let Some(original) = raw["llmWiki"][field].as_array().and_then(|items| items.iter().find(|item| item["id"] == entry["id"])) {
                        entry["path"] = original["path"].clone();
                    }
                }
            }
        }
        result["llmWiki"] = wiki;
    }
    let checked: Settings = serde_json::from_value(result.clone()).map_err(|_| "配置字段无效")?;
    checked.validate()?;
    Ok(result)
}
pub fn ensure(path: &Path) -> Result<(), String> {
    if path.exists() { return Ok(()); }
    let root = path.parent().ok_or("配置路径无效")?;
    std::fs::create_dir_all(root).map_err(|_| "无法创建配置目录")?;
    let raw = serde_json::to_vec_pretty(&Settings::default()).unwrap();
    match std::fs::OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(mut file) => {
            file.write_all(&raw).map_err(|_| "无法创建配置")?;
            std::fs::write(root.join(".data-layout"), DATA_LAYOUT).map_err(|_| "无法写入数据目录版本".to_string())
        },
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(_) => Err("无法创建配置".into()),
    }
}
pub fn save(path: &Path, revision: &str, next: &Settings) -> Result<String, String> {
    let document = read(path)?;
    if document.revision != revision { return Err("配置已被外部修改，请重新读取配置后再编辑".into()); }
    write_json(path, &merged(path, &document.raw, next)?)?;
    Ok(read(path)?.revision)
}

#[cfg(test)] mod tests {
    use super::*;
    struct Fixture { root: PathBuf, path: PathBuf }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("auto-agent-config-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&root).unwrap();
            Self { path: root.join("config.json"), root }
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.root); } }
    #[test] fn defaults_create_current_configuration_and_layout() {
        let f = Fixture::new(); ensure(&f.path).unwrap();
        let document = read(&f.path).unwrap();
        assert_eq!(document.raw["dataDir"], ".");
        assert_eq!(document.raw["llmWiki"], json!({"sources":[]}));
        assert_eq!(document.raw["climber"], json!({"enabled":true,"serviceURL":"http://127.0.0.1:18080/api/v1","timeoutMs":5000}));
        assert_eq!(document.raw["approvalMode"], "always");
        assert_eq!(std::fs::read_to_string(f.root.join(".data-layout")).unwrap(), DATA_LAYOUT);
        ensure(&f.path).unwrap();
        assert_eq!(read(&f.path).unwrap().revision, document.revision);
    }
    #[test] fn approval_mode_roundtrips_and_stale_settings_cannot_overwrite_it() {
        let f = Fixture::new(); ensure(&f.path).unwrap();
        let before = read(&f.path).unwrap();
        let mut next = settings(&f.path, &before.raw).unwrap();
        next.approval_mode = "never".into();
        save(&f.path, &before.revision, &next).unwrap();
        let saved = read(&f.path).unwrap();
        assert_eq!(saved.raw["approvalMode"], "never");
        assert_eq!(saved.raw["dataDir"], ".");
        assert!(save(&f.path, &before.revision, &Settings::default()).is_err());
        let mut invalid = next;
        invalid.approval_mode = "invalid".into();
        assert!(invalid.validate().is_err());
    }
    #[test] fn historical_configuration_is_rejected_without_translation() {
        let f = Fixture::new();
        for raw in [json!({"contextWindow":32000}), json!({"wiki":{}}), json!({"llmWiki":{"bundles":[]}}), json!({"scriptEnv":{}}), json!({"mcpServers":{}})] {
            write_json(&f.path, &raw).unwrap(); assert!(read(&f.path).is_err());
        }
    }
    #[test] fn climber_defaults_to_the_local_manufacturer_url_and_validates_overrides() {
        let f = Fixture::new();
        for climber in [json!({"enabled":true,"serviceURL":""}), json!({"serviceURL":"http://localhost/health"}), json!({"serviceURL":"http://user:secret@localhost/api/v1"}), json!({"timeoutMs":99}), json!({"command":"arbitrary"})] {
            write_json(&f.path, &json!({"climber":climber})).unwrap(); assert!(read(&f.path).is_err());
        }
        write_json(&f.path, &json!({"climber":{"enabled":true}})).unwrap();
        assert!(read(&f.path).is_ok());
        let raw = json!({"climber":{"enabled":false,"serviceURL":"http://manufacturer.example:18080/api/v1","timeoutMs":1000}});
        write_json(&f.path, &raw).unwrap(); assert!(read(&f.path).is_ok());
        let mut edited = settings(&f.path, &raw).unwrap(); edited.model = "another-model".into();
        assert_eq!(merged(&f.path, &raw, &edited).unwrap()["climber"], raw["climber"]);
    }
    #[test] fn unchanged_relative_paths_are_preserved_and_runtime_paths_resolved() {
        let f = Fixture::new();
        let raw = json!({"dataDir":"data","llmWiki":{"sources":[{"id":"manuals","type":"directory","path":"docs"}]}});
        let mut edited = settings(&f.path, &raw).unwrap();
        assert_eq!(Path::new(&edited.llm_wiki.sources[0].path), f.root.join("docs"));
        edited.model = "another-model".into();
        let merged = merged(&f.path, &raw, &edited).unwrap();
        assert_eq!(merged["llmWiki"], raw["llmWiki"]);
        edited.llm_wiki.sources.push(TextSource { id: "extra".into(), kind: "file".into(), path: f.root.join("extra.md").to_string_lossy().into_owned() });
        let changed = super::merged(&f.path, &raw, &edited).unwrap();
        assert_eq!(changed["llmWiki"]["sources"][0]["path"], "docs");
        let projected = serde_json::to_value(settings(&f.path, &raw).unwrap()).unwrap();
        assert_eq!(projected["dataDir"], json!(f.root.join("data")));
        assert_eq!(projected["llmWiki"]["sources"][0]["path"], json!(f.root.join("docs")));
    }
    #[test] fn displayed_data_root_is_normalized_without_changing_relative_configuration() {
        let f = Fixture::new();
        let path = f.root.join("./config.json");
        let raw = json!({"dataDir":"."});
        assert_eq!(display_path(&path), f.root.join("config.json"));
        assert_eq!(data_directory(&path, &raw).unwrap(), f.root);
        let values = settings(&path, &raw).unwrap();
        assert_eq!(merged(&path, &raw, &values).unwrap()["dataDir"], ".");
    }
    #[cfg(windows)]
    #[test] fn windows_display_paths_use_native_separators_and_drop_redundant_dots() {
        assert_eq!(display_path(Path::new(r"C:\Users\example\.auto-agent/config.json")), PathBuf::from(r"C:\Users\example\.auto-agent\config.json"));
        assert_eq!(display_path(Path::new(r"C:\Users\example\.auto-agent\.\corax")), PathBuf::from(r"C:\Users\example\.auto-agent\corax"));
        assert_eq!(display_path(Path::new(r"\\?\C:\Users\example\.auto-agent\config.json")), PathBuf::from(r"C:\Users\example\.auto-agent\config.json"));
    }
    #[test] fn stale_save_cannot_overwrite_external_changes() {
        let f = Fixture::new(); ensure(&f.path).unwrap();
        let original = read(&f.path).unwrap();
        let edited = settings(&f.path, &original.raw).unwrap();
        let mut external = original.raw; external["model"] = json!("external");
        write_json(&f.path, &external).unwrap();
        assert!(save(&f.path, &original.revision, &edited).is_err());
        assert_eq!(read(&f.path).unwrap().raw, external);
    }
    #[test] fn invalid_existing_file_is_not_replaced() {
        let f = Fixture::new(); std::fs::write(&f.path, "not json").unwrap();
        ensure(&f.path).unwrap(); assert!(read(&f.path).is_err());
        assert_eq!(std::fs::read_to_string(&f.path).unwrap(), "not json");
    }
    #[test] fn node_loader_accepts_the_same_native_configuration() {
        let f = Fixture::new(); ensure(&f.path).unwrap();
        let output = std::process::Command::new("node")
            .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap())
            .env_remove("AUTO_AGENT_API_KEY").env_remove("AUTO_AGENT_TOKEN").env("CONFIG_TEST_PATH", &f.path)
            .args(["--import", "tsx", "--input-type=module", "-e", "const {loadConfig}=await import('auto-agent/config'); console.log(JSON.stringify(loadConfig(process.env.CONFIG_TEST_PATH)));"])
            .output().expect("Repository tests require Node.js 24+");
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(value["model"], "deepseek-flash");
        assert_eq!(value["maxInputTokens"], 128000);
        assert_eq!(Path::new(value["dataDir"].as_str().unwrap()), f.root);
    }
}
