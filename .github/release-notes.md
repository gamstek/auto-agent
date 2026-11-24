## Auto-Agent 2.0 Beta 9

- 扩展 SiCOPE 报告分析，搭配聊天中的报告与图片预览查看结果。
- 聊天支持对本地文件执行打开等操作。
- 改进氮气微孔测试模板和 BJH 孔径报告选项。
- 新增 Apple Silicon 和 Intel 的 macOS DMG 构建及安装包验证。正式发布的 macOS 安装包需通过 Developer ID 签名和 Apple 公证。

### 安装与升级

Windows x64 下载 `Auto-Agent_2.0.0-beta.9_x64-setup.exe`，或在“关于与诊断”检查 Beta 更新。安装包内置 Node.js；缺少 WebView2 时，安装器会下载其运行时。

若本页提供 macOS DMG，Apple Silicon 请选择 `_aarch64.dmg`，Intel 请选择 `_x64.dmg`。打开 DMG 后将应用拖到 Applications。macOS 更新需手动安装新版本。

同布局升级保留已有配置和数据。从早期不兼容布局升级时，Windows 安装器会对默认 `~/.auto-agent` 执行既有的一次性重置，请先备份需要保留的数据。
