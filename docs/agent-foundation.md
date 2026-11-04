# Agent 基座梳理

状态：第一轮基座重构已落地；下方第 2–7 节保留重构前审阅依据与目标，不代表所有问题仍未处理。工作流、定时、常驻服务及跨设备扩展暂缓。Wiki 下一步重构设计见 [wiki-redesign.md](./wiki-redesign.md)。

## 本轮实施

- `agent/runner.ts`：独立 LangGraph 循环，通过 `RunnerPorts` 注入模型、工具、历史、提示词、checkpoint、证据和事件；不构造 Wiki/Skill/MCP/Store。
- `agent/index.ts`：应用门面保留提交、并发、取消与终态管理；维护任务和标题移至 `agent/tasks.ts`，对账展示移至 `agent/review.ts`。仓储查询不再散落 SQL。
- `tool/executor.ts`：内置与 MCP 共享调用事件、错误归类和有界证据落盘入口。`ToolResult` 分离执行 status 与 effect（none/acknowledged/unknown）；unknown 优先停止依赖，不代表外部效果撤销。
- `agent/context.ts`：保留规则来自当前工具目录；知识结果字段形状由工具自己判断，动态 MCP 工具也通过同一入口保留证据。
- `llm/index.ts`：不再默认创建工具清单，不引用标题/Wiki 提示词；`complete` 统一工具无关请求。流式结果传回 finishReason，不完整响应停止依赖工具。既有 positional `generate` 和 `summarize` 适配接口暂保留，Runner 使用 request 对象接口。
- `storage/index.ts`：原子 `beginTurn/completeRun/failRun`；`store-10-tool-evidence` 将有界脱敏证据关联到终态消息，跨轮加载和摘要包含这些记录，不借此恢复 Skill 加载权限。
- 终态存储失败保留原始错误并停止接收新任务；未知操作落盘失败按未知处理。启动失败关闭已创建服务和 Store，服务关闭幂等；流式跨分片脱敏移至共享模块。
- 脚本诊断使用有界通用投影，不再挑选业务字段名称。

新增 `tests/integration/foundation.test.ts` 覆盖终态事务回滚、不完整模型输出、跨轮证据/加载隔离、证据写入失败与终态持久化失败。边界测试限制 Runner、上下文及模型网关对应用实现的依赖。

本轮验证：`pnpm typecheck` 全工作区通过；`pnpm test` 根项目 364 通过、9 跳过，Climber 包 3 通过、桌面工具测试 1 通过。没有进行本轮桌面安装包构建或真机验证。

仍需在后续 Wiki 重构中收敛：应用门面目前仍组装 Wiki 与 MCP；Wiki 维护依赖其既有 API，解析索引仍借用 Store 数据库。工具目录仍有内置/MCP 两种提供者适配器；它们共享运行端口，但尚未扩展成第三方任意插件加载机制。通用日志/证据投影是有界观察摘要，不是完整原文档案，也不是科学或外部执行成功证明。

## 1. 基座应负责什么

基座负责：接受一次用户请求、准备上下文、调用模型、执行已注册工具、记录结果，直到回答完成、预算耗尽、取消或出现必须停止的结果。

它不需要知道某个 Skill 名称、设备品牌、厂家命令或业务流程 ID。具体领域知识由 Skill 提供，外部能力由 MCP 服务实现，页面展示属于应用层。

四个基本对象需要分清：

| 对象             | 职责                                             |
| ---------------- | ------------------------------------------------ |
| Session          | 长期会话身份及历史记录                           |
| Run / Generation | 一次用户提交的执行生命周期、取消信号和预算       |
| Model turn       | 一次模型请求及其文字、工具调用、用量和结束原因   |
| Tool operation   | 一次工具调用的身份、执行意图、结果和外部效果状态 |

Skill 是当前 run 的指导/资源上下文；MCP 是工具来源。二者都不应成为 Agent 内核的业务分支条件。

## 2. 当前调用链

```text
src/index.ts
  ├── 内部脚本运行时 / 独立 MCP 程序入口
  └── src/app.ts
        ├── 读取配置、创建 Store / Diagnostics / Skills / ModelAdapter
        ├── 创建 AgentService
        └── CLI / HTTP / 桌面桥接
                 │
                 ▼
         AgentService.submit(sessionId, content)
           ├── 检查关闭、并发和待对账状态
           ├── 写用户消息，创建 run
           ├── 固定本轮工具目录
           ├── 加载跨轮历史与摘要
           └── LangGraph：model → tools → model
                 ├── 注入角色、工具指导、宿主事实、Skill 目录
                 ├── 适配/压缩上下文
                 ├── ModelAdapter.generate
                 ├── 校验模型用量
                 ├── 串行调度工具并回填结果
                 └── 完成或停止，保存回复与 run 终态
```

LangGraph 当前是两个主要节点的执行循环，checkpoint 的 thread_id 使用 runId。重启恢复并不自动重放这个 checkpoint；未知外部效果仍须对账。

## 3. 当前模块的实际职责

| 模块                     | 当前职责                                                                                      | 梳理结论                                           |
| ------------------------ | --------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `app.ts`                 | 配置、依赖组装、启动分支、服务与进程生命周期、应用扩展                                        | 适合作为组合入口，资源创建/失败清理应统一          |
| `agent/index.ts`         | 会话提交、并发、取消、模型循环、工具调度、提示词组装、脱敏、Wiki维护、MCP创建、标题和对账文案 | 职责过宽，不能只按行数拆文件                       |
| `agent/history.ts`       | 跨轮历史加载和连续前缀摘要落盘                                                                | 属于会话历史策略                                   |
| `agent/context.ts`       | 单轮上下文压缩、工具组完整性和证据保留                                                        | 属于模型输入策略，应接受本轮目录的保留规则         |
| `llm/`                   | Vercel AI SDK、流式模型请求、错误归类、摘要、标题、Wiki提取                                   | 传输与应用任务策略仍混合                           |
| `tool/`                  | 六个固定内置工具、MCP工具拼接、校验和分发                                                     | 尚未形成统一的工具提供者/执行契约                  |
| `mcp/`                   | 通用连接、发现、允许列表、调用、读请求合并和写审计                                            | 业务边界已分离，但调用上下文仍绑定聊天 ToolContext |
| `skill/`                 | 可信发现、加载、资源/脚本路径约束、指导注入                                                   | 作为通用能力保留，通过窄接口接入循环               |
| `execution/`             | 脚本解释器、进程树、取消、时间与输出限额                                                      | 应作为脚本工具的执行后端，不成为所有工具的状态模型 |
| `storage/`               | 会话、消息、runs、两类执行审计、摘要、checkpoint和Wiki索引表                                  | 一个数据库所有者可以保留，仓储职责需要分开         |
| `api/`、`cli/`           | 交互与传输                                                                                    | 调用应用服务，不负责执行循环                       |
| `integrations/`、`wiki/` | 发行应用组合、展示适配、知识能力                                                              | 不应成为最小 Agent 循环必需依赖                    |

## 4. 优先问题与源码依据

### A. AgentService 同时承担执行器和应用总服务

`src/agent/index.ts` 构造函数直接创建 Wiki 和 McpService，并通过 `store.db.query` 获取运行状态。它还维护 Wiki更新、标题任务、流式脱敏和对账报告文本。

建议：

- 保留薄的提交/取消/状态服务，提取独立 AgentRunner。
- 模型、工具目录、历史、审计、事件和上下文能力由组合层注入。
- Wiki维护和标题生成归应用服务/后台任务服务；循环不构造它们。
- 将直接 SQL 查询移回明确的仓储接口。

### B. 工具执行仍有两条体系

`src/tool/index.ts` 的 BuiltinToolRegistry 既管理固定内置工具，又接收 McpDefinition 和外部执行回调。内置工具通过 Zod/ToolSpec 校验，MCP通过其客户端校验；脚本与MCP分别记录不同形态的审计。

尤其是 `src/tool/context.ts` 中的 `ToolResult.status = ScriptResult['status']`，让通用工具结果依赖脚本进程类型。`read/network/process` 也不能完整表达读写、副作用和运行上下文修改。

建议统一：

1. ToolDescriptor：名称、schema、提供者、策略、前置条件、上下文保留规则。
2. ToolProvider：提供目录与实际调用能力；内置和MCP是不同实现。
3. ToolExecutor：统一校验、事件、执行结果处理和审计接入。
4. Provider details：进程退出码、HTTP信息等放在提供者结果中，不混成通用运行状态。

需要区分两个维度，而不是用一个 status 表示一切：

| 场景                   | 执行状态       | 外部效果                                   |
| ---------------------- | -------------- | ------------------------------------------ |
| 启动前校验拒绝         | failed         | 未发送/无外部效果                          |
| 只读调用取消           | cancelled      | 无写入效果                                 |
| 写请求已发出但响应丢失 | failed/timeout | unknown                                    |
| 外部服务明确受理操作   | succeeded      | 按工具契约确认受理，不代表整个业务目标完成 |

统一协议时必须保留 unknown 的优先级和停止语义，不能把超时或取消一律当成已知失败。

### C. 会话记录、工具证据和 checkpoint 的关系不够清楚

`storage/index.ts` 的 messages 只记录 user/assistant 文本，reasoning 在独立表；`agent/history.ts` 从这些记录加载下一轮历史。工具调用/结果主要位于本轮图状态和 checkpoint 中，审计表保存状态或摘要信息，并没有成为正常跨轮历史的统一输入。

这不表示工具轨迹完全没有保存，而是下一轮通常只能依赖最终回复提到的事实，无法稳定获得规范化工具证据。

建议分别定义：

- Conversation transcript：面向上下文的消息及有界、脱敏工具证据或引用。
- Operation audit：执行意图、结果、未知效果和核对事实。
- Checkpoint：执行引擎内部状态，不作为领域事实数据库，不自动重放未知操作。

先明确各自存什么、如何关联，再调整存储。原始日志、完整脚本输出和凭据不能因为重构而被默认加入聊天或审计。

### D. 上下文策略存在静态目录与内容形状耦合

`agent/context.ts` 通过全局 `contextRetentionFor` 查固定内置工具，而且证据保留逻辑判断了 `results`、`record` 等内容形状。MCP动态工具无法用同一接口声明保留策略。

`history.ts` 与 `context.ts` 分别处理跨轮摘要、当前轮压缩，这个区分有实际意义，应保留；可以共用预算、摘要调用和统计规则，不应粗暴合并成一个函数。

建议上下文管理器使用当前 run 的 ToolCatalog 查询保留规则，不依赖静态内置表或某类知识结果的字段名称。

### E. ModelAdapter 尚未完全隔离模型请求与任务策略

`shared/types.ts` 的 ModelAdapter 同时包含 generate、summarize、generateTitle、generateKnowledge。`llm/index.ts` 又直接引用 Wiki提取提示词，并在没有传工具时创建内置工具目录。

建议：

- 模型网关只接受完整请求并返回标准化结果；工具清单显式来自调用方。
- 标题、摘要、知识提取作为不同任务调用模型网关，各自拥有提示词。
- 增加明确的结束原因表达。当前 ModelTurn 没有 finishReason，主 generate 路径没有把 length 等结束原因传回循环，无法在这一层区分完整回答与截断输出。
- 先保留现有 AI SDK 实现。稳定接口是否继续采用 SDK 的消息类型单独决定，不为了抽象而重写整套模型 SDK。

### F. 终态持久化和启动清理需要先补可靠性边界

`agent/index.ts` 的成功路径分别保存 assistant 消息和 run 终态；异常路径先 finishRun 再写错误回复。如果结束操作自身遇到存储错误，可能掩盖原始失败并中断后续错误记录。这里是静态识别的异常路径，尚未做本轮故障复现。

`app.ts` 有多处局部 try/finally，但 Store 创建后的后续初始化和部分失败退出没有统一的资源释放入口。

建议先补测试并收敛接口：

- `completeRun` / `failRun` 明确终态、最终回复及审计关联的事务边界。
- 数据库不可写时停止进一步副作用；不把未落盘的内存结果当作后续操作依据。
- 统一启动失败与正常关闭的资源管理；组件按创建逆序关闭，关闭操作可重复调用。

### G. 仍有业务化输出字段需要清理

虽然具体 Skill/设备名称特判已经移除，`tool/tools/script.ts` 仍挑选 batchId、pendingInputs、sampleInputsComplete 等字段写诊断。这类字段不应由通用脚本执行层认识。

应定义提供者通用的诊断/证据封套或由业务适配器负责映射。清理时保留现有未知结果、大小限制和脱敏能力，不能简单删除信息导致核对能力退化。

## 5. 建议目标边界

```text
Application composition
  ├── SessionService        提交、取消、运行状态
  ├── AgentRunner           model ↔ tools 循环与停止条件
  ├── ModelGateway          模型请求和流式输出适配
  ├── ToolCatalog/Executor  统一工具协议、策略与调用
  ├── History/Context       会话历史、输入准备、压缩与证据保留
  ├── Repositories          会话、运行、操作、证据与摘要
  └── Event/Diagnostics     运行通知和诊断投影

能力实现：Builtin tools / Skills / ScriptExecutor / MCP / Wiki
界面和接入：CLI / HTTP / Desktop / Application extensions
```

第一步在现有 src 中落实职责和接口，保持外部 API 行为稳定。接口稳定后再决定哪些可复用部分抽为 workspace 包，避免仅把一个大类搬到 packages。

LangGraph 先作为循环实现保留；其 checkpoint 不承担后台工作流语义。当前多工具执行按顺序进行，失败会阻断本轮余下调用。没有显式依赖/上下文修改声明前，不把模型返回的工具数组直接并行化。

## 6. 建议调整顺序

1. 明确 ModelRequest/ModelTurn、ToolDescriptor/ToolResult、RunContext 和仓储接口。
2. 补终态落盘、启动失败、取消及未知效果的回归与故障注入测试。
3. 提取 AgentRunner，让 AgentService 收敛为薄服务，移出 Wiki维护和标题任务。
4. 统一内置/MCP/脚本的工具执行入口与结果协议。
5. 理清 transcript、工具证据、操作审计、checkpoint 的存储与历史加载关系。
6. 统一上下文策略入口，再整理模型网关与应用任务提示词。
7. 最后决定进一步包拆分及持久化工作流如何消费这些稳定接口。

本阶段不继续增加仪器业务、调度器或工作流功能。验收重点是：同一套核心规则适用于不同 Skill/MCP；现有接口、未知效果处理、数据所有权和会话行为保持正确。
