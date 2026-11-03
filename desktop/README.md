# Auto-Agent 桌面端

Windows 优先的 Tauri 2 + React + TypeScript 桌面客户端。整体采用自定义标题栏、窄导航栏、会话侧栏和独立圆角内容区。量仔视觉来自用户提供的设计稿；运行时图片独立存于 `src/assets/`，不导入文档目录。头像已经去除切图自带的关闭符号和标签，按钮与文字由组件独立绘制。

## 开发与打包

需要系统 Bun 1.4.2、Node.js 22+、Rust stable、Visual Studio C++ Build Tools 与 WebView2。

在仓库根目录运行：

```powershell
bun install --frozen-lockfile
bun install --cwd desktop --frozen-lockfile
bun run desktop:dev
```

开发命令自动编译当前公共后端为 sidecar，再启动 Vite 与 Tauri。前端开发服务器只绑定 `127.0.0.1:1420`，排除 Rust 构建目录的文件监听。

```powershell
bun run desktop:build
```

Windows 安装包输出：`desktop/src-tauri/target/release/bundle/nsis/Auto-Agent_<version>_x64-setup.exe`。安装包带独立公共后端与内置技能/Wiki；无需安装 Bun 或 Node。WebView2 缺失时安装引导程序会下载运行时，需要网络。当前安装器配置以 Windows NSIS 为验收目标，Linux/macOS 桌面尚未完成安装与运行验收。

只看界面可在 desktop 下运行 `bun run dev`；普通浏览器不会调用本地后端，也不能保存设置。完整功能请使用 Tauri 窗口。

## 已实现

- 欢迎页与常见问题入口；问题单击即发送并进入对话，连接未就绪时不可发送。
- 会话创建、最近会话、消息分页、流式回答和思考、Markdown/GFM表格、工具步骤、取消、复制和本机反馈标记。
- 右上角关闭窗口时收起至悬浮助手；悬浮助手可恢复主窗口，右键菜单提供“退出应用”，主界面不放置额外电源按钮。
- 主窗口禁用原生标题栏；自定义标题栏提供拖动、双击最大化/还原、最小化、最大化/还原和关闭。关闭收起窗口，明确退出仍检查后端任务。更改Rust窗口配置后需要重启桌面进程，不是仅刷新前端。
- 设置：模型地址/名称、系统凭据库中的API Key、厂家接口、模板目录、外部资源根、内置资源开关、预算/超时和角色提示词。
- 设置页面替换左侧会话导航，提供分类搜索；右侧采用统一的行式控件与分组分隔线。设置自动保存：文本输入700ms防抖、失焦立即提交，开关和目录选择立即提交。没有保存按钮、未保存提示或离开确认；切回聊天后保存流程继续。
- 侧栏使用220ms可中断FLIP位移/缩放，页面和分类切换使用160ms位移/透明度过渡；键盘触发及prefers-reduced-motion下即时切换。页面使用透明轨道与细圆角滑块的自定义滚动条。
- 有任务或索引更新执行时，后端拒绝退出/重启。设置仍会先保存到本机，桌面层待空闲后应用最新配置；不会中断当前任务或自动重发任务。
- 事件流断线重连后，从状态快照和消息记录恢复；未知执行显示对账说明及操作者核对入口。
- 导航项、图标按钮、普通按钮、输入框、搜索框和开关共用 `src/components/ui.tsx` 与蓝色设计变量。会话和设置的选中态相同；列表项及喜欢/不喜欢等按钮没有按压缩放。Ctrl+, 打开设置，Ctrl+B 切换侧栏，Ctrl+N 新建对话，Esc 从设置返回聊天。

## 模块边界

```text
src/                 React UI、桌面桥接、设置表单与样式
src-tauri/src/       Rust：窗口、系统凭据、配置、后端进程、HTTP/SSE桥接
scripts/             公共sidecar构建、隔离原生联调
e2e/                 Playwright UI测试（模拟Tauri桥接，不调用真实模型）
../src/              Bun Agent：业务、SQLite、技能执行、模型、Wiki
```

WebView 只调用固定 Tauri commands，不持有后端访问令牌，不直接连接本机HTTP端口或读写SQLite。Markdown不执行原始HTML，外部链接由受限打开命令处理。Rust只代理白名单API路径，不提供任意命令执行接口。sidecar始终绑定127.0.0.1动态端口，使用每次启动生成的随机Bearer凭据。

## 数据与配置

默认使用系统应用数据目录 `com.gamstek.autoagent`，Windows通常为 `%APPDATA%\com.gamstek.autoagent`，与CLI的 `~/.auto-agent` 独立。

- `settings.json`：可编辑设置，不含模型Key。
- `backend.json`：桌面层生成的实际后端配置，绑定本机动态端口、独立dataDir。
- `data/`：会话、执行审计、知识快照和日志。
- 模型Key：操作系统凭据库，按应用数据目录隔离；前端读取设置只得到“是否已保存”，不返回Key。

桌面端不会读取 `.env` 或使用 private 包。首次使用请在设置页保存模型Key。保存外部资源目录不会自动扫描模板或调用付费知识提取；显式维护可在退出桌面后，使用后端CLI指定该目录下的backend.json运行相应更新命令。

可使用 `auto-agent-desktop.exe --data-dir <绝对路径>` 指定隔离数据目录；同一应用标识仍采用单实例。后端意外退出后不会自动重放请求。父进程意外终止时，后端通过私有stdin管道EOF启动清理；软件退出/取消不等于仪器停止。

## 验证

```powershell
bun run typecheck
bun test
bun run --cwd desktop typecheck
bun run --cwd desktop test:ui
cargo test --manifest-path desktop/src-tauri/Cargo.toml
```

UI测试在Windows使用已安装的Microsoft Edge；其它环境需安装对应Playwright Chromium。截图位于 `desktop/test-results`，被Git忽略。

原生验收脚本会启动真实Tauri/WebView2和公共sidecar，以独立临时目录、本地模拟模型和测试Key验证：启动、配置/系统凭据保存、聊天、窗口收起恢复、页面刷新恢复会话、清除测试Key及正常退出。不使用真实模型或仪器。

在 desktop 目录执行（先构建带 `custom-protocol` 的独立测试标识应用，避免影响正在运行的开发窗口）：

```powershell
$env:TAURI_CONFIG = '{"identifier":"com.gamstek.autoagent.smoke"}'
try {
  cargo build --manifest-path src-tauri/Cargo.toml --target-dir src-tauri/target/smoke --features custom-protocol
} finally {
  Remove-Item Env:\TAURI_CONFIG
}
bun scripts/smoke-native.ts src-tauri/target/smoke/debug/auto-agent-desktop.exe
```

脚本通过仅该次启动设置的WebView2调试参数连接测试窗口，报告和截图保存在系统临时目录的opencode子目录。正式启动不启用调试端口。原生验收需要可交互的Windows桌面。

## 后续迭代

独立知识库浏览页、诊断包导出、在线自动更新和安装包签名尚未实现。当前引用通过模型返回的Markdown展示；不会伪造来源文件、追问建议或设备状态。喜欢/不喜欢仅作为本机标记，不声称已上传训练或评价服务。
