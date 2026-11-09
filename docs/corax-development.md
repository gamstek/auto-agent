# Corax 开发接入

使用 npm `@coraxjs/core@0.1.0` 与 Node.js 24+，只使用公开导出。应用与 MCP 使用官方支持的 Node 运行时、node:sqlite；不修改依赖源码或添加私有适配。

## 启动

`pnpm dev` 设置开发配置、项目/数据目录与占用锁，通过 Node 执行标准 Corax `dev --resume`，保留原生开发交互与后端重载。恢复由 Corax 负责，应用不复制会话或重放发送请求；设备未知写入仍由 MCP 的持久记录阻断。

`pnpm dev:desktop` 启动 Vite 和 Tauri。Rust 根据公开 `./bin` 导出定位 CLI，直接执行 `node <corax-bin> dev --no-ui --resume`；发布版使用随包 Node 和 corax start。子进程归 Rust 进程树管理。没有中间应用 HTTP 服务。

`--resume` 是官方支持的开发恢复参数：缺省的新 dev 调用不会恢复先前调用保留的运行。它能恢复仍有有效运行快照的会话，不能复活已经取消或缺失快照的会话。当前 `@coraxjs/core@0.1.0` 会清理超过保留数量且退役超过宽限时间的开发快照；依赖已清理快照的运行会被框架取消，聊天历史仍可能保留，但不再受理消息。该版本没有公开的快照保留配置，应用不修改其私有清理逻辑；完整解决需上游保留仍被会话引用的快照或安全转移执行归属。

原生 dev 的预加载和 Nitro worker 使用 Node。应用内容集中在独立 workspace 包 `corax/`，本页的 agent、sandbox、lib、tools、channels、skills 路径均相对该目录。CLI 和 Rust 都以 `corax/` 为项目根目录，避免 Corax 的递归开发监听扫描相邻的 `desktop/src-tauri/target`。该包保留 `auto-agent` 名称，仓库根包改名 `auto-agent-workspace`；源码移动不改变会话身份。

开发默认仓库根目录 `.auto-agent/config.json`，生产默认用户目录中的同名配置。根目录可选 `.env` 通过 Node `--env-file-if-exists` 载入，环境变量优先；不复制到发布资源。缺失时只初始化当前 schema，不转换旧字段或删除旧数据。

## 原生 IPC v4

Rust 以 HTTP Basic 直接连接 `/corax/v1`，凭据不进入 WebView。会话命令走原生 HTTP；初始历史使用 `stream?follow=false`，增量使用 startIndex 和 NDJSON。

backend_watch 经 corax-events 发送事件，watchId 隔离旧订阅，断线只续读。React 使用官方 conversationReducer/toolCallState 生成消息、工具与 turnDetails 投影。

当前聊天视图使用临时 viewId：backend_chat_open/close 的短命令在前端串行提交，历史读取与 backend_watch 绑定该视图。切换会话、断线或组件卸载会终止旧视图的在途 HTTP 读取和事件订阅；迟到的 close/watch 不影响新的选择。该生命周期仅持有读取传输，不取消 Corax 任务、不清除受理记录；跨会话展示投影由独立的前端有界缓存持有。日志用 cancelled 标记正常切换导致的读取取消。

当前会话 refresh 使用 generation/startIndex 读取未见后缀；后端代际变化时返回完整快照。切回已打开会话时复用进程内的官方投影，立即显示缓存历史，再同步未读后缀；非当前项按 LRU 限制为 16 个会话与 64 MiB 估算内存。缓存展示不代表本次视图已就绪或仍在执行，同步成功后才开放写入；失效与清空边界见 [应用接入层](application-layer.md)。Rust 在短生命周期锁中取得连接并保留写请求，HTTP 等待在锁外完成，避免厂家状态查询或会话就绪等待阻塞其他会话读取。

HTTP409/session_not_ready 是 Corax 明确未受理，普通 send 按官方客户端策略最多等待20秒、250毫秒起退避；其他错误和效果未知不自动重发。开发态分段耗时保存到 dataDir/corax/logs/desktop-debug.log，不含消息、路径、凭据或会话标识，最多保留两个 2 MiB 文件。

channels/desktop.ts 提供活动状态和只读动态工具目录：在 Corax 进程内读取事件、使用官方 reducer 并识别失效会话，供退出、设置应用和更新检查使用；目录复用真实工具注册定义。聊天不经过它代理。

Rust 使用 Windows Job Object 托管子进程树。设置只写 config.json，Corax 的进程内配置在空闲重启后更新。

## 应用层

lib/config 统一管理 schema、路径、IO、进程内快照与数据目录占用锁；lib/wiki 组装通用知识与只读证据集合。桌面传输和 UI 投影分别归 Rust 与 React，见 [应用接入层](application-layer.md)。

lib/climber 用官方 MCP SDK 调用固定 Node stdio 服务，TypeScript CLI 使用固定 tsx loader；工具 schema/说明从 @auto-agent/climber-mcp/contracts 导入，经 tools/climber.ts 动态适配。sam_file 离线可用，climber.enabled 后提供四项设备能力。当前 Corax 原生 MCP connection 只接受 HTTP/SSE，所以这里采用公开工具接口适配，不创建私有 Corax 连接实现。channels/instruments 只提供认证的桌面只读投影。

模型在 step.started 选择 provider，角色在 turn.started 提供。Wiki 是应用补齐的 Agent 通用能力，由 tools/wiki.ts 提供；knowledge 对应用户知识，reference 对应预置只读证据。pnpm llm-wiki 仍是用户文本知识编译的维护 CLI，显式 ingest 才调用模型。桌面用户知识库通过 channels/knowledge 的固定认证路由复用同一编译引擎和只读页面接口；不提供领域专用资料 Tool 或数据库导入。

sandbox.ts 显式导出 environment 和公开 defineSandbox selector，lib/host 使用公开 defineSandboxProvider 与 ShellJS 实现宿主进程/文件 I/O；不替换 Corax 原生工具。prepare 只生成可搬迁的空准备产物，不依赖个人模板缓存；start/resume 连接当前数据目录的真实 workspace，关闭不删除宿主文件。Windows 需可发现的 Git Bash，继承宿主环境而非虚拟解释器。

## 构建与验证

pnpm build 在 Node 下生成 corax/.output；prepare:runtime 按 corax/package.json 的白名单部署 auto-agent 包、依赖、资料、Node 和安装专用 reset-data 到 desktop/src-tauri/runtime。发布目录保持平铺的应用布局，不嵌套第二层 corax；pnpm 使用共享锁文件和 hoisted 普通目录布局，发布校验拒绝目录链接。产物使用官方 node-server preset，由随包 Node 执行。

tests/corax 使用公开 SDK 与本地假模型；desktop/e2e 使用原生 IPC 事件夹具。旧桥接用例保留在 references。原生窗口联调位于 desktop/tests/native，不属于构建步骤。按任务选择验证，不以 typecheck 代替真实启动。

需要测量本地会话读取时，设置 AUTO_AGENT_PROFILE_CHAT=1 并运行 tests/corax/runtime.test.ts 的 development 用例；仅输出请求状态、字节数和耗时，模型及厂家均为本地模拟。

安装器仅对没有 corax-node-llm-wiki-v1 标识的默认旧布局执行一次重置；更新由 Rust 管理，校验签名并检查活动任务。
