# Skill、MCP 与仪器页面实现设计

状态：架构基线，设备接入与只读页面已开始落地；实际范围和剩余验收见 [实施状态](./progress.md)。总体范围见 [设计首页](./README.md)，开发顺序见 [开发计划](./implementation-plan.md)。

架构边界已修正为 [通用 Agent + pnpm monorepo](../architecture.md)：Agent/MCP 内核不认识 Skill 或设备名称；厂家规则和设备预留在独立 MCP 包内，仪器页面是可选的应用展示扩展。

## 1. 模块边界

```text
聊天 Agent + device-automation Skill
        │ 工具调用
        ▼
工具注册/参数校验/预算与取消 ──► 通用 MCP 调用与审计
                                      ▲                  │
持久化工作流执行器 ────────────────────┘                  ▼
                                                     Climber MCP（设备规则/预留）
桌面仪器页面 ─► Rust 固定桥接 ─► HTTP 扩展 ─► 只读 MCP 调用 ─┘
                                                         │
                                                         ▼
                                                     厂家 HTTP API
```

宿主对所有 MCP 工具执行相同的配置权限、schema 和审计策略。Climber MCP 自己完成写入前置检查与设备仲裁，不盲信 UI 缓存；宿主不判断 register/start 或任何具体 Skill 名称。

### 1.1 Skill 保留什么

- 方法说明、测样咨询、参数缺项判断和任务规划。
- Wiki 参考使用方法、样品输入的复用和证据解释。
- SAM 模板生成/修改的操作指导。
- 调用设备能力的前置条件、顺序和结果解释。
- 已实现流程类型的选择与参数准备。

Skill 不负责保存任务进度、轮询几个小时、持有设备锁、处理进程重启或实现厂家 HTTP 协议。

Skill 内容保持可移植，以“查询设备状态”“登记批次”等能力描述流程，通过当轮实际工具目录确定工具名称。宿主前缀、服务器配置 ID、机器路径不能写死进通用 Skill。

### 1.2 MCP Server 保留什么

- 厂家连接、请求参数与响应契约。
- 协议转换、厂家错误归一化、批次/实验身份校验。
- 管号映射、支持范围与明确的能力元数据。
- 单次操作结果，不承担跨步骤恢复或整个业务流程的状态机。

MCP Server 必须能被其他标准 MCP 客户端使用，不依赖 Auto-Agent 会话数据库或已加载的 Skill。

### 1.3 宿主保留什么

- MCP 连接生命周期、启用策略、工具目录与模型工具适配。
- 输入/输出上限、超时、并发和事件脱敏。
- 通用操作审计、调用来源与执行结果不确定性；不保存厂家业务预留或解析设备命令。
- 可插拔的应用 HTTP 扩展和通用工作流持久化；仪器页面投影由应用扩展提供，物理设备预留由 MCP 服务提供。

不要从 `src/` 直接导入 `skills/` 下的实现文件。迁出 Climber 时，把厂家客户端的规范实现放进独立包，Skill 用 MCP 调用它。

## 2. 建议代码结构

```text
src/mcp/
  client.ts                 # 连接、初始化、tools/list、tools/call、关闭
  catalog.ts                # 命名空间、工具 schema、目录快照
  policy.ts                 # 启用项、宿主信任策略、读写分类
  adapter.ts                # MCP 结果 → 宿主结果与模型工具定义
src/integrations/
  mcp-servers.ts            # 发行应用包含的独立程序注册表
  instruments.ts           # 可选仪器页面只读投影；不参与 Agent 工具执行
  config.ts                # 页面展示绑定，不是 MCP 调用前提
packages/climber-mcp/
  src/server.ts             # 标准 MCP Server
  src/vendor-client.ts      # 厂家 HTTP 调用
  src/schemas.ts            # 厂家契约及能力输出
  src/controller.ts         # 设备预留、批次校验与服务自己的持久化
desktop/src/components/
  Instruments/Instruments.tsx + Instruments.css
  InstrumentCard/InstrumentCard.tsx + InstrumentCard.css
  InstrumentDetails/InstrumentDetails.tsx + InstrumentDetails.css
```

目录是实现边界建议，不要求一次创建所有空文件。工作流相关目录在下一篇文档中定义。

## 3. MCP 接入契约

### 3.1 传输与打包

第一阶段交付 **stdio**，采用维护中的 MCP SDK 完成初始化、能力协商和协议处理，不手写 JSON-RPC framing。依赖版本和许可证在实现时核对并锁定。

- MCP 子进程 stdout 只输出协议；诊断走 stderr，并沿用有界、脱敏日志规则。
- 本地自定义 MCP 进程由部署配置显式启用，程序路径与参数以数组处理，不拼接 shell。
- 只继承允许的环境变量；秘密通过配置引用和启动环境注入，不下发给模型或 WebView。
- 关闭后端时关闭连接并清理其拥有的进程。断连后允许重建连接和重做只读查询，禁止重放写入。
- MCP 调用超时/取消不证明厂家端取消。读/写操作分别分类。
- 桌面发行版包含独立 MCP 程序的可选启动入口 `--mcp-server climber`，不启动 Agent 数据库/HTTP。Agent MCP 客户端只处理标准 command/args；程序注册表属于应用组合层。构建产物、路径解析和退出清理仍需在打包阶段验收。

远程 Streamable HTTP 放在后续阶段，补齐地址配置、TLS、认证、连接恢复和远程设备预留协调后再开放。不会把远程连接自动替换成 SSH 命令执行。

### 3.2 已落地的配置结构

所有服务器统一使用 stdio 配置，默认空配置不会连接设备；可选 devices 只影响应用页面，不影响工具可用性：

```json
{
  "mcpServers": {
    "climber-local": {
      "enabled": true,
      "kind": "stdio",
      "command": "builtin",
      "args": ["--mcp-server", "climber"],
      "env": {
        "CLIMBER_SERVICE_URL": "http://127.0.0.1:18080/api/v1",
        "CLIMBER_TIMEOUT_MS": "5000"
      },
      "tools": {
        "get_health": "read",
        "get_status": "read",
        "register_batch": "write",
        "start_batch": "write"
      },
      "outcomeContract": "structured-v1",
      "timeoutMs": 20000
    }
  },
  "devices": [
    {
      "id": "climber-01",
      "name": "Climber",
      "kind": "climber",
      "mcpServer": "climber-local"
    }
  ]
}
```

约束：

- MCP 层没有 Climber 专用配置分支；所有服务器采用 `command/args/env/envFrom/tools`，权限由配置显式声明。
- 设备 ID 与显示名称分开，流程保存稳定 ID；服务器名只是连接配置 ID。
- 首版一个 Climber MCP 实例绑定一个厂家地址；多仪器可配置多个实例，不能把任意 URL 作为模型工具参数。
- 相对程序、资源及配置路径的规则需要在配置 schema 中明确；与现有相对配置目录规则一致。
- HTTP 认证如以后需要，采用凭据引用而非明文配置或 URL 凭据。
- 仪器页与 Agent 使用同一 `devices` / `mcpServers` 配置，不维护桌面专属副本。
- 当前 `scriptEnv.CLIMBER_*` 仅服务脚本。切换到 MCP 时使用显式新配置，不暗中扫描或导入旧设置；移除旧连接 UI 前更新部署说明。

### 3.3 工具发现与宿主策略

连接成功后发现工具；模型中的唯一名称使用宿主生成的命名空间，例如 `mcp__climber_local__get_status`。实际 MCP Server 的工具名仍为 `get_status`。

原有 `ToolName` 是固定 `toolSpecs` 的 key，动态目录接入需要同步处理以下职责，而不只是追加模型工具定义：

1. 动态工具 ID → server/tool 映射，检查碰撞和不合法名称。
2. JSON Schema → SDK 模型工具定义与调用前校验；不支持的 schema 明确拒绝启用。
3. 返回 structured content 校验与有界文本回退；设备写入要求符合适配器已知契约。
4. Agent 调度、工具事件、上下文保留及 token 估算都使用同一目录快照。
5. 同一 generation 固定工具定义；执行前核对连接/工具版本，契约变化时停止调用并重新发现，不在后台替换语义。

MCP 的 `readOnlyHint` 等 annotation 只是提示，不能自行授予权限。启用策略由宿主配置与已知适配器决定；未知工具不能默认为只读。

设备只读工具不要求已加载 Skill。Skill 仍是方法知识来源；MCP 返回、设备消息和日志属于证据，不能提升为系统指令。

### 3.4 工具副作用与审计适配

当前 `ToolEffect` 只有 `read/network/process`，还不能表达“网络写入”。实现时增加独立的操作策略维度，例如：

```ts
type OperationPolicy = {
  access: 'read' | 'write';
  requiresIntent: boolean;
  retry: 'bounded-read' | 'never-automatic';
};
```

这些字段属于宿主工具策略，不由模型传入。不要把 MCP 写操作伪造为子进程执行，也不要继续用 `effects.includes('process')` 作为未知效果的唯一判定。

新增操作记录应能关联聊天 run、工作流 run/step 或人工操作，但不要求每条后台观察都挂到一个聊天 run。原有脚本 `executions` 及对账记录保持原样；具体存储建议见 [工作流数据模型](./durable-workflows.md#4-持久化数据模型)。

## 4. Climber MCP 第一版

### 4.1 工具与厂家接口

| 工具草案         | 类型  | 输入                     | 厂家请求                                        |
| ---------------- | ----- | ------------------------ | ----------------------------------------------- |
| `get_health`     | read  | `{}`                     | `GET /api/v1/health`                            |
| `get_status`     | read  | `{}`                     | `GET /api/v1/status`                            |
| `register_batch` | write | `{batchId, experiments}` | `POST /api/v1/tasks`                            |
| `start_batch`    | write | `{batchId}`              | `POST /api/v1/tasks/{batchId}/start`，正文 `{}` |

保留当前已验证约束：

- 当前厂家接口仅支持常规模式，SAM 写入 `labType=0`；历史 `labType=1` 仍是有效高通量枚举，但不适用于当前接口执行。
- 当前只按已确认的左侧 1–3 分析口建模，不推断右侧可用容量。
- 原 tubeNo 映射到 1..72，保留原值、映射及来源；映射冲突整批拒绝。
- `samPath` 必须是厂家 Windows 主机上具体 `.SAM` 文件的盘符绝对路径；不能把本机生成路径、目录或 UNC 路径直接当作厂家可用路径。
- 接口传路径，不传文件。跨主机文件部署/路径映射仍是显式部署条件。
- 登记、启动分别执行；登记成功不是开始分析，STARTING 不是 RUNNING。
- register 使用已记录的 `data.task` 封套；start 只接受当前已记录的两种任务封套，并拒绝冲突身份。
- 仅有当前单 task 投影；不增加虚构的历史批次查询、停止、暂停、结果下载工具。

### 4.2 规范化结果

成功工具结果采用 MCP `structuredContent` 承载已校验的数据，保留原始厂家 state 字符串和来源信息；供 UI/模型使用的内容不含认证信息、任意响应头或不受限原始正文。

写入结果的业务含义分三类：

| 分类        | 条件                                                   | 宿主处理                               |
| ----------- | ------------------------------------------------------ | -------------------------------------- |
| `confirmed` | 厂家回执契约及批次身份明确匹配                         | 记录结果，允许符合条件的下一步         |
| `rejected`  | 有已验证的明确拒绝语义，能够确定该操作没有被接受       | 记录失败，不继续依赖步骤               |
| `unknown`   | 可能已发出，但超时/断连/回执无效/身份冲突/结果落盘失败 | 持久化 unknown，阻断依赖写入，进入核对 |

MCP `isError=true`、JSON-RPC error、HTTP 500 或进程退出码本身均不足以证明厂家没有执行。只有发送前本地验证失败或明确的厂家拒绝契约可以归类为已知失败。

执行记录中的 `operationId` 是宿主标识，不擅自添加到厂家请求正文。厂家未提供幂等支持时，使用相同 batchId 也不代表可以安全重发。

### 4.3 替换现有脚本入口

先把当前 `climber.js` 的契约用本地厂家 mock 固定下来，再在 MCP 包实现并运行等价测试。正式切换时同时完成：

- Skill 改用 MCP 能力。
- 模型只暴露一个真实设备写入入口，不同时推荐脚本和 MCP 两条路径。
- 对内置 Climber 写路径移除旧脚本生产入口，相关 eval 改为 MCP 调用；归档用途与生产能力目录分开。
- 不把 `automation.js` 的模拟反馈放进真实设备页面。

受信任外部脚本、外部 MCP 客户端和厂家本地界面不受宿主本地预留完全控制；不能宣称宿主仲裁是操作系统沙箱或厂家全局锁。

## 5. 仪器状态服务

### 5.1 统一快照草案

```ts
type DeviceSnapshot = {
  deviceId: string;
  name: string;
  kind: 'climber';
  source: 'climber-vendor';
  transport: 'connected' | 'disconnected' | 'connecting';
  vendorReachability: 'reachable' | 'unreachable' | 'unknown';
  health: {
    softwareReady: boolean | null;
    deviceConnected: boolean | null;
    deviceBusy: boolean | null;
  };
  task: NormalizedClimberTask | null;
  taskKnown: boolean;
  observedAt: number | null;
  lastAttemptAt: number | null;
  stale: boolean;
  error: { code: string; message: string } | null;
};
```

`NormalizedClimberTask` 在实现时按已验证厂家字段定义：batchId、原始 state、实际返回的实验身份/端口/状态/运行标识；不补造进度百分比、预计完成时间、结果路径。

语义：

- `taskKnown=true, task=null` 才表示新鲜查询明确返回无当前任务。
- 查询失败时保留最后一次成功快照并标记 stale；`observedAt` 不刷新为本次失败时间。
- 初次查询失败时健康字段为 null、taskKnown=false。
- MCP 连接成功不代表厂家可达，厂家可达不代表仪器已连接或可开始测试。
- UI 摘要保留厂家状态和时间；`ready/idle` 等聚合标签只在所需字段都已知且新鲜时展示。

### 5.2 刷新与缓存

- 每设备合并在途只读请求，避免 Agent、UI 和工作流同时轮询产生请求风暴。
- UI 可见时建议每 3 秒刷新一次；窗口隐藏或页面离开后停止 UI 轮询。工作流观察按独立的持久化 due 时间执行，不依赖页面存在。
- 出错采用有上限的退避，如 3、6、12、30 秒；手动刷新仍经过请求合并。
- 前端请求等待结束后再启动下一次，后端同时设置缓存新鲜度上限。建议初始 stale 阈值 10 秒，执行前置检查使用更严格的显式刷新。
- 刷新只读状态可自动重试；不会自动补发 register/start。
- 最新快照可在内存缓存；与工作流相关的关键观察必须持久化，不能只靠 UI 缓存恢复。

上述间隔是首版产品默认建议，正式值需结合厂家负载验证；不要写入 Skill 作为仪器固有性能事实。

## 6. HTTP 与桌面页面

### 6.1 HTTP 草案

| 路由                               | 行为                               |
| ---------------------------------- | ---------------------------------- |
| `GET /devices`                     | 已配置设备清单、能力摘要和最近快照 |
| `GET /devices/{deviceId}/status`   | 最近快照，包含新鲜度与错误         |
| `POST /devices/{deviceId}/refresh` | 发起/复用一次只读刷新并返回快照    |

沿用现有鉴权和错误脱敏。`refresh` 的 HTTP 方法不是“仪器写操作”的依据，实际操作分类仍为只读。

已接入通用 `extension.changed` SSE 信封，应用发布 `{extension: "instruments", resourceId, revision}`。通知不伪造会话 ID，也不含厂家原始响应、批次内容或凭据；Agent 核心事件通道不识别仪器业务。页面收到通知或 SSE 重连时 GET 快照，不因通知再次 POST 刷新，从而避免通知回路。相同事实只更新时间戳时不重复发通知；修订号在后端重启后可重置，不能用旧修订号跳过重连读取。

厂家接口仍依赖显式只读查询；该通知是应用快照变化提示，不意味着仪器已经支持主动推送或后台工作流已经实现。页面可见时保留轮询兜底，隐藏/离开时停止页面请求。

Rust `backend_request` 只增加这些固定路由。不要增加任意 MCP 工具名/URL/命令透传给 WebView 的接口。

### 6.2 页面组成

- 主导航增加“仪器”，不是放进模型连接或知识库设置。
- 仪器列表：目前一张 Climber 卡片，显示连接、忙闲、新鲜度；设备按配置 ID 标识。
- 详情：连接信息、软件就绪、当前批次、实验列表、最近成功查询时间、异常与手动刷新。
- 支持未配置、首次加载、正常、设备忙、厂家不可达、MCP 断连、过期快照等独立状态。
- 厂家没有提供的数据用“未提供/未能确认”，不能填模拟进度或推断任务完成。
- 首版没有运行按钮。将来开放界面控制时，必须调用与 Agent 相同的设备操作协调器。

组件位于 `desktop/src/components/<ComponentName>/`，TSX/CSS 同名 PascalCase；沿用共享控件、主题变量和右侧内容切换规则。新增顶层页面后，`App.tsx` 的聊天/设置布尔状态宜改为明确的页面枚举；设置组件仍须保留离开页面后的自动保存语义。

## 7. 必须通过的契约验证

1. MCP Server 初始化、工具发现、未知工具、错误参数、畸形/过大返回、断连与退出清理。
2. Climber 四接口与当前脚本契约等价，包括 tubeMapping、SAM 盘符路径和双 start 封套。
3. 登记超时不启动；启动超时不重新登记；响应身份冲突进入 unknown。
4. UI 只读刷新不调用模型；多个消费者刷新同一设备最多一个在途厂家查询。
5. 旧状态与新错误同时展示，不把连接失败转换成 `deviceConnected=false`。
6. 新增路由需同步 `llm.txt` 和 API 测试，但仅在实现落地时更新现行 HTTP 合同。
