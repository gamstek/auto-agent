use super::*;
use sha2::{Digest, Sha256};
use std::io::Write;

const FIELDS: &[&str] = &["model", "baseURL", "builtinSkills", "builtinWiki", "skillRoots", "wikiRoots", "wikiIndexRoots", "maxSteps", "maxInputTokens", "maxOutputTokens", "modelTimeoutMs", "scriptTimeoutMs", "webAllowPrivateAddresses", "systemPrompt"];

pub struct Document { pub raw: Value, pub revision: String }
pub fn read(path: &Path) -> Result<Document, String> {
    let bytes = std::fs::read(path).map_err(|_| "无法读取共享 config.json")?;
    let raw: Value = serde_json::from_slice(&bytes).map_err(|_| "共享 config.json 必须是有效 JSON 对象")?;
    if !raw.is_object() { return Err("共享 config.json 必须是 JSON 对象".into()); }
    Ok(Document { raw, revision: format!("{:x}", Sha256::digest(&bytes)) })
}
fn resolve(path: &Path, value: &str) -> String {
    let value = Path::new(value);
    if value.is_absolute() { value.to_path_buf() } else { path.parent().unwrap().join(value) }.to_string_lossy().into_owned()
}
pub fn data_directory(path: &Path, raw: &Value) -> Result<PathBuf, String> {
    let value = raw.get("dataDir").map(|v| v.as_str().ok_or("dataDir 必须为字符串")).transpose()?;
    // The selected default config explicitly uses '.', just like the CLI-generated file.
    let default = std::env::home_dir().ok_or("无法定位用户目录")?.join(".auto-agent");
    Ok(value.map(|s| PathBuf::from(resolve(path, s))).unwrap_or(default))
}
pub fn settings(path: &Path, raw: &Value) -> Result<Settings, String> {
    let mut projection = serde_json::to_value(Settings::default()).unwrap();
    for field in FIELDS { if let Some(value) = raw.get(*field) { projection[*field] = value.clone(); } }
    if raw.get("maxInputTokens").is_none() {
        if let Some(window) = raw.get("contextWindow") {
            let input = window.as_u64().and_then(|w| w.checked_sub(projection["maxOutputTokens"].as_u64()?)).filter(|n| *n > 0).ok_or("contextWindow 必须容纳输入和输出容量")?;
            projection["maxInputTokens"] = json!(input);
        }
    }
    if let Some(env) = raw.get("scriptEnv") {
        let env = env.as_object().ok_or("scriptEnv 必须是字符串映射")?;
        if env.values().any(|v| !v.is_string()) { return Err("scriptEnv 必须是字符串映射".into()); }
        if let Some(url) = env.get("CLIMBER_SERVICE_URL") { projection["manufacturerUrl"] = url.clone(); }
        if let Some(timeout) = env.get("CLIMBER_TIMEOUT_MS") {
            projection["manufacturerTimeoutMs"] = json!(timeout.as_str().unwrap().parse::<u64>().map_err(|_| "CLIMBER_TIMEOUT_MS 必须是正整数")?);
        }
        if let Some(directory) = env.get("SAM_OUTPUT_DIR") { projection["templateDirectory"] = directory.clone(); }
    }
    let mut settings: Settings = serde_json::from_value(projection).map_err(|_| "共享配置字段类型无效")?;
    for roots in [&mut settings.skill_roots, &mut settings.wiki_roots, &mut settings.wiki_index_roots] {
        for root in roots.iter_mut() { *root = resolve(path, root); }
    }
    // Script environment values retain their original meaning; relative SAM_OUTPUT_DIR
    // is interpreted from the config directory by the desktop sidecar working directory.
    if !settings.template_directory.is_empty() { settings.template_directory = resolve(path, &settings.template_directory); }
    Ok(settings)
}
pub fn merged(path: &Path, raw: &Value, next: &Settings) -> Result<Value, String> {
    let before = serde_json::to_value(settings(path, raw)?).unwrap();
    let after = serde_json::to_value(next).unwrap();
    let mut result = raw.clone();
    for field in FIELDS {
        if before[*field] != after[*field] { result[*field] = after[*field].clone(); }
    }
    if raw.get("contextWindow").is_some() && before["maxOutputTokens"] != after["maxOutputTokens"] {
        result["maxInputTokens"] = after["maxInputTokens"].clone();
    }
    for (setting, name) in [("manufacturerUrl", "CLIMBER_SERVICE_URL"), ("manufacturerTimeoutMs", "CLIMBER_TIMEOUT_MS"), ("templateDirectory", "SAM_OUTPUT_DIR")] {
        if before[setting] == after[setting] { continue; }
        if result.get("scriptEnv").is_none() { result["scriptEnv"] = json!({}); }
        if setting == "templateDirectory" && next.template_directory.is_empty() {
            result["scriptEnv"].as_object_mut().unwrap().remove(name);
        } else {
            result["scriptEnv"][name] = if setting == "manufacturerTimeoutMs" { json!(next.manufacturer_timeout_ms.to_string()) } else { after[setting].clone() };
        }
    }
    if let Some(window) = result.get("contextWindow") {
        let projected = settings(path, &result)?;
        if window.as_u64().and_then(|n| n.checked_sub(projected.max_output_tokens)).is_none_or(|input| projected.max_input_tokens > input) {
            return Err("输入/输出容量超过共享配置中的 contextWindow，请调整容量或编辑配置文件".into());
        }
    }
    Ok(result)
}
pub fn ensure(path: &Path) -> Result<(), String> {
    if path.exists() { return Ok(()); }
    std::fs::create_dir_all(path.parent().ok_or("配置路径无效")?).map_err(|_| "无法创建配置目录")?;
    let defaults = Settings::default();
    let mut raw = json!({"dataDir":".", "host":"127.0.0.1", "port":4096, "allowRemote":false,
        "interpreters": {".js":"node", ".sh":"bash", ".ps1":"powershell.exe"},
        "scriptEnv": {"CLIMBER_SERVICE_URL": defaults.manufacturer_url, "CLIMBER_TIMEOUT_MS": defaults.manufacturer_timeout_ms.to_string()}});
    let settings = serde_json::to_value(defaults).unwrap();
    for field in FIELDS { raw[*field] = settings[*field].clone(); }
    match std::fs::OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(mut file) => file.write_all(&serde_json::to_vec_pretty(&raw).unwrap()).map_err(|_| "无法创建共享配置".into()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(_) => Err("无法创建共享配置".into()),
    }
}
pub fn save(path: &Path, revision: &str, next: &Settings) -> Result<String, String> {
    let document = read(path)?;
    if document.revision != revision { return Err("共享配置已被外部修改，请重新读取配置后再编辑".into()); }
    let merged = merged(path, &document.raw, next)?;
    write_json(path, &merged)?;
    Ok(read(path)?.revision)
}
pub fn runtime(path: &Path, raw: &Value) -> Result<Value, String> {
    let mut result = raw.clone();
    result["dataDir"] = json!(data_directory(path, raw)?);
    // Only transport belongs to the desktop lifecycle; never persist these overrides.
    result["host"] = json!("127.0.0.1"); result["port"] = json!(0); result["allowRemote"] = json!(false);
    result.as_object_mut().unwrap().remove("token");
    result.as_object_mut().unwrap().remove("apiKey");
    for field in ["skillRoots", "wikiRoots", "wikiIndexRoots"] {
        if let Some(roots) = result.get_mut(field) {
            for root in roots.as_array_mut().ok_or("资源目录必须是数组")? {
                *root = json!(resolve(path, root.as_str().ok_or("资源目录必须是字符串")?));
            }
        }
    }
    Ok(result)
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
    #[test] fn default_is_cli_shaped_and_ignores_old_desktop_settings() {
        let fixture = Fixture::new();
        std::fs::write(fixture.root.join("settings.json"), "{\"model\":\"old-desktop\"}").unwrap();
        ensure(&fixture.path).unwrap();
        let document = read(&fixture.path).unwrap();
        assert_eq!(document.raw["model"], "deepseek-flash");
        assert_eq!(document.raw["dataDir"], ".");
        assert_eq!(document.raw["port"], 4096);
        assert!(document.raw.get("manufacturerUrl").is_none());
        assert_eq!(document.raw["scriptEnv"]["CLIMBER_TIMEOUT_MS"], "5000");
        ensure(&fixture.path).unwrap();
        assert_eq!(read(&fixture.path).unwrap().revision, document.revision);
    }
    #[test] fn edits_preserve_unexposed_fields_and_relative_paths() {
        let fixture = Fixture::new();
        let raw = json!({"model":"cli-model", "dataDir":"data", "skillRoots":["skills"], "wikiRoots":["wiki"],
            "port":4098, "host":"localhost", "outputLimitBytes":123456, "maxConcurrent":2,
            "interpreters": {".js":"builtin"}, "scriptEnv":{"CLIMBER_SERVICE_URL":"http://localhost:18080/api/v1", "CUSTOM":"keep"}});
        write_json(&fixture.path, &raw).unwrap();
        let document = read(&fixture.path).unwrap();
        let mut next = settings(&fixture.path, &document.raw).unwrap();
        assert_eq!(next.model, "cli-model");
        assert!(Path::new(&next.skill_roots[0]).is_absolute());
        next.model = "desktop-model".into();
        next.manufacturer_timeout_ms = 9000;
        save(&fixture.path, &document.revision, &next).unwrap();
        let result = read(&fixture.path).unwrap().raw;
        let mut expected = raw;
        expected["model"] = json!("desktop-model");
        expected["scriptEnv"]["CLIMBER_TIMEOUT_MS"] = json!("9000");
        assert_eq!(result, expected);
    }
    #[test] fn stale_autosave_never_overwrites_external_changes() {
        let fixture = Fixture::new(); ensure(&fixture.path).unwrap();
        let original = read(&fixture.path).unwrap();
        let mut edited = settings(&fixture.path, &original.raw).unwrap(); edited.model = "draft".into();
        let mut external = original.raw; external["model"] = json!("external");
        write_json(&fixture.path, &external).unwrap();
        assert!(save(&fixture.path, &original.revision, &edited).unwrap_err().contains("外部修改"));
        assert_eq!(read(&fixture.path).unwrap().raw, external);
    }
    #[test] fn runtime_resolves_shared_paths_and_keeps_transport_overrides_ephemeral() {
        let fixture = Fixture::new();
        let raw = json!({"dataDir":"data", "skillRoots":["skills"], "wikiIndexRoots":["index"], "host":"0.0.0.0", "port":7000,
            "allowRemote":true, "token":"private", "apiKey":"ignored", "resourceLimitBytes":5555,
            "interpreters":{}, "scriptEnv":{"CUSTOM":"value"}});
        write_json(&fixture.path, &raw).unwrap();
        let result = runtime(&fixture.path, &raw).unwrap();
        assert_eq!(result["dataDir"], json!(fixture.root.join("data")));
        assert_eq!(result["skillRoots"][0], json!(fixture.root.join("skills")));
        assert_eq!(result["host"], "127.0.0.1"); assert_eq!(result["port"], 0);
        assert!(result.get("token").is_none()); assert!(result.get("apiKey").is_none());
        assert_eq!(result["resourceLimitBytes"], 5555); assert_eq!(result["interpreters"], json!({}));
        assert_eq!(read(&fixture.path).unwrap().raw, raw);
    }
    #[test] fn derived_capacity_and_unrelated_script_env_are_preserved() {
        let fixture = Fixture::new();
        let raw = json!({"contextWindow":32000, "maxOutputTokens":8000, "scriptEnv":{"CUSTOM":"keep", "SAM_OUTPUT_DIR":"templates"}});
        let mut next = settings(&fixture.path, &raw).unwrap();
        assert_eq!(next.max_input_tokens, 24000);
        next.max_steps = 30;
        let result = merged(&fixture.path, &raw, &next).unwrap();
        assert!(result.get("maxInputTokens").is_none());
        assert_eq!(result["scriptEnv"], raw["scriptEnv"]);
        next.template_directory.clear();
        let result = merged(&fixture.path, &raw, &next).unwrap();
        assert_eq!(result["scriptEnv"], json!({"CUSTOM":"keep"}));
        next.max_output_tokens = 16000;
        assert!(merged(&fixture.path, &raw, &next).is_err());
    }
    #[test] fn malformed_shared_config_is_not_replaced() {
        let fixture = Fixture::new();
        std::fs::write(&fixture.path, "not json").unwrap();
        ensure(&fixture.path).unwrap();
        assert!(read(&fixture.path).is_err());
        assert_eq!(std::fs::read_to_string(&fixture.path).unwrap(), "not json");
    }
    #[test] fn cli_loader_reads_desktop_edits_from_the_same_file() {
        let fixture = Fixture::new(); ensure(&fixture.path).unwrap();
        let document = read(&fixture.path).unwrap();
        let mut edited = settings(&fixture.path, &document.raw).unwrap();
        edited.model = "shared-model-test".into(); edited.manufacturer_timeout_ms = 9000;
        save(&fixture.path, &document.revision, &edited).unwrap();
        let output = std::process::Command::new("bun")
            .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap())
            .env_remove("AUTO_AGENT_API_KEY").env_remove("AUTO_AGENT_TOKEN")
            .env("CONFIG_TEST_PATH", &fixture.path)
            .args(["-e", "const {loadConfig}=await import('./src/config/index.ts'); const c=await loadConfig(process.env.CONFIG_TEST_PATH,false,true); console.log(JSON.stringify({model:c.model,dataDir:c.dataDir,port:c.port,timeout:c.scriptEnv.CLIMBER_TIMEOUT_MS}));"])
            .output().expect("Repository tests require system Bun");
        assert!(output.status.success(), "CLI must accept the shared desktop config");
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(value["model"], "shared-model-test");
        assert_eq!(value["port"], 4096);
        assert_eq!(value["timeout"], "9000");
        assert_eq!(value["dataDir"], json!(fixture.root));
    }
}
