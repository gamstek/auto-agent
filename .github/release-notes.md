## Auto-Agent 2.0 Beta 1

首个 Windows 桌面预发布版本，采用 **Tauri 2 + React + TypeScript**，随安装包提供独立的本地 Agent 后端。CLI 和 HTTP 集成方式继续保留。

### Windows 桌面端

- 自定义标题栏与窗口控制：拖动、双击最大化/还原、最小化、关闭；关闭窗口收起至悬浮助手，右键悬浮助手可退出应用。
- 统一蓝色主题和共用组件，导航/会话选中态一致；支持侧栏与页面过渡、键盘即时操作和减少动态效果模式，列表与反馈按钮无按压缩放。
- 聊天、会话历史、Markdown表格、流式回复/思考、工具过程、取消、复制和本机反馈标记；常见问题单击即发送。
- 设置页按模型、设备、技能/知识库、运行参数与诊断分组。文本防抖自动保存，开关/目录立即保存，离开设置仍继续保存，无保存按钮或未保存确认。
- 后端工作期间允许保存设置，空闲后再应用，避免打断当前任务。未知执行结果保留操作者对账入口，重连不自动重发写请求。
- 模型 API Key 保存至操作系统凭据库，前端不读取已保存的明文 Key；桌面配置与CLI数据分开管理。
- WebView通过受限本地命令访问后端，后端使用本机动态端口和随机Bearer令牌，不向页面暴露令牌或任意shell/文件访问能力。

### 安装与启动

| 用途                   | 下载文件                                |
| ---------------------- | --------------------------------------- |
| Windows x64 桌面安装包 | `Auto-Agent_2.0.0-beta.1_x64-setup.exe` |
| Windows x64 CLI        | `auto-agent.exe`                        |
| Linux x64 CLI          | `auto-agent`                            |

**桌面用户请下载安装包。** 安装后在“设置 → 模型连接”中填写服务地址、模型名称和 API Key。无需安装 Bun、Node.js 或 Rust；Windows缺少WebView2时，安装引导会下载运行时，需要网络。

默认桌面数据目录为 `%APPDATA%\com.gamstek.autoagent`，不自动读取CLI的 `~/.auto-agent` 配置。已有CLI用户如需使用相同模型/厂家地址，请在桌面设置中填写；不要复制模型Key到配置JSON。

当前桌面安装与原生联调范围是Windows x64，Linux下载文件仍为CLI。本版本未提供自动更新或代码签名；独立知识浏览页、诊断包导出等后续能力尚未加入。配置参考和本地mock测试不等于真实仪器验收。

### CLI / HTTP

```powershell
$env:AUTO_AGENT_API_KEY = '替换为模型服务的 API Key'
.\auto-agent.exe
```

```bash
chmod +x ./auto-agent
export AUTO_AGENT_API_KEY='替换为模型服务的 API Key'
./auto-agent
```

HTTP服务使用 `serve`，仍需设置独立的 `AUTO_AGENT_TOKEN`。默认端口4096；桌面自身使用动态本机端口。首次CLI运行创建 `~/.auto-agent/config.json`，已有配置不被覆盖。

新增鉴权的 `/runtime` 和 `/session/{id}/state` 用于桌面断线恢复。只有受桌面管理的后端启用关闭入口，运行中的任务阻止退出或重启。

详细配置与开发说明见 [README](https://github.com/gamstek/auto-agent#readme) 和 [桌面说明](https://github.com/gamstek/auto-agent/blob/v2.0.0-beta.1/desktop/README.md)。

---
