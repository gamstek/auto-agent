fn main() {
    println!("cargo:rerun-if-env-changed=AUTO_AGENT_UPDATER_PUBLIC_KEY");
    tauri_build::build()
}
