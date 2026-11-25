## Auto-Agent 2.0 Beta 11

- 现有 Auto-Agent 对话接入自动化仪器的四个批量接口：查询模板、按模板版本和样品管创建实验、查进度及查结果。
- 创建回执未知时，记住原实验编号并阻止同一管重复提交。批次内各项独立返回，较大的测量结果以文件附件提供。
- 设置中的仪器分组显示为 Climber。自动化接入默认关闭，使用前需配置已提供相应接口的仪器后端，见[接入说明](https://github.com/gamstek/auto-agent/blob/v2.0.0-beta.11/docs/automation-phase1/auto-agent-development.md)。

### 安装与升级

Windows x64 下载 `Auto-Agent_2.0.0-beta.11_x64-setup.exe`，或在“关于与诊断”检查 Beta 更新。安装包内置 Node.js；缺少 WebView2 时，安装器会下载其运行时。

若本页提供 macOS DMG，Apple Silicon 请选择 `_aarch64.dmg`，Intel 请选择 `_x64.dmg`。打开 DMG 后将应用拖到 Applications。macOS 更新需手动安装新版本。

同布局升级保留已有配置和数据。从早期不兼容布局升级时，Windows 安装器会对默认 `~/.auto-agent` 执行既有的一次性重置，请先备份需要保留的数据。
