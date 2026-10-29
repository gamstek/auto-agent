# Climber 厂家单仪器接口

依据《Climber 子服务与厂家软件接口及功能对照》（2026-10-14）中的厂家 HTTP 接口。本入口通过 `scripts/climber.js` 直接连接 Climber PC 软件的 HTTP API，不需要提交自动化流程。厂家端口为18080，API路径为 `/api/v1`；实际主机地址由部署配置提供。脚本需要 Node.js 22 或宿主支持的 JavaScript 运行时。

用户只查询健康或状态时直接查询，不要求提供模板。测样需要配置文件时使用 [SAM 模板写入接口](./sam-create.md) 生成、修改或另存为 `.SAM`，再通过厂家接口登记、启动。厂家可读取路径与 Agent 主机可读写路径按部署映射核对。Climber 正被自动化流程占用时，不绕过流程另行启动。

## 命令与路由

`CLIMBER_SERVICE_URL` 配置为厂家 API 基址，包含 `/api/v1`，可带结尾 `/`；禁止在 URL 中放凭据、查询参数或片段。参数数组中的 JSON 作为一个完整参数传递，不拼接 shell 字符串。

| 命令参数                                   | 厂家请求                                        | 结果含义                                              |
| ------------------------------------------ | ----------------------------------------------- | ----------------------------------------------------- |
| `["health"]`                               | `GET /api/v1/health`                            | 版本、软件就绪、连接、忙闲及 HTTP/回调配置等当前事实  |
| `["status"]`                               | `GET /api/v1/status`                            | 当前 `data.health` 和 `data.task`，无任务时 task=null |
| `["register", "<JSON>"]`                   | `POST /api/v1/tasks`                            | 登记批次及实验，读取模板并应用参数，不代表分析开始    |
| `["start", "{\"batchId\":\"BATCH-001\"}"]` | `POST /api/v1/tasks/BATCH-001/start`，正文 `{}` | 请求启动已登记批次；实际运行以状态为准                |

成功返回 `backend=climber-vendor`、operation、厂家原始 response；写入还返回 batchId 和 stage，登记返回原管号到厂家接口管号的 tubeMapping。退出非零时读取 error，不当成成功。仅使用这四项厂家接口，不使用 Python 子服务路由、命令封套或旧命令名。

## 登记左侧批次

用户授权运行且目标产品、方案、模板和样品字段齐备后，先查询 health/status，核对 softwareReady、deviceConnected、deviceBusy 及当前 task。当前现场仅左侧1–3口已验收，厂家状态是单个 task；右侧不能算可用容量。返回字段结构不明或身份冲突时先核对，不推断设备就绪。

准备参数时先复用本次任务已知信息。没有合适模板时按 SAM 接口自行生成，使用工具返回的真实路径，并依据已知部署规则取得厂家可访问路径；不要默认要求用户提供现成 SAM 或重复提供刚生成的文件路径。只有厂家访问路径、白名单目录或跨机映射缺失时，才询问该访问条件，文件写入成功本身不证明厂家可读。batchId/experimentId 未指定时由 Agent 生成本次任务的唯一操作标识；已有用户或外部流程标识原样保留。分析口、原管号、实际称量等物理信息只询问缺失项，不向用户逐项索取完整请求结构。

登记参数直接使用厂家批次结构：

```json
{
  "batchId": "BATCH-EXAMPLE-001",
  "experiments": [
    {
      "experimentId": "EXP-EXAMPLE-001",
      "analysisPort": 1,
      "tubeNo": 109,
      "samPath": "//server/share/Climber/Templates/existing.SAM",
      "sampleName": "样品A",
      "emptyTubeMassG": 29.1,
      "sampleMassG": 1.5
    }
  ]
}
```

以上是字段示例，不是运行授权，也不证明路径或样品值真实存在。

- batchId 为1–64位字母、数字、点、下划线或连字符，不得为 `.` 或 `..`。experimentId 非空、最多128字符。保留 batchId、experimentId 及每个阶段的回执用于追溯；不发送 commandId、taskId、stationId 或 payload。
- experiments 同批左侧1–3项，analysisPort 仅1、2、3；实验ID、端口及转换后的厂家管号各自唯一。
- 输入 tubeNo 为用户确认的原正整数，脚本在登记请求中转换为 `n % 72 or 72`，如109→37、144→72，并返回映射；取余重号整批拒绝。原管号与分析口不是同一字段。
- samPath 为厂家进程可读、白名单内的绝对 `.SAM` 路径，支持 Windows 驱动器路径和 UNC。优先使用用户已指定或工具生成、修改、另存为后返回的路径，按部署规则映射到厂家可读位置；接口传路径，不传输文件内容。
- sampleName 非空、最多128字符、不含非法文件名字符；emptyTubeMassG 为空管质量、sampleMassG 为净样质量，单位g，均为有限正数。待填模板的0值及虚构测试称量不能作为真实测样参数。
- 只发送表中已支持字段，保留气体、温度、压力等配置的产品差异和来源，不将其他接口的扩展字段附加到登记中。

## 从登记到启动

1. 调用 register，检查退出状态与 `response.ok`，按 `response.data.task` 核对同一 batchId、READY 等状态及实际返回的逐实验信息。
2. 登记效果明确后，调用 start，只传 `{"batchId":"已登记批次"}`。脚本不会在 register 内自动启动，也不会在 start 内重复登记。
3. start 响应按文档实测的 HTTP 202 `ok/data` 解析，任务对象直接位于 data；登记响应则为 `ok/data.task`。脚本校验同批次及非空 state，不猜测其它封套。若厂家后来统一封套，先核对合同再更新实现。
4. 有界查询 status，核对 batchId 和逐实验身份。READY 是已登记待启动；STARTING 是已请求启动，analysisStarted 仍可能为 false；RUNNING 才是厂家确认实际运行。COMPLETED 必须是当前批次的新鲜状态，不能把上一批完成状态当本批结果。

厂家仅提供当前单 task 投影。及时记录本批次的状态与实际返回的 deviceRunId、结果路径等证据；不要假定新批次覆盖后的 status 能查询历史任务。结果文件只按厂家实际返回的同批字段或已核对的文件证据报告，任务完成不自动证明 SAM/PDF 已保存。

## 异常与对账

明确拒绝返回 COMMAND_REJECTED，并保留厂家的 error.code/message。LOCAL_CONTROL_CONFLICT 表示厂家本地窗口占用，由操作者或厂家处理。

写请求超时、断连、非JSON、HTTP状态与封套矛盾、回执缺少任务身份或批次不匹配时返回 OUTCOME_UNKNOWN，保留 batchId、stage 和管号映射。宿主会将该 JSON 错误记录为 unknown 并阻断依赖工具，而不是因脚本已退出就判定外部写入已知。停止后续依赖步骤，只读 health/status 对账；不自动重复 register/start，不通过更换批次编号重试。登记未知不能继续启动，启动未知不能重新登记。请求退出或软件取消不证明仪器停止。

操作能力以本文四项已核对的厂家接口为准；扩展动作需先取得对应厂家合同及实现，不从其他控制入口类推命令。
