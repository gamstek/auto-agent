# 当前架构

Node.js 24+、npm `@coraxjs/core`、Tauri 2 与 React。应用、CLI、工具及 MCP 使用 Corax 官方支持的 Node 运行时。

```text
React（官方 reducer 投影）
  └─ Tauri 受限命令 → Rust 认证 HTTP/NDJSON
                        └─ 标准 Corax CLI dev/start（Node）
                             ├─ agent / instructions
                             ├─ tools / channels / skills
                             └─ 会话、工作流、事件与默认工具
```

Corax 管理会话 ID、标题、消息和持久化；应用不另建 Agent 循环或聊天数据库，也没有 Node HTTP 桥接。

开发使用 Corax 原生 dev 和 Vite HMR，生产使用预先构建的产物 start。Bun 仅是部分测试的运行器，不进入应用或桌面安装包。

## 分层

| 路径                                | 职责                                                |
| ----------------------------------- | --------------------------------------------------- |
| agent.ts / instructions.ts          | 动态模型与角色/共享原则                             |
| tools/wiki.ts                       | Agent 通用 Wiki：知识、只读证据与显式摄入           |
| tools/climber.ts                    | MCP 契约驱动的动态 SAM/Climber 工具                 |
| channels/corax.ts                   | 原生 HTTP 与认证                                    |
| channels/desktop.ts                 | 官方 reducer/句柄支持的忙闲检查                     |
| channels/instruments.ts             | 认证的仪器只读投影，禁止设备写入                    |
| lib/config                          | 唯一配置 IO、进程内快照与 Corax 数据目录占用锁      |
| lib/wiki                            | 知识库装配、模型连接、通用只读证据访问              |
| lib/climber                         | 固定 stdio MCP 客户端与临时仪器投影                 |
| packages/climber-mcp                | SAM 完整实现/配置、厂家协议、设备预留与未知写阻断   |
| packages/llm-wiki                   | 文本快照、两阶段知识编译、持久 Markdown、发布与检索 |
| desktop/src-tauri/src/backend.rs    | CLI、进程树、认证和 NDJSON 游标                     |
| desktop/src/lib/corax-projection.ts | 官方 reducer/toolCallState 的 UI 投影               |

旧通用 wiki-core/wiki-sam 位于 docs/history/wiki-indexer，仅保留历史实现，不参与 workspace 或应用发布。

## 能力和指导

能力抽象为 Tool，一系列使用能力的领域指导抽象为 Skill。当前 device-automation 仅有 Climber 这一设备能力，Skill 组织材料判断、Wiki 查证、SAM 准备及登记/启动流程。Wiki 是 Agent 通用基础能力；Corax 当前不原生提供，因此由应用补齐 wiki Tool，供任何 Skill 使用，不属于 Climber MCP 或某个领域 Skill。

模型只看到统一 wiki 工具的资料集合，不再分别暴露 device_reference 与 llm_wiki。两份人工规则属于 Skill references，按需阅读，不做 guidance 操作或另一套查询服务。

## LLM Wiki 与领域资料

LLM Wiki 仅接受 UTF-8 Markdown/TXT：原文 → LLM 分析 → 页面生成/合并。内容在 dataDir/llm-wiki，检索缓存是派生 JSON；原文和 Markdown 页是持久知识，不能当缓存丢弃。按完整版本发布，失败/取消保留之前内容；批次按来源逐项提交并报告 completed。

device-automation 的历史数据库位于 Skill 的 assets/library.sqlite，经 Agent Wiki reference 集合只读查询；人工规则在同一 Skill 的 references/materials，属于指导。用户知识属于 knowledge 集合。两类数据不混入同一摄入流程，不送人工规则/历史库给 LLM 重写，也没有公开数据库路径、SQL 或 SQLite 资料包导入接口。只读查询使用通用元数据 filters，不在 Wiki 工具 schema 中写入产品/气体专用参数。

## Climber MCP 与 SAM

Corax 动态工具 → 官方 MCP SDK stdio 客户端 → 当前 Node + 固定 tsx loader → `@auto-agent/climber-mcp/cli`。Corax 的公开原生 MCP connection 只支持 HTTP/SSE；应用以公开 defineTool/defineDynamic 适配标准 stdio，不使用私有 SDK 或增加 HTTP 桥。工具定义与 schema 由 MCP 包导出，应用不复制厂家协议或 SAM 逻辑。

sam_file 始终提供 profiles/inspect/compare/create/modify/save-as。配置 climber.enabled 与显式厂家 URL 后，才提供四项设备工具。每次调用拥有固定 stdio 子进程并在 finally 关闭，无连接时不阻塞启动；数据和预留由 MCP 保存在 dataDir/climber。稳定 session/call 身份经受信 MCP metadata 注入；模型不能提供这些字段，操作者 reconcile_operation 不进入 Agent 工具列表。

SAM 路径属于 MCP 执行宿主，不是虚拟文件系统。默认输出为用户主目录下 Auto-Agent/templates；桌面发行版用随包 Node。SAM 调用限30秒，JSON 参数限16384字节，完整回执限60000字节；stdio 帧限256 KiB，诊断限16 KiB，不截断配置。子进程只传系统路径与固定部署参数，不继承凭据/用户加载钩子；Node 默认不自动读取 .env。设备预算覆盖状态前置检查与厂家写入各一次；失败/取消不自动重试，未知文件写先核对路径/哈希，未知设备写按原批次/操作核对。

## 配置与发布

开发配置为项目内 .auto-agent/config.json，生产为 ~/.auto-agent/config.json。相对路径从配置文件解析。Corax 数据在 dataDir/corax，用户知识在 dataDir/llm-wiki。Rust 传原配置路径，Node 使用进程内快照；忙碌时保存，空闲后重启应用。

Rust 转发原始事件，React 使用官方投影；重连只续读、不重发写。Windows Job Object 持有进程树，退出/更新前检查工作。

发布资源白名单只包含应用、生产依赖、固定资料、Node 和安装脚本，不含用户数据或凭据。布局标识保持 corax-node-llm-wiki-v1，运行时切换不触发额外清理。仅安装器处理旧布局切换；普通启动不删除或迁移数据。更新由 Rust 校验签名后安装。
