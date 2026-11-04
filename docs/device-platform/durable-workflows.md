# 持久化工作流执行器设计

状态：设计草案，未实现。本文不改变现有聊天恢复规则。遵循 [通用 Agent 边界](../architecture.md)：引擎执行声明的步骤，不硬编码 Skill、流程名称或设备品牌；设备业务与物理预留由 MCP 服务提供。

## 1. 运行原则

**模型负责提出计划，确定性执行器负责运行计划。**

- Skill 提供方法和操作指导；Agent 生成流程类型及参数。
- 只有代码中已经实现、经过 schema 校验的流程定义可以执行。
- 接受任务时固定定义版本、输入、设备标识、文件引用/哈希和操作授权范围。
- 执行器按依赖、资源和持久化状态调度步骤，不逐步调用模型来猜“接下来怎么办”。
- 如某一步确实需要模型推理，将其声明为显式规划步骤，有独立预算、结构化输出和人工/规则校验；输出固定后再推进，不在恢复时隐式重规划。
- 第一版使用已审查、版本固定的 `climber-batch@1` 业务模板验证通用引擎；模板放在业务包/可信 Skill 的资源中，不写成 Agent 内的特判。不接受任意代码作为流程步骤。

`authorizationRef` 由宿主从明确的用户操作/已登记计划生成并校验。模型可以提出计划和请求执行，但不能在工具参数中自行声明“已授权”来创建有效授权记录。

## 2. 第一条宿主流程

### 2.1 实例输入草案

```json
{
  "workflow": "climber-batch",
  "version": 1,
  "executor": "host",
  "deviceId": "climber-01",
  "batchId": "BATCH-20261104-001",
  "experiments": [
    {
      "experimentId": "EXP-001",
      "analysisPort": 1,
      "tubeNo": 109,
      "samPath": "E:\\templates\\sample-a.SAM",
      "sampleName": "样品A",
      "emptyTubeMassG": 29.1,
      "sampleMassG": 1.5
    }
  ],
  "files": [
    {
      "experimentId": "EXP-001",
      "localArtifactId": "已登记的本地文件引用",
      "expectedSha256": "实际计算的文件哈希",
      "vendorPathMappingId": "已配置的厂家路径映射"
    }
  ]
}
```

以上是说明字段关系的示例，不是可直接运行的任务。正式 schema 要区分本地文件、厂家路径和已验证的部署映射，不能用示例值或无法核验的 hash 通过校验。

首版流程接收准备好的 SAM，不在设备已预留且等待运行时临时研究方案或生成模板。先用现有 SAM 工具完成文件准备，再提交流程。

### 2.2 固定步骤

| 步骤              | 实现                         | 成功依据                                     | 下一步           |
| ----------------- | ---------------------------- | -------------------------------------------- | ---------------- |
| `validate_inputs` | 本地参数、SAM 引用及变更校验 | 样品字段齐全，文件身份匹配，厂家访问条件明确 | `reserve_device` |
| `reserve_device`  | 宿主事务预留                 | 唯一设备预留归属本流程                       | `wait_ready`     |
| `wait_ready`      | 新鲜 MCP 状态查询            | 就绪/连接/忙闲字段满足契约，无冲突任务       | `register`       |
| `register`        | MCP `register_batch`         | 当前 batchId 的明确登记回执                  | `start`          |
| `start`           | MCP `start_batch`            | 同 batchId 的明确启动受理回执                | `wait_completed` |
| `wait_completed`  | 持久化定时查询               | 新鲜状态明确为本批次 COMPLETED               | `record_results` |
| `record_results`  | 保存厂家实际返回的结果引用   | 记录设备完成事实和结果可用性，二者分开       | `release_device` |
| `release_device`  | 核对后解除预留               | 无未决写入，设备占用与本次任务有明确结论     | 流程终态         |

在 `register` 之前再次核对模板身份和新鲜状态，避免排队期间模板被改写。无法读取厂家主机文件时，本地 hash 只能证明本地文件；不能冒充厂家读取内容的证明。

`record_results` 不保证一定有 SAM/PDF 报告。设备完成但厂家没有给出结果位置时，显示“分析完成，结果位置未提供”；如果任务明确要求可读取报告，结果收集步骤需要独立契约、截止时间和完成条件。

## 3. 状态机与完成语义

### 3.1 工作流实例

| 状态               | 含义                               | 可自动推进条件                     |
| ------------------ | ---------------------------------- | ---------------------------------- |
| `scheduled`        | 等待计划时间                       | 到期、未过错过触发窗口             |
| `ready`            | 存在可执行步骤                     | 前置步骤完成，资源允许             |
| `running`          | 正在执行短步骤                     | 根据已记录步骤结果推进             |
| `waiting_device`   | 等待资源、就绪或设备完成           | 到 nextWakeAt 后只读检查           |
| `waiting_input`    | 缺少必须输入                       | 明确补充并重新校验，不编造参数     |
| `needs_review`     | 外部效果/身份无法确认              | 明确核对流程，不自动执行依赖写入   |
| `cancel_requested` | 已请求终止后续流程                 | 根据在途操作及设备状态完成取消处理 |
| `completed`        | 定义的完成条件均已满足             | 终态                               |
| `failed`           | 明确失败，原因已记录               | 终态，不自动复活                   |
| `cancelled`        | 后续步骤停止，必要的外部状态已处理 | 终态，附外部设备结论               |

### 3.2 步骤与操作分开

步骤状态建议为 `pending/ready/running/waiting/completed/failed/blocked/cancelled`；设备操作状态建议为 `prepared/dispatching/confirmed/rejected/unknown/not_sent`。

一个等待步骤可以进行多次只读观察，但只对应一个业务步骤。一个设备命令被受理也不等于其对应业务目标已完成。

原始厂家 state 原样保存。`STARTING`、`RUNNING`、`COMPLETED` 等经过适配器校验后可影响步骤推进；未识别的状态不默认成功。

## 4. 持久化数据模型

数据库命名遵循现有 Store 风格。以下是字段与约束草案，具体 SQL 由带版本的 migration 实现。

| 表                          | 关键字段                                                                                                                                                                   | 必要约束/索引                                        |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `workflow_definitions`      | id, version, executor, definitionJson, definitionHash                                                                                                                      | `(id, version)` 唯一；已被引用的定义不可原地修改     |
| `workflow_runs`             | id, definitionId/version, status, inputJson, resourceScopeJson, authorizationRef, parentRunId, nextWakeAt, revision, createdAt, finishedAt                                 | 到期/状态索引；revision 条件更新；父子续行可追踪     |
| `workflow_steps`            | runId, stepId, status, dependencyIds, inputRef, outputRef, nextWakeAt, deadlineAt, attempt, revision                                                                       | `(runId, stepId)` 唯一；due 索引；步骤类型必须受支持 |
| `tool_operations`           | id, serverId, toolName, resourceRef?, origin, chatRunId?, workflowRunId?, stepId?, logicalActionKey, inputRef, status, dispatchOwner, dispatchEpoch, createdAt, finishedAt | 通用操作标识与逻辑动作约束，不含厂家专用列           |
| `workflow_observations`     | id, runId, stepId, observedAt, sourceTool, snapshotJson, operationId?                                                                                                      | 步骤+时间索引；有界保留，业务字段作为不透明输出保存  |
| `resource_leases`           | resourceKey, ownerRunId/operationId, state, ownerEpoch, heartbeatAt, acquiredAt                                                                                            | 声明式资源租约；不代表设备物理状态或取代服务端预留   |
| `workflow_schedules`        | id, definitionRef, timezone, rule, inputTemplateRef, enabled, nextFireAt, misfirePolicy, overlapPolicy, authorizationRef                                                   | enabled+nextFireAt 索引；计划版本固定                |
| `schedule_firings`          | scheduleId, scheduledFor, workflowRunId?, disposition, reason                                                                                                              | `(scheduleId, scheduledFor)` 唯一                    |
| `workflow_events`           | id, runId, stepId?, type, timestamp, boundedPayload                                                                                                                        | 可分页查询；不依赖 SSE 重放                          |
| `operation_reconciliations` | id, operationId, conclusion, evidenceRefs, operatorNote, createdAt                                                                                                         | 追加记录，不改写原 unknown 审计                      |

说明：

- 不把新表的数据硬塞进现有以聊天 run 和脚本为中心的 `executions` 表。原审计、review 和 checkpoint 保持可读，现有中断语义保持不变。
- `tool_operations` 对所有 MCP 操作统一建模，资源引用不透明；不要求 deviceId、不解析批次字段。厂家设备预留仍由对应 MCP 服务保存，不能把该业务状态搬回 Agent 数据库。
- 操作输入是运行所需的业务数据，存于受限本地数据库/制品存储，不写入普通日志、SSE 或诊断 ZIP；认证信息不持久化在操作输入中。
- `logicalActionKey` 标识一个流程谱系中的具体业务动作，例如“本批次的 register”。新 continuation run 不能靠换 operationId 绕过未决操作。
- 工作流 step 输出只保存结构化结果和制品引用；大文件、原始工具正文按现有限额和制品规则处理。
- schema migration 指数据库结构升级，不涉及导入旧桌面配置。共享配置仍只有 `~/.auto-agent/config.json`。

建议按 monorepo 建立独立 `packages/workflow-runtime/`，由发行应用提供窄的持久化和 MCP 调用接口：

```text
packages/workflow-runtime/src/definitions.ts  版本化定义加载与校验，不内置业务流程 ID
packages/workflow-runtime/src/schemas.ts      通用输入、步骤和状态 schema
packages/workflow-runtime/src/engine.ts       按步骤类型执行和推进
packages/workflow-runtime/src/scheduler.ts    到期扫描与调度
packages/workflow-runtime/src/recovery.ts     通用恢复策略
packages/workflow-runtime/src/resources.ts    声明式通用资源租约
src/storage/workflows.ts                     应用侧持久化适配器
```

这些仓储使用现有后端拥有的数据库连接，不自己启动另一个竞争数据目录所有权的 Store。

业务流程模板放在业务包或可信 Skill 资源中。Climber 的工具名称、字段和成功条件是模板数据，不是引擎里的 if/switch 分支；模板不能授予未配置的工具权限。第一版优先使用声明式 MCP 调用和只读条件，不执行模板中的任意 JavaScript。

## 5. 单步执行与事务边界

### 5.1 写操作正常路径

```text
事务 A：核对步骤 revision、设备预留、授权范围
        创建 prepared 操作，锁定 logicalActionKey
        提交
事务 B：再次核对执行权，将操作标为 dispatching
        提交
外部调用：MCP → 厂家 API
事务 C：校验回执身份，记录 confirmed/rejected/unknown
        保存结果与步骤状态/nextWakeAt
        追加工作流事件
        提交
事务完成后：向 UI/SSE 发出状态通知
```

数据库事务不能覆盖网络调用。只有 `dispatching` 已提交后才允许调用外部服务；这个状态表示“可能已经发出”，不是“保证厂家收到”。

第一版只有一个后端 owner；调度器仍须通过 revision/CAS claim 防止同进程异步任务重复领取。不要用一个内存 boolean 替代数据库执行权。

### 5.2 失败窗口

| 失败位置                            | 持久化事实                 | 重启后的动作                        |
| ----------------------------------- | -------------------------- | ----------------------------------- |
| intent 未提交                       | 无可执行记录               | 从尚未执行的步骤重新校验            |
| prepared 已提交，dispatching 未提交 | 保证尚未进入外部调用       | 重新核对条件后可调度                |
| dispatching 已提交，调用前进程崩溃  | 无法从持久化事实证明未发送 | 保守进入 unknown；不自动重发        |
| 厂家已执行但响应丢失                | dispatching                | unknown，查询/人工核对              |
| 回执已收到，但事务 C 失败           | 无持久化成功结果           | 停止依赖操作；恢复时按 unknown 处理 |
| confirmed 已提交，但 UI 没收到通知  | 持久化结果明确             | 读取快照，推进下一步，不重复发送    |

如果数据库暂时不可写，不继续发起设备写入；日志记录失败不能当作已完成业务审计。没有落盘的“内存成功”不能授权后续启动。

### 5.3 Retry 规则

- 可对只读查询进行有界退避重试。
- 输入校验失败不重试，等待修正。
- 厂家明确拒绝先结束当前尝试；是否重新执行由新的明确操作决定，不由通用网络重试器接管。
- 写操作断连、超时、取消或响应身份错误均不自动重试。
- MCP 请求 ID、宿主 operationId 和 batchId 都不能自动视为厂家支持的幂等键。
- 第一版不承诺 exactly-once 外部效果；承诺已记录 intent、未决效果不自动重复以及完整的恢复/核对路径。

## 6. 等待与恢复

### 6.1 长时间等待

`wait_completed` 保存 batchId、nextWakeAt、deadlineAt 和最后观察，不保持几小时的模型请求或 MCP 调用。

调度器到期时发起一次有界查询：

1. 核对来源、字段和批次/实验身份。
2. 若本批次仍运行，保存观察与下次唤醒时间，释放短任务并发槽位。
3. 若本批次明确完成，推进结果记录步骤。
4. 若查询失败，保留最后已知事实，退避重查。
5. 若任务被其他批次覆盖、身份冲突或截止时间到达而外部状态仍不明，进入 needs_review，不报告“仪器已停止”。

等待完成期间仍持有设备预留。后台轮询频率与 UI 刷新分开，经过设备状态服务合并请求。

### 6.2 启动恢复

后端取得独占数据目录所有权后，先恢复，再允许新写入：

1. 加载活动流程与设备预留。
2. 将上一 owner 遗留的 dispatching 操作标为 unknown，并阻断相关流程/设备写入。
3. 保留已完成步骤与版本；prepared 步骤重新检查前置条件。
4. 恢复 waiting 步骤的 nextWakeAt；过期时间按 deadline/misfire 规则处理。
5. 对存在未决设备占用的记录做只读状态核对。
6. 对不能确认执行版本、设备身份或契约版本的实例进入 needs_review。

**不恢复旧 LangGraph 工具调用 checkpoint 来重发设备命令。**聊天历史可以用于解释，但不是执行器的事实数据库。

### 6.3 未知写入的核对与续行

沿用现有审计原则：原 operation 的 unknown 记录不可改写成 confirmed 来掩盖中断历史。核对结果追加到 `operation_reconciliations`，注明来源、证据、操作者说明和时间。

首版采用保守、明确的续行方案：

- 原流程进入 needs_review 后不自动继续依赖写入。
- 操作者完成核对后结束原流程，并根据已证实事实创建显式 continuation run，关联 parentRunId。
- continuation 只包含允许继续的后续步骤，沿用 batchId/experimentId 和逻辑动作约束，不通过换编号重做未知写入。
- 如证实设备已经启动，只能进入该批次的等待/结果核对；不能重新登记和启动。
- 如不能证明某次写入没有发生，不提供“从失败步骤重试”的快捷入口。
- 需要保留的设备预留通过事务转移到 continuation，不能先释放造成其他任务插入。

普通只读等待恢复不需要创建 continuation；只有核对后改变未决流程执行路径时才用上述明确记录。

## 7. 设备资源仲裁

- 以物理设备对应的 `resourceKey` 预留，不以显示名称或聊天 sessionId 预留。不同配置别名指向同一仪器时必须映射到同一资源。
- Agent、宿主工作流和将来的界面操作都通过通用 MCP 调用。设备就绪、批次规则和物理预留在 MCP 服务内实现；宿主工作流只能管理声明式的通用资源租约，不能自行猜测设备状态或添加厂家命令分支。
- 直控 register/start 也需要操作归属和设备占用语义，不能仅在单次 HTTP 调用期间加锁。
- 预留从即将占用设备开始，覆盖登记、启动、实际运行和必要的恢复核对。
- 进程心跳丢失将预留标为 recovering；不能自动释放，因为设备可能仍在运行。
- ownerEpoch/CAS 可以阻止宿主内部旧任务提交状态，但厂家不支持 fencing 时，不能宣称其能阻止已发出的外部请求。

第一版跨设备流程在开始前按固定资源排序，原子预留该流程声明的完整设备集合；申请失败则等待，不部分持有新资源形成循环等待。流程可明确释放不再使用且状态已核实的设备，但首版不在运行途中临时扩张设备集合。

以后需要提高并发率时再引入分阶段预留：原子申请本步骤所需全部资源，并对跨步骤持有范围和全局申请顺序做死锁分析。不能仅有“每一步按顺序加锁”就宣称不会死锁，也不能为了吞吐释放仍在运行的设备。

外部流程 executor=external 预留它声明的设备范围，但不拆解其内部步骤。厂家本地界面和其他程序仍可能抢占设备；出现冲突按厂家真实反馈处理。

## 8. 定时计划

### 8.1 首版范围

先实现指定时间的一次性运行，再实现明确时区的周期计划。时间在数据库中保存 UTC，计划额外保存 IANA timezone 和原定触发时刻。

接受计划时固定 workflow version 和输入来源。周期计划不得无限复用上一批样品、旧 batchId 或旧称量；每次触发必须有明确的数据绑定和独立批次身份，缺失时进入 waiting_input。

定时授权包含设备、流程版本、参数边界、有效时间与允许的触发方式。计划执行不能把过去一次咨询或一次运行授权解释为永久授权。

### 8.2 触发事务

```text
到期扫描
  → 事务内插入 schedule_firings(scheduleId, scheduledFor)
  → 唯一键冲突则表示本次触发已处理
  → 检查授权、错过触发和重叠策略
  → 创建 workflow_run 或保存 skipped/blocked 原因
  → 更新 nextFireAt
  → 提交后再交给步骤执行器
```

唯一触发记录和 workflow_run 创建必须同事务提交。不能先推进 nextFireAt，再另起事务创建任务，否则崩溃会漏跑。

### 8.3 默认策略建议

| 场景                   | 首版行为                                                                 |
| ---------------------- | ------------------------------------------------------------------------ |
| 开机时已经错过计划时间 | 默认 skip 并记录；明确配置宽限窗口后才能在窗口内补一次                   |
| 同设备上一轮仍运行     | 禁止重叠；按计划显式选择跳过或有截止时间的排队                           |
| 多个错过的周期触发     | 不一次性补齐全部历史任务                                                 |
| 缺样品/文件发生变化    | waiting_input/needs_review，不临时生成缺失测量值                         |
| 夏令时缺失/重复时刻    | 文档明确映射规则；唯一触发键使用确定的 UTC 时刻，不重复执行              |
| 系统时间向前/向后调整  | 重算到期范围并受唯一触发键保护；间隔等待使用单调时钟，但落盘时刻使用 UTC |

具体时间库和 cron 语法在该阶段选定并锁版本。首版一次性计划无需提前引入复杂 cron 引擎。

## 9. 取消、关闭与常驻服务

### 9.1 取消不是停止仪器

取消可以阻止未开始的后续步骤，但不能使已发出的厂家请求自动撤销。

- 写入前：可取消尚未分发的动作，核对并释放未占用设备的预留。
- 请求在途：不确定时进入 needs_review，保留操作标识。
- 仪器已运行：记录 cancel_requested；不再发起后续写入，保留必要观察和预留，直到外部状态得到处理。
- 当前 Climber 没有已验证 stop 接口，不显示可实际停止设备的按钮，也不把软件取消描述为停机。

### 9.2 交互模式

第一版执行器仍在桌面拥有的后端内运行。`runtimeStatus` / `/desktop/shutdown` 要同时检查活动工作流、在途设备操作及未决占用，而不只检查聊天 generation。

等待仪器完成虽然不占模型并发槽，也属于后台工作。未实现可独立存活的服务前，不能允许桌面静默关闭后宣称流程还在继续。

### 9.3 常驻服务模式

后续把后端部署成受系统服务管理器管理的常驻进程：

- 一个服务拥有数据库、MCP 连接、调度器和设备预留。
- 桌面和 CLI 通过经过认证的本机 API 连接服务，不各自再打开同一 Store。
- 区分 owned backend 与 attached backend：窗口关闭只停止自己拥有的交互后端，不关闭附着的服务。
- 原有父进程 stdin EOF 仅适用于桌面拥有的 sidecar；服务模式使用独立生命周期。
- 计划重启：停止领取新任务、等待短在途调用有界结束、保存状态，再退出。异常中止由启动恢复处理。
- 服务账户、共享配置路径、数据目录 ACL、凭据来源必须明确。Windows 服务不能假定能访问交互用户的系统凭据库或其用户目录。
- 禁止仅凭端口存在就附着，必须验证服务身份、协议版本及配置/dataDir 归属；不自动接管未知服务。

首版保持单机单 owner，不引入多个 worker 或分布式租约。未来需要多主机调度时，应单独设计中心仲裁和厂家端 fencing，不能复制 SQLite 文件实现扩容。

## 10. 对外接口与展示草案

| 路由                                 | 用途                                      |
| ------------------------------------ | ----------------------------------------- |
| `GET /workflows/definitions`         | 已实现的流程类型、版本和输入 schema 摘要  |
| `POST /workflow-runs`                | 提交校验后的实例，支持宿主级重复提交标识  |
| `GET /workflow-runs`                 | 分页查看实例                              |
| `GET /workflow-runs/{id}`            | 状态、步骤、设备占用和最后观察            |
| `GET /workflow-runs/{id}/events`     | 分页持久化事件，不是 SSE 重放             |
| `POST /workflow-runs/{id}/cancel`    | 请求取消后续调度，不等同仪器 stop         |
| `POST /workflow-runs/{id}/reconcile` | 记录核对结论，按规则显式建立 continuation |
| `GET/POST /workflow-schedules`       | 定时阶段才实现计划查询/创建               |

后续计划修改/禁用接口需要 revision 检查，并明确已经创建的运行不随计划编辑而改变。上述路由只有在对应阶段实现后才加入 `llm.txt` 和 Rust 固定白名单。

UI 先在仪器详情展示“由哪个流程占用”和当前步骤，之后增加流程列表/详情与计划页面。刷新、SSE 重连和窗口重开都从持久化快照恢复，不自动重放创建、登记、启动或取消请求。
