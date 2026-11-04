# Auto-Agent 桌面端

Windows 优先的 Tauri 2 + React + TypeScript 桌面客户端。整体采用自定义标题栏、窄导航栏、会话侧栏和独立圆角内容区。量仔视觉来自用户提供的设计稿；运行时图片独立存于 `src/assets/`，不导入文档目录。头像已经去除切图自带的关闭符号和标签，按钮与文字由组件独立绘制。

## 开发与打包

需要系统 Bun 1.4.2、Node.js 22+、Rust stable、Visual Studio C++ Build Tools 与 WebView2。

在仓库根目录运行：

```powershell
pnpm install --frozen-lockfile
pnpm desktop:dev
```

开发命令自动编译当前公共后端为 sidecar，再启动 Vite 与 Tauri。前端开发服务器只绑定 `127.0.0.1:1420`，排除 Rust 构建目录的文件监听。

修改 Agent 后端源码后，需要在任务结束后正常退出当前桌面及开发命令，再运行 `pnpm desktop:dev`。Vite 热更新、页面刷新和重新连接不会更新正在运行的 sidecar；Rust 自动重编译也不会重新执行启动前的 Bun 后端构建。界面通过后端健康接口的能力声明检查运行图和历史思考支持，旧后端会给出明确提示。

```powershell
pnpm desktop:build
```

Windows 安装包输出：`desktop/src-tauri/target/release/bundle/nsis/Auto-Agent_<version>_x64-setup.exe`。安装包带独立公共后端与内置技能/Wiki；无需安装 Bun 或 Node。WebView2 缺失时安装引导程序会下载运行时，需要网络。当前安装器配置以 Windows NSIS 为验收目标，Linux/macOS 桌面尚未完成安装与运行验收。

只看界面可运行 `pnpm --filter auto-agent-desktop dev`；普通浏览器不会调用本地后端，也不能保存设置。完整功能请使用 Tauri 窗口。桌面使用根目录 pnpm 工作区锁文件，不单独安装依赖。

## 已实现

- 欢迎页与常见问题入口；问题单击即发送并进入对话，连接未就绪时不可发送。
- 会话创建、最近会话、消息分页、流式回答和思考、Markdown/GFM表格、工具步骤、取消、复制和本机反馈标记。
- 设置中的「技能」与「知识库」分别管理各自的内置开关和来源目录。
- 思考内容与回答分开保存，结束、失败或切换会话重新加载后仍可展开查看；多轮模型思考按顺序保留。
- 聊天页「运行图」展示 LangGraph 实际拓扑和调用状态，按节点查看脱敏后的最终模型请求、上下文和工具定义；支持历史运行、摘要调用与只读实时刷新。详见 [运行检查说明](../docs/run-inspection.md)。
- 会话列表滚动条贴齐侧栏右侧，每批加载50条，接近底部自动加载下一批；支持失败重试和ID去重，标题/任务状态刷新保留已加载的列表范围。列表由 `SessionList` 组件和 `hooks/useSessions.ts` 分别管理展示与分页请求。
- 右上角关闭、Alt+F4及悬浮助手菜单的“退出应用”都会正常停止后端并退出软件。仅侧栏专门的“收起至悬浮助手”入口用于隐藏窗口，主界面不放置额外电源按钮。
- 主窗口禁用原生标题栏；自定义标题栏提供拖动、双击最大化/还原、最小化、最大化/还原和关闭。关闭时检查后端任务，工作中不直接终止进程；快速重复关闭不会启动重复退出流程。更改Rust窗口配置后需要重启桌面进程，不是仅刷新前端。
- 设置：模型地址/名称、系统凭据库中的API Key、厂家接口、模板目录、外部资源根、内置资源开关、预算/超时和角色提示词。
- 设置页面替换左侧会话导航，提供分类搜索；右侧采用统一的行式控件与分组分隔线。设置自动保存：文本输入700ms防抖、失焦立即提交，开关和目录选择立即提交。没有保存按钮、未保存提示或离开确认；切回聊天后保存流程继续。
- 左侧工作区面板保持静止，不做位移或淡入淡出；收起时右侧内容面板用220ms向左覆盖，遮盖完成后才隐藏左侧，展开时反向揭开。位移与实际宽度同步变化，固定最右侧边缘，不缩放内容或露出右侧空白。右侧页面和分类切换使用160ms位移/透明度过渡。键盘触发及prefers-reduced-motion下即时切换。页面使用透明轨道与细圆角滑块的自定义滚动条。
- 有任务或索引更新执行时，后端拒绝退出/重启。设置仍会先保存到本机，桌面层待空闲后应用最新配置；不会中断当前任务或自动重发任务。
- 事件流断线重连后，从状态快照和消息记录恢复；未知执行显示对账说明及操作者核对入口。
- 导航项、按钮、输入框、搜索框和开关分别由 `src/components/` 下的功能组件管理，蓝色设计变量统一位于 `src/theme.css`。会话和设置的选中态相同；列表项及喜欢/不喜欢等按钮没有按压缩放。Ctrl+, 打开设置，Ctrl+B 切换侧栏，Ctrl+N 新建对话，Esc 从设置返回聊天。

## 模块边界

组件统一放在 `src/components/<ComponentName>/`，目录、组件文件和样式文件使用相同的 PascalCase 名称，例如 `Button/Button.tsx` 与 `Button/Button.css`。组件自行导入同目录样式；断点与交互状态跟随所属组件。`App.tsx` / `App.css` 负责应用组合和外层布局；`styles.css` 只负责全局 reset、滚动条和无障碍规则，`theme.css` 集中设计变量。

通用组件按功能直接引用 `Button/Button`、`IconButton/IconButton`、`Input/Input`、`Textarea/Textarea`、`Switch/Switch`、`NavigationItem/NavigationItem`、`SearchField/SearchField`。`SettingsSection/SettingsSection` 提供设置分组和行布局，设置页与更新/诊断区域复用；说明文案使用正常文档流和间距，不使用负 margin 拼接。欢迎页、对话容器、Markdown 回复、反馈操作、悬浮助手等展示组件也各自维护实现和样式。

```text
src/                 React UI、桌面桥接、设置表单与样式
src-tauri/src/       Rust：窗口、系统凭据、配置、后端进程、HTTP/SSE桥接
scripts/             公共sidecar构建、隔离原生联调
e2e/                 Playwright UI测试（模拟Tauri桥接，不调用真实模型）
../src/              Bun Agent：业务、SQLite、技能执行、模型、Wiki
```

WebView 只调用固定 Tauri commands，不持有后端访问令牌，不直接连接本机HTTP端口或读写SQLite。Markdown不执行原始HTML，外部链接由受限打开命令处理。Rust只代理白名单API路径，不提供任意命令执行接口。sidecar始终绑定127.0.0.1动态端口，使用每次启动生成的随机Bearer凭据。

## 数据与配置

CLI 与桌面默认直接读写 **`~/.auto-agent/config.json`**，Windows 即 `%USERPROFILE%\.auto-agent\config.json`。文件不存在时创建 CLI 格式的默认配置；不读取、不导入、不迁移旧桌面 `settings.json`。

- 设置页是公共配置的编辑界面。“启用 Climber MCP”显式创建 MCP/设备配置；已配置后，厂家地址和超时编辑首台 Climber 的 `mcpServers` 项，模板目录仍映射到 `scriptEnv.SAM_OUTPUT_DIR`。关闭开关保留配置并禁用连接，不代表停止仪器。保存只更新改动字段，保留 `interpreters`、并发/输出限额、其它 MCP 及未展示的配置项；多设备高级配置可直接编辑共享文件。
- `dataDir`、`skillRoots`、`wikiRoots`、`wikiIndexRoots` 相对公共配置所在目录解析，与 CLI 一致。默认 `dataDir: "."`，因此两端使用同一份会话、执行审计和知识数据。已有配置优先，不另建桌面数据副本。
- `%APPDATA%\com.gamstek.autoagent\backend.json` 仅是每次启动生成的运行快照，不是设置来源。它保持公共配置的业务字段，临时覆盖桌面所需的 loopback 地址、动态端口和认证；这些覆盖不会写回公共配置。
- 自动保存使用配置修订号检测外部修改。冲突时保留编辑内容并提示“重新读取配置”，不覆盖外部更新。重新进入没有未保存编辑的设置页也会读取最新配置。外部修改在重启后生效；桌面自身保存仍按空闲时重启的规则应用。
- 模型凭据优先使用桌面进程继承的 `AUTO_AGENT_API_KEY`，否则使用系统凭据库；前端不获取密钥内容。CLI 仍从 `AUTO_AGENT_API_KEY` 读取。密钥不写入公共配置，桌面不读取 `.env`。

后端仍保留数据目录独占保护：**桌面与 CLI 不能同时启动两个后端占用同一 `dataDir`**。先正常退出一个再启动另一个；本次共享配置不增加自动附着或抢占已有进程的行为。保存外部资源目录不会自动扫描模板或调用付费知识提取；显式维护在退出桌面后直接使用 CLI 的同一公共配置。

`auto-agent-desktop.exe --config <路径>` 可选择另一份现有公共配置（相对路径从启动目录解析）。测试隔离使用 `--data-dir <绝对路径>`：运行文件和凭据归属该目录，默认配置为该目录下的 `config.json`，不会访问用户默认配置；若同时指定 `--config`，以显式配置为准。后端意外退出不重放请求；父进程 stdin EOF 请求正常清理。软件退出/取消不等于仪器停止。

## 验证

```powershell
pnpm typecheck
pnpm test
pnpm --filter auto-agent-desktop typecheck
pnpm desktop:test
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

## 签名更新与诊断包

设置 → 关于与诊断提供检查更新、版本说明、下载进度和诊断 ZIP 导出。更新由 Rust 的官方 Tauri updater 下载并验证签名，WebView 不能指定下载地址或公钥。下载完成后再次检查后端任务，并通过正常关闭接口停止后端；忙时拒绝安装。Windows 安装程序启动会退出应用。

含预发布后缀的构建固定使用 Beta 渠道，正式版固定使用稳定渠道，不自动切换渠道或降级。渠道清单分别位于本仓库 Releases 的 `desktop-beta/latest.json` 和 `desktop-stable/latest.json`，安装包指向具体版本的 Release。

发布前由维护者使用 Tauri `signer generate` 在仓库外生成并备份密钥。在 GitHub 配置：

- Repository variable `AUTO_AGENT_UPDATER_PUBLIC_KEY`：公钥文件内容。
- Repository secret `TAURI_SIGNING_PRIVATE_KEY`：私钥内容。
- Repository secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：私钥密码。

Tag CI 强制要求签名配置，调用 `release:build` 生成安装包、`.sig` 和 `latest.json`，版本发布成功后更新相应渠道清单。请按版本递增顺序发布同一渠道。普通本地构建不要求私钥；没有编译期公钥时，检查更新会明确提示手动安装。公钥由构建时嵌入，不能从用户配置或运行环境替换。

现有 `v2.0.0-beta.1` 没有更新器，首次迁移到带更新器的版本需要手动安装。更新签名并非 Windows Authenticode 代码签名，不能消除 SmartScreen 的未签名发行者提示。签名密钥和首次签名发布尚需部署配置。

诊断包使用原生保存对话框，仅导出版本/平台、数值配置摘要和 `agent.jsonl` / `skills.jsonl` 及各三个轮转文件的白名单元数据（每文件最多 2 MiB）。仅保留已知事件名、时间、UUID 关联标识及允许的数值/布尔字段；不导出自由文本、原始错误、路径、URL、模型名称、提示词、聊天、数据库、凭据或脚本输出。无法解析的日志行会跳过。取消保存不生成文件。

## 后续迭代

“仪器”页已接入后端 Climber MCP，只读展示实际返回的状态、批次/实验与最后成功查询时间，并区分过期、厂家不可达和 MCP 断连。页面轮询不调用模型，离开页面后停止。无配置时通过“配置仪器”进入设备连接设置。源码和 mock 验证进度见 [实施状态](../docs/device-platform/progress.md)；持久化流程、常驻服务和定时运行仍待开发。

仪器页面、卡片、详情分别由 `Instruments`、`InstrumentCard`、`InstrumentDetails` 管理，`useInstruments` 负责读取和订阅。应用状态发生变化时，SSE 发送 `extension.changed` 提示；页面只 GET 最新快照，不因收到提示再次 POST 刷新。连接恢复后重新读取快照，事件没有重放；周期性只读轮询保留为兜底。页面隐藏或卸载后不继续请求，订阅清理不会影响聊天事件。

独立知识库浏览页和 Windows 代码签名尚未实现。当前引用通过模型返回的Markdown展示；不会伪造来源文件、追问建议或设备状态。喜欢/不喜欢仅作为本机标记，不声称已上传训练或评价服务。
