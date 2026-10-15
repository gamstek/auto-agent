# Climber 单仪器接口

依据《Climber 子服务与厂家软件接口及功能对照》（2026-10-14）。本入口独立控制 Climber：通过 Python 子服务连接厂家 PC 软件，不需要提交自动化流程。使用 `scripts/climber.js`，需要 Node.js 22 或宿主支持的 JavaScript 运行时；连接地址由部署环境提供，不在技能中假定现场地址或目录。

用户只查询健康、状态或结果时直接使用对应只读命令，不要求提供模板或实验参数。用户要求启动时才收集下述批次参数；已指定准确模板和参数时无需重新推荐。Climber 正被自动化流程占用时，不绕过流程另行启动。

## 调用

参数数组中的 JSON 必须作为一个参数传递，不拼接 shell 字符串。先查询 `['health']`、`['status']`、`['vendor-health']`、`['vendor-status']`。分别对应子服务 GET /health、/status、/api/v1/health、/api/v1/status；`['results']` 对应 GET /results。响应保留在 `response` 中，并标明 backend=climber-subservice。退出非零时读取 error；不得当成成功。

子服务健康不等于厂家就绪。检查厂家 softwareReady、deviceConnected、deviceBusy，以及子服务目标站 stationStatus、ports、activeTask、pauseContext；右侧停用不能算可用容量。未知字段结构或身份冲突时停止提交并请求操作者核对。只读接口是缓存，不能假定每次查询都强制访问仪器；STATUS_POLL 也只发布已有快照。

## 启动左侧批次

用户明确要求运行，模板匹配依据及全部字段已确认，且当前目标站可接任务时，调用 `['start', '<JSON>']`：

```json
{
  "commandId": "CMD-EXAMPLE-001",
  "payload": {
    "taskId": "BATCH-EXAMPLE-001",
    "stationId": "analyzer-02",
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
}
```

以上仅为字段示例，不是运行授权，也不证明该站点或模板存在。

- stationId 取自实际状态或部署信息，不硬编码示例值。taskId 为 1–64 位字母、数字、点、下划线或连字符；commandId、taskId、experimentId 用于追溯，保留在后续对账中。不要把协议标识当作用户真实样品编号。
- 同批左侧 1–3 项，analysisPort 仅 1、2、3；编号、端口、转换后管号各自唯一。右站 4–6 和双侧并行尚未验收，不提交。
- tubeNo 使用用户确认的原正整数；脚本检查 `n % 72 or 72` 是否重号，但原值发送子服务，由子服务转换。109→37，144→72；不能把管号当分析口。
- samPath 是厂家进程可读、白名单内的既有绝对 .SAM 路径，可用 UNC。必须来自资料或用户确认，不从文件名猜测服务器目录，不列举或读取模板目录，不上传或修改模板。无法从已有资料确定路径时请求操作者补齐。
- sampleName 非空、最多 128 字符、不含非法文件名字符；experimentId 非空且最多 128 字符。emptyTubeMassG 是空管质量、sampleMassG 是净样质量，单位 g，均为有限正数。缺失值需询问，不能编造或混用总质量。
- 不发送 tubeCode、samFileName、pdfFileName、samSha256 等扩展字段。真实管码、PDF 自动导出、共享直写及元数据能力未验收。

脚本仅 POST /commands，commandType=CLIMBER_ANALYZER_START。子服务内部登记并启动；不要再直接访问厂家 /tasks 或 /start。回执 accepted=true 仅证明命令受理，不代表分析启动。

## 状态、结果与异常

有界查询 status 和 vendor-status，核对 taskId/batchId 及逐实验身份。READY 是已登记，STARTING 是已请求启动（analysisStarted=false），RUNNING 才是厂家确认实际运行。COMPLETED 必须匹配当前任务并有新鲜状态或同任务回调证据，不能把上一批完成状态当本批结果。厂家当前只有单 task，后续批次会覆盖当前投影；不得冒充历史任务查询接口。

完成后查询 results，分别报告设备完成事实、通知投递及 SAM/PDF 归档状态。文件缺失、权限或冲突可能为 PENDING；不重发 Start。子服务只归档厂家已有文件，不生成 PDF；不调用自动化流程的 export-report。文件名、路径与内容以实际返回为准，不能把“最新文件”认成本批结果或宣称自动 PDF 已支持。

超时、断连、非 JSON、回执身份矛盾为 OUTCOME_UNKNOWN：保留命令和任务标识，只读对账并请求操作者处理，不自动重发。明确拒绝时报告错误，不自动复用命令重试。LOCAL_CONTROL_CONFLICT 表示厂家本地窗口占用，需操作者或厂家处理；没有关闭窗口接口。

脚本另提供 `['resume', '{"commandId":"...","payload":{}}']`、clear-error、status-poll，映射 RESUME、CLEAR_ERROR、STATUS_POLL，payload 原样交子服务验证。仅在用户明确授权相应本地恢复/清错/发布状态操作、且部署合同确认 payload 后使用。RESUME 是 PAUSE 状态下的只读对账，不是物理继续；CLEAR_ERROR 仅清本地 ERROR，不是复位；PAUSE 是冻结本地写入，不证明仪器物理暂停。没有物理暂停、继续、停止、取消、reset、关窗、模板管理或 PDF 导出接口，不编造调用。液氮补液由独立服务负责。
