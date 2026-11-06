# Corax 开发接入

使用 npm `@coraxjs/core@0.1.0` 与 Node.js 24+，只使用公开导出。应用与 MCP 使用官方支持的 Node 运行时、node:sqlite；不修改依赖源码或添加私有适配。

## 启动

`pnpm dev` 设置开发配置、项目/数据目录与占用锁，通过 Node 执行标准 Corax dev，保留原生开发交互与后端重载。

`pnpm dev:desktop` 启动 Vite 和 Tauri。Rust 根据公开 `./bin` 导出定位 CLI，直接执行 `node <corax-bin> dev --no-ui`；发布版使用随包 Node 和 corax start。子进程归 Rust 进程树管理。没有中间应用 HTTP 服务。

原生 dev 的预加载和 Nitro worker 使用 Node；应用已撤回 Bun build/start 开发绕行，不为兼容其他运行时修改 SDK 内部实现。目录发现 warning 表示平铺 Agent 根目录中的非 Agent 子目录被忽略，不因切换运行时消失。

开发默认项目内 `.auto-agent/config.json`，生产默认用户目录中的同名配置。缺失时只初始化当前 schema，不转换旧字段或删除旧数据。

## 原生 IPC v4

Rust 以 HTTP Basic 直接连接 `/corax/v1`，凭据不进入 WebView。会话命令走原生 HTTP；初始历史使用 `stream?follow=false`，增量使用 startIndex 和 NDJSON。

backend_watch 经 corax-events 发送事件，watchId 隔离旧订阅，断线只续读。React 使用官方 conversationReducer/toolCallState 生成消息、工具与 turnDetails 投影。

当前会话 refresh 使用 generation/startIndex 读取未见后缀；后端代际变化时返回完整快照。切换会话始终读取 Corax 数据，不使用跨会话缓存。Rust 在短生命周期锁中取得连接并保留写请求，HTTP 等待在锁外完成，避免厂家状态查询或会话就绪等待阻塞其他会话读取。

HTTP409/session_not_ready 是 Corax 明确未受理，普通 send 按官方客户端策略最多等待20秒、250毫秒起退避；其他错误和效果未知不自动重发。开发态仅对超过250毫秒的请求/投影输出不含消息、路径、凭据或会话标识的分段耗时元数据。

channels/desktop.ts 只提供活动状态：在 Corax 进程内读取事件、使用官方 reducer 并识别失效会话，供退出、设置应用和更新检查使用。聊天不经过它代理。

Rust 使用 Windows Job Object 托管子进程树。设置只写 config.json，Corax 的进程内配置在空闲重启后更新。

## 应用层

lib/config 统一管理 schema、路径、IO、进程内快照与数据目录占用锁；lib/wiki 组装通用知识与只读证据集合。桌面传输和 UI 投影分别归 Rust 与 React，见 [应用接入层](application-layer.md)。

lib/climber 用官方 MCP SDK 调用固定 Node stdio 服务，TypeScript CLI 使用固定 tsx loader；工具 schema/说明从 @auto-agent/climber-mcp/contracts 导入，经 tools/climber.ts 动态适配。sam_file 离线可用，climber.enabled 后提供四项设备能力。当前 Corax 原生 MCP connection 只接受 HTTP/SSE，所以这里采用公开工具接口适配，不创建私有 Corax 连接实现。channels/instruments 只提供认证的桌面只读投影。

模型在 step.started 选择 provider，角色在 turn.started 提供。Wiki 是应用补齐的 Agent 通用能力，由 tools/wiki.ts 提供；knowledge 对应用户知识，reference 对应预置只读证据。pnpm llm-wiki 仍是用户文本知识编译的维护 CLI，显式 ingest 才调用模型。没有领域专用资料 Tool、Wiki HTTP channel 或数据库导入。

## 构建与验证

pnpm build 在 Node 下生成 .output；prepare:runtime 将依赖、资料、Node 和安装专用 reset-data 部署到 desktop/src-tauri/runtime，不生成 bridge.mjs 或独立后端 EXE。pnpm 使用共享锁文件和 hoisted 普通目录布局，发布校验拒绝目录链接。产物使用官方 node-server preset，由随包 Node 执行。

tests/corax 使用公开 SDK 与本地假模型；desktop/e2e 使用原生 IPC 事件夹具。旧桥接用例保留在 references。原生窗口联调位于 desktop/tests/native，不属于构建步骤。按任务选择验证，不以 typecheck 代替真实启动。

需要测量本地会话读取时，设置 AUTO_AGENT_PROFILE_CHAT=1 并运行 tests/corax/runtime.test.ts 的 development 用例；仅输出请求状态、字节数和耗时，模型及厂家均为本地模拟。

安装器仅对没有 corax-node-llm-wiki-v1 标识的默认旧布局执行一次重置；更新由 Rust 管理，校验签名并检查活动任务。
