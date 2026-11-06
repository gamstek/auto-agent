# Auto-Agent 桌面端

Tauri 2 + React。Rust 直接管理 Corax CLI 生命周期、认证 HTTP/NDJSON、系统凭据库、配置保存和签名更新；WebView 使用受限原生命令并负责会话投影，不直接访问任意网络、shell 或数据库。

## 开发

需要 Node.js 24+、pnpm 10.15.1、Rust 工具链及 Tauri 平台依赖；Bun 1.4.2 仅用于部分测试。

```powershell
pnpm install --frozen-lockfile
pnpm dev:desktop
```

开发模式由 Rust 使用系统 Node 调用 npm `@coraxjs/core` 的标准 `corax dev --no-ui`，保留后端原生重载与前端 Vite HMR。没有额外应用 HTTP 桥接或旧后端 EXE。

组件位于 `src/components/<Name>/<Name>.tsx` 并导入同目录 CSS；App 负责页面组合，theme.css 负责 tokens，styles.css 负责共享重置和可访问性。

## 配置与数据

正式版配置为 `~/.auto-agent/config.json`，开发版与 CLI dev 使用项目内同名目录；启动只创建缺失的新配置。相对路径从配置目录解析。Corax 会话/日志在 dataDir/corax，用户知识内容在 dataDir/llm-wiki。Node 固定进程内配置，不另写一份运行配置。

配置包含模型/角色/容量、dataDir 和 `llmWiki: {sources}`。LLM Wiki 页只选择 UTF-8 Markdown/TXT 文件或目录，没有 SQLite 资料包或内置库开关。添加来源只保存设置，生效后明确要求助手 ingest，或用 CLI 摄入，才会调用模型生成知识页。设置保存校验 revision 并保留相对路径，忙碌时保存、空闲后应用。

API Key 来自 `AUTO_AGENT_API_KEY` 或系统凭据库；不返回已保存的 Key 明文。后端的随机传输令牌只在 Rust 和 Node 子进程之间使用。

调试时可给桌面程序传入 `--config <path>`，或以 `--data-dir <absolute-directory>` 隔离配置与运行数据。两者互斥。不要将个人配置用于测试。

## 聊天与能力

前后端共享 `packages/desktop-protocol` v4。Rust 从原生 NDJSON 流按游标转发事件，经 `corax-events` 原生事件交给 React；React 使用官方 conversationReducer、toolCallState 处理正文、思考、Skill、工具、人工输入和任务，不建立桌面会话数据库。

首次启动在 StartupScreen 等待后端、健康、协议和会话列表检查；后续断线保留工作空间并读取状态恢复，不重放写请求。关闭/Alt+F4 先空闲安全地停止后端再退出，只有悬浮助手动作隐藏窗口。

设置只显示实际生效的能力。当前没有设备后端能力，因此仪器导航禁用；领域 Skill 和独立 MCP 包的存在不代表已连接仪器。

## 后端资源与安装器

```powershell
pnpm prepare:backend
pnpm desktop:build
```

prepare-backend 白名单部署 Corax 产物、生产依赖与技能（含 device-automation/assets 下的历史证据），编译安装器专用 reset-data，并附带 Node 与许可证。用户 LLM Wiki、.env 和凭据不会打包。发布模式使用随包 Node 直接启动标准 corax start，MCP 复用同一 Node 及固定 tsx loader。

生产部署单独设置 pnpm `virtual-store-dir-max-length=24`，缩短带 peer 依赖标识的虚拟目录名，避免 NSIS 在读取资源时超过 Windows MAX_PATH。该设置保留共享锁文件和应用依赖版本，不改变开发环境的 node_modules 布局。

“设置 → 仪器连接”配置 Climber 厂家 /api/v1 地址、超时和启用状态；忙碌时保存、空闲后重启应用。生产依赖包含 climber-mcp 及其完整 SAM 配置；固定 Node stdio MCP 处理文件与设备操作。仪器页只读调用 get_status，经认证 channel 与 Rust 白名单返回；WebView 不能调用登记、启动或任意 MCP 工具。未知设备写入记录由 MCP 保存在 dataDir/climber。

Windows currentUser NSIS 安装仅在默认旧目录没有 corax-node-llm-wiki-v1 标识时清理并初始化，后续同布局安装保留数据；正常启动和开发不会清理个人目录。

## 更新

“关于与诊断”提供检查更新、下载与安装、诊断包导出。更新采用 Rust Tauri updater，固定 GitHub stable/Beta feed；先下载并验证签名，再在生命周期锁内复查任务是否空闲并安装。

发布版本需要 `AUTO_AGENT_UPDATER_PUBLIC_KEY` 与 `TAURI_SIGNING_PRIVATE_KEY`，可选私钥密码。`release:build` 生成签名安装包与 latest.json；CI 发布版本 Release 和渠道 feed。开发构建缺少公钥时明确报告不可更新。当前更新包仅支持 Windows x64。

## 检查

```powershell
pnpm --filter auto-agent-desktop run typecheck
pnpm desktop:test
cargo test --manifest-path desktop/src-tauri/Cargo.toml --locked
```

Playwright 使用 Vite 与原生桥 mock；Corax 集成验收在根 tests/corax，使用真实 npm 运行时及本地假模型。完整发布资源验收见根 README。

原生窗口联调脚本在 `tests/native/smoke.ts`，使用隔离目录和本地假模型，手动运行 `pnpm --filter auto-agent-desktop run smoke:native`，前提是已有当前版本桌面构建。它不属于构建步骤或默认测试入口。
