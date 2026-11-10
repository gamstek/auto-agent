# Auto-Agent 桌面端

Tauri 2 + React。Rust 直接管理 Corax CLI 生命周期、认证 HTTP/NDJSON、系统凭据库、配置保存和签名更新；WebView 使用受限原生命令并负责会话投影，不直接访问任意网络、shell 或数据库。

## 开发

需要 Node.js 24+、pnpm 10.15.1、Rust 工具链及 Tauri 平台依赖；Bun 1.4.2 仅用于部分测试。

```powershell
pnpm install --frozen-lockfile
pnpm dev:desktop
```

开发模式由 Rust 使用系统 Node 调用 npm `@coraxjs/core` 的标准 `corax dev --no-ui --resume`，保留后端原生重载与前端 Vite HMR。`--resume` 恢复仍有有效快照的既有开发运行；当前 Corax 的旧快照清理仍可能终止所依赖的运行，详见 [开发接入](../docs/corax-development.md)。没有额外应用 HTTP 桥接或旧后端 EXE。

Corax 开发项目根目录是仓库的 `corax/`，只包含其 authored 内容与依赖；桌面 Cargo 产物在该目录之外，避免递归监听导致冷启动 I/O 拥塞。开发配置与可选 `.env` 仍在仓库根目录，生产资源由 `corax/package.json` 白名单部署到原有 `src-tauri/runtime` 布局。

开发态聊天分段耗时自动写入启动时 `dataDir/corax/logs/desktop-debug.log`（默认项目 `.auto-agent/corax/logs/desktop-debug.log`），也可从“设置 → 关于与诊断 → 打开日志”进入该目录。日志包含发送受理、生命周期锁/提交锁等待、活动检查、HTTP 响应、历史读取/投影、订阅首事件和列表刷新；仅记录固定阶段标签、数字与布尔状态，不记录消息、会话 ID、路径或凭据。每个文件上限 2 MiB，保留一份 `desktop-debug.previous.log`；正式构建不写入。修改 Rust 后需重启开发桌面进程再复现。

组件位于 `src/components/<Name>/<Name>.tsx` 并导入同目录 CSS；App 负责页面组合，theme.css 负责 tokens，styles.css 负责共享重置和可访问性。

## 配置与数据

正式版配置为 `~/.auto-agent/config.json`，开发版与 CLI dev 使用项目内同名目录；启动只创建缺失的新配置。相对路径从配置目录解析。Corax 会话/日志在 dataDir/corax，用户知识内容在 dataDir/llm-wiki。Node 固定进程内配置，不另写一份运行配置。

长期记忆使用 Corax 原生工具，存于 dataDir/corax/memory.sqlite。同一数据目录的新会话及重启后自动召回用户的稳定事实与偏好，包括仪器背景、长期测试需求、带适用范围的已确认实验要求，以及用户明确要求延续的项目简短目标、约束和持久资料引用。随机传输令牌或安装目录变化不改变其作用域。可在聊天中要求记住或忘记；删除记忆与删除聊天记录彼此独立。完整方案和结果保留在实际文件中，明确授权后才整理进用户知识库。记忆不保存当前设备状态、执行回执、临时任务参数或凭据，不构成执行授权，也不参与桌面写入受理判断。

配置包含模型/角色/容量、dataDir 和 `llmWiki: {sources}`。“用户知识库”添加 UTF-8 Markdown/TXT 文件或目录后只保存来源；设置生效后显式点击“开始整理”，才调用当前模型生成知识页。页面显示待整理/已整理/需要更新、实际分析与发布阶段、已完成数量及知识页预览。取消等待实际终态并保留已发布内容，移除来源不删除已有知识。设置保存校验 revision 并保留相对路径，忙碌时保存、空闲后应用。

桌面通过 Rust 白名单访问认证的 `channels/knowledge.ts`：来源检查与分页阅读只读，开始整理绑定当前配置 revision 和后端 generation，取消绑定具体操作 ID。编译过程复用 LLM Wiki 引擎，不执行聊天 Agent 或设备工具；只保留单个进程内编译状态。运行中、取消中和受理结果未知均保护设置重启及更新的空闲停止；交互退出始终先提示并由用户确认。状态丢失后核对既有发布内容，不自动重放摄入。

API Key 来自 `AUTO_AGENT_API_KEY` 或系统凭据库；不返回已保存的 Key 明文。后端的随机传输令牌只在 Rust 和 Node 子进程之间使用。

是否需要 API Key 由实际模型服务决定，不根据服务商或模型名在桌面端硬编码拦截。无需认证的本地或自建兼容模型服务允许不填 Key；模型服务返回 HTTP 401/403 时会明确提示检查服务地址、凭据和模型访问权限。

宿主执行使用 ShellJS 与真实 Bash（Windows 为 Git Bash），保留 Corax 原生工具。Rust 启动 Corax 时继承宿主环境；命令子进程不携带应用私有的传输令牌和模型 Key。文件可直接访问真实宿主，默认工作目录为 dataDir/workspace；Provider 关闭不会删除这些文件。没有 JustBash 模板的首启准备或个人缓存拷贝。

调试时可给桌面程序传入 `--config <path>`，或以 `--data-dir <absolute-directory>` 隔离配置与运行数据。两者互斥。不要将个人配置用于测试。

## 聊天与能力

前后端共享 `packages/desktop-protocol` v4。Rust 从原生 NDJSON 流按游标转发事件，经 `corax-events` 原生事件交给 React；React 使用官方 conversationReducer、toolCallState 处理正文、思考、Skill、工具、人工输入和任务，不建立桌面会话数据库。

选中会话的历史请求和事件订阅绑定临时视图，切换聊天或断线会释放旧订阅、取消尚未完成的旧历史读取。取消读取只关闭桌面持有的 HTTP/订阅传输，不等于取消 Corax 后台任务或设备操作。调试日志中正常切换对应 cancelled。

首次启动在 StartupScreen 等待后端、健康、协议和会话列表检查；后续断线保留工作空间并读取状态恢复，不重放写请求。主窗口/悬浮窗关闭、Alt+F4、菜单退出和原生退出命令共用 Rust 退出链路：每次立即弹出“关闭应用 / 继续运行”的原生确认，说明本地任务会中断、已下发的仪器任务可能继续运行，未确认写入需重新核对。弹窗前不查询后台活动、不扫描历史，也不等待生命周期锁。继续运行或关闭对话框不取消任务；明确选择关闭应用后才结束本应用持有的 Corax 进程树。确认期间不持有生命周期锁，允许只读同步并阻止新写入；设置重启和更新安装仍只在空闲时进行。只有悬浮助手动作隐藏窗口。

强制关闭不向厂家发送 stop 或撤销命令，也不清除设备未知写入记录；已下发的仪器任务可能继续运行，重新使用前应读取并核对实际状态。

设置只显示实际生效的能力。当前没有设备后端能力，因此仪器导航禁用；领域 Skill 和独立 MCP 包的存在不代表已连接仪器。

## 后端资源与安装器

```powershell
pnpm prepare:runtime
pnpm build:desktop
```

prepare-runtime 白名单部署 Corax 产物、生产依赖与技能（含 device-automation/assets 下的历史证据）到 `src-tauri/runtime`，编译安装器专用 reset-data，并附带 Node 与许可证。依赖通过 pnpm 共享锁文件部署为普通目录，避免 NSIS 丢失目录链接。用户 LLM Wiki、.env 和凭据不会打包。发布模式使用随包 Node 直接启动标准 corax start，MCP 复用同一 Node 及固定 tsx loader。

在仓库根目录执行 `pnpm test:installer` 可使用 7-Zip 解包实际安装包，在隔离目录验证生产启动及 Wiki/SAM/MCP，并验证同布局覆盖安装清除旧 `backend` 和 `auto-agent-backend.exe`、保留用户数据。该检查不运行安装器，不更改真实安装目录或注册表。

Workspace 启用 `injectWorkspacePackages`，支持 pnpm 基于共享锁文件进行冻结部署；仅发布目录使用 `node-linker=hoisted`，开发环境继续使用默认的 isolated 布局。发布时移除依赖 sourcemap 和 `node_modules/.bin` 命令快捷方式（Linux 符号链接、Windows shims），保留源码、声明、许可证和原生/WASM 资源。运行时通过固定 Node 入口启动 CLI/MCP，不依赖 `.bin`；其余资源仍严格拒绝符号链接或目录链接。

“设置 → 仪器”配置 Climber 厂家 /api/v1 地址、超时和启用状态；默认开启，地址为 `http://127.0.0.1:18080/api/v1`，旧配置地址为空时显式启用会填入该默认地址。已有配置保留保存的启用状态与地址。忙碌时保存、空闲后重启应用。生产依赖包含 climber-mcp 及其完整 SAM 配置；固定 Node stdio MCP 处理文件与设备操作。仪器页只读调用 get_status，经认证 channel 与 Rust 白名单返回；WebView 不能调用登记、启动或任意 MCP 工具。未知设备写入记录由 MCP 保存在 dataDir/climber。

“工具”展示 Auto-Agent 当前注册的工具与动态工具，过滤 Corax 框架内置项；“技能”展示 Corax 官方运行信息中的实际目录。Climber 动态工具复用模型注册时的同一份配置化定义。内置项为只读状态，不提供禁用操作。Rust 只投影名称、说明和来源，不向 WebView 转发完整提示词、技能正文、schema 或内部文件绑定。“用户知识库”支持分别选择文件和文件夹；“数据目录”展示解析后的应用 dataDir 根目录，Corax 数据位于其 corax 子目录。

Windows currentUser NSIS 安装仅在默认旧目录没有 corax-node-llm-wiki-v1 标识时清理并初始化，后续同布局安装保留数据；正常启动和开发不会清理个人目录。

## 更新

“关于与诊断”提供检查更新、下载与安装、诊断包导出。更新采用 Rust Tauri updater，固定 GitHub stable/Beta feed；下载前不查询后台活动或获取生命周期锁，先下载并验证签名，再阻止新写入，在生命周期锁内执行一次空闲保护停止后安装。界面区分下载进度、验签完成后的后台核验和安装启动阶段。后台不可读、忙碌或有未知受理时不安装，明确提示“已下载并通过签名校验，但尚未启动安装”，不把只读核验失败描述成消息写入结果未知。

发布版本需要 `AUTO_AGENT_UPDATER_PUBLIC_KEY` 与 `TAURI_SIGNING_PRIVATE_KEY`，可选私钥密码。`build:release` 生成签名安装包与 latest.json；CI 发布版本 Release 和渠道 feed。开发构建缺少公钥时明确报告不可更新。当前更新包仅支持 Windows x64。

## 检查

```powershell
pnpm --filter auto-agent-desktop run typecheck
pnpm desktop:test
cargo test --manifest-path desktop/src-tauri/Cargo.toml --locked
```

Playwright 使用 Vite 与原生桥 mock；Corax 集成验收在根 tests/corax，使用真实 npm 运行时及本地假模型。完整发布资源验收见根 README。

原生窗口联调脚本在 `tests/native/smoke.ts`，使用隔离目录和本地假模型，手动运行 `pnpm --filter auto-agent-desktop run smoke:native`，前提是已有当前版本桌面构建。它不属于构建步骤或默认测试入口。
