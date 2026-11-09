# 当前架构

Node.js 24+、npm `@coraxjs/core`、Tauri 2 与 React。应用、CLI、工具及 MCP 使用 Corax 官方支持的 Node 运行时。

```text
React（官方 reducer 投影）
  └─ Tauri 受限命令 → Rust 认证 HTTP/NDJSON
                        └─ 标准 Corax CLI dev/start（Node）
                             ├─ agent / instructions / memory
                             ├─ tools / channels / skills
                             └─ 会话、工作流、事件与默认工具
```

Corax 管理会话 ID、标题、消息和持久化；应用不另建 Agent 循环或聊天数据库，也没有 Node HTTP 桥接。

开发使用 Corax 原生 dev 和 Vite HMR，生产使用预先构建的产物 start。Bun 仅是部分测试的运行器，不进入应用或桌面安装包。

## 分层

Corax authored 内容位于独立 workspace 包 `corax/`，下表中的 agent、instructions、sandbox、memory、tools、channels 和 lib 路径均相对此目录。开发 CLI 的 CWD 和项目根目录只指向该包，桌面构建产物不进入其递归监听范围。`corax/package.json` 保留 `auto-agent` 身份与发布白名单，仓库根包仅负责工作区命令和验证。

| 路径                                | 职责                                                |
| ----------------------------------- | --------------------------------------------------- |
| agent.ts / instructions.ts          | 动态模型与角色/共享原则                             |
| memory.ts                           | Corax 原生长期记忆、稳定本地用户作用域              |
| sandbox.ts / lib/host               | 公开 Corax Provider、ShellJS 宿主进程与真实文件 I/O |
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
| desktop/src-tauri/src/corax.rs      | CLI、进程树、认证和 NDJSON 游标                     |
| desktop/src/lib/corax-projection.ts | 官方 reducer/toolCallState 的 UI 投影               |

旧通用 wiki-core/wiki-sam 位于 docs/history/wiki-indexer，仅保留历史实现，不参与 workspace 或应用发布。

## 能力和指导

能力抽象为 Tool，一系列使用能力的领域指导抽象为 Skill。当前 device-automation 仅有 Climber 这一设备能力，Skill 组织材料判断、Wiki 查证、SAM 准备及登记/启动流程。Wiki 是 Agent 通用基础能力；Corax 当前不原生提供，因此由应用补齐 wiki Tool，供任何 Skill 使用，不属于 Climber MCP 或某个领域 Skill。

模型只看到统一 wiki 工具的资料集合，不再分别暴露 device_reference 与 llm_wiki。两份人工规则属于 Skill references，按需阅读，不做 guidance 操作或另一套查询服务。

## 跨会话长期记忆

`memory.ts` 通过公开 `defineMemory` 和 `fileMemory({ backend: sqliteMemory(...) })` 接入 Corax 原生召回、保存和删除工具。持久文件为 `dataDir/corax/memory.sqlite`；固定 namespace=`auto-agent`、scope=`local-user`，同一数据目录跨会话、进程重启和安装资源迁移保持身份，不依赖随机传输令牌。不同 dataDir 使用各自的文件。

Corax 在新一轮开始及上下文压缩完成时召回，默认记忆文本上限 4000 字符。内容包括本地用户的稳定仪器背景、长期测试需求、带适用范围的已确认实验要求，以及用户明确要求延续的项目简短目标、约束和持久资料引用。完整方案与结果保留在实际文件中，明确授权后才整理进用户知识库。聊天记录、展示缓存、Wiki 知识、配置和设备未知写入仍由各自模块拥有，不从记忆推断执行状态或取得本次操作授权。没有应用自建记忆数据库实现、额外模型调用链或桌面数据库接口。

## LLM Wiki 与领域资料

LLM Wiki 仅接受 UTF-8 Markdown/TXT：原文 → LLM 分析 → 页面生成/合并。内容在 dataDir/llm-wiki，检索缓存是派生 JSON；原文和 Markdown 页是持久知识，不能当缓存丢弃。按完整版本发布，失败/取消保留之前内容；批次按来源逐项提交并报告 completed。

device-automation 的历史数据库位于 Skill 的 assets/library.sqlite，经 Agent Wiki reference 集合只读查询；人工规则在同一 Skill 的 references/materials，属于指导。用户知识属于 knowledge 集合。两类数据不混入同一摄入流程，不送人工规则/历史库给 LLM 重写，也没有公开数据库路径、SQL 或 SQLite 资料包导入接口。只读查询使用通用元数据 filters，不在 Wiki 工具 schema 中写入产品/气体专用参数。

## Climber MCP 与 SAM

Climber 的研发别称为 G5，SiCOPE 的研发别称为 G12；命名对应关系不新增仪器类型。SAM 参数和历史资料保留 g5/g12 标识，各自版本与格式独立。`sam_file` 是两款产品共享的文件能力，当前已实现的厂家控制适配仍仅为 Climber，不把 SiCOPE 文件支持解释为 SiCOPE 控制支持。

Corax 动态工具 → 官方 MCP SDK stdio 客户端 → 当前 Node + 固定 tsx loader → `@auto-agent/climber-mcp/cli`。Corax 的公开原生 MCP connection 只支持 HTTP/SSE；应用以公开 defineTool/defineDynamic 适配标准 stdio，不使用私有 SDK 或增加 HTTP 桥。工具定义与 schema 由 MCP 包导出，应用不复制厂家协议或 SAM 逻辑。

sam_file 始终提供 profiles/inspect/compare/create/modify/save-as。配置 climber.enabled 与显式厂家 URL 后，才提供四项设备工具。每次调用拥有固定 stdio 子进程并在 finally 关闭，无连接时不阻塞启动；数据和预留由 MCP 保存在 dataDir/climber。稳定 session/call 身份经受信 MCP metadata 注入；模型不能提供这些字段，操作者 reconcile_operation 不进入 Agent 工具列表。

SAM 路径属于 MCP 执行宿主，使用其原生绝对路径，不能直接把 Shell 的 POSIX 别名当作厂家路径。默认输出为用户主目录下 Auto-Agent/templates；桌面发行版用随包 Node。SAM 调用限30秒，JSON 参数限16384字节，完整回执限60000字节；stdio 帧限256 KiB，诊断限16 KiB，不截断配置。MCP 子进程只传系统路径与固定部署参数，不继承凭据/用户加载钩子；Node 默认不自动读取 .env。设备预算覆盖状态前置检查与厂家写入各一次；失败/取消不自动重试，未知文件写先核对路径/哈希，未知设备写按原批次/操作核对。

## 宿主环境

`sandbox.ts` 用公开 defineSandbox/defineSandboxProvider 绑定 ShellJS。Bash/read_file/write_file 等仍是 Corax 原生工具；适配只发生在 Provider 的进程和文件 I/O 边界。执行真实宿主 Bash，继承 PATH 等宿主变量，Windows 使用 Git Bash；不回退 JustBash，也不把 ShellJS 当解释器。工作目录 dataDir/workspace 为真实文件目录，Skill 资源路径映射到当前应用资源，不写入个人全局 skills 目录；关闭句柄只停止自己持有的命令，不删除工作文件。

## 配置与发布

开发配置为项目内 .auto-agent/config.json，生产为 ~/.auto-agent/config.json。相对路径从配置文件解析。Corax 数据在 dataDir/corax，用户知识在 dataDir/llm-wiki。Rust 传原配置路径，Node 使用进程内快照；忙碌时保存，空闲后重启应用。

Rust 转发原始事件，React 使用官方投影；重连只续读、不重发写。Windows Job Object 持有进程树，普通退出/更新前检查工作。交互退出忙碌或状态未知时，Rust 提供继续运行/强制关闭确认；只有明确确认可强制结束自有进程树，更新和设置重启不使用该例外，未知写入仍需核对。

发布资源白名单只包含应用、生产依赖、固定资料、Node 和安装脚本，不含用户数据或凭据。布局标识保持 corax-node-llm-wiki-v1，运行时切换不触发额外清理。仅安装器处理旧布局切换；普通启动不删除或迁移数据。更新由 Rust 校验签名后安装。
