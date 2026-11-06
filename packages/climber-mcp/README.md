# Climber MCP

pnpm workspace 中运行于 **Node.js 24+** 的标准 stdio MCP Server，SQLite 使用 node:sqlite。`sam_file` 提供 profiles/inspect/compare/create/modify/save-as；明确配置厂家地址后，再提供 `get_health`、`get_status`、`register_batch`、`start_batch`。SAM 实现、完整产品配置、厂家规则、批次验证和设备预留都在本包，不依赖 Agent、Skill 名称或 Agent 数据库。

运行环境变量：

- `CLIMBER_SERVICE_URL`：可选的厂家 HTTP(S) `/api/v1` 地址；未配置时只提供离线 SAM 文件工具，不打开设备状态数据库、不请求厂家。
- `CLIMBER_TIMEOUT_MS`：100–60000毫秒，默认5000。
- `CLIMBER_STATE_DIR`：本服务的持久化目录，默认 `~/.climber-mcp`；同一设备的多个本地服务实例应共用该目录。按规范化厂家地址区分 SQLite 文件。
- `SAM_OUTPUT_DIR`：可选的宿主绝对目录，未设置时新建文件保存到用户主目录下 `Auto-Agent/templates`。返回真实 file.path；不上传给厂家。

预留协调范围是共用状态目录与相同规范化端点的服务实例，不替代厂家全局锁或跨主机仲裁；部署中不要用不同主机别名重复配置同一物理设备。

在仓库根目录 `pnpm install --frozen-lockfile` 后，可运行 `pnpm --filter @auto-agent/climber-mcp --silent start`，也可用 `node --import tsx packages/climber-mcp/src/cli.ts` 作为客户端进程命令。tsx 是生产依赖，用于固定 TypeScript 入口。stdout 仅为 MCP 协议，不使用带脚本提示横幅的包管理命令接入客户端。`server.ts` 是无启动副作用的库入口，只有 `cli.ts` 或发行应用的程序注册表负责启动。

本服务作为独立 stdio 进程运行，不启动 Agent 或应用 HTTP 服务。Auto-Agent 通过官方 MCP SDK 和固定 Node CLI 接入；Corax 的公开原生 MCP connection 目前只支持 HTTP/SSE，所以由公开 defineTool/defineDynamic 适配本包导出的 contracts，不额外建立 HTTP 桥。每次调用使用受限环境并关闭子进程，设备预留仍持久保留。应用配置为 `climber: {enabled, serviceURL, timeoutMs}`，集成状态固定保存于 `dataDir/climber`；不自动读取旧配置或迁移外部服务数据。

宿主以 MCP _meta 注入可信 session-id 与稳定 operation-id，不由模型提交。SAM 文件与登记、启动是独立操作，失败/取消后核验实际文件或厂家批次，不重发未知写入。`reconcile_operation` 是额外的操作者核对能力，不在 Agent 工具列表内，不是厂家 stop 命令；核对保留原始 unknown，禁止重放未知批次。

工具输入和输出由 `src/vendor.ts` 定义。只提供已确认的四项厂家能力，不含 stop、pause、历史任务或文件上传。登记使用原管号，适配器返回1..72的映射。厂家请求超时或身份矛盾返回 OUTCOME_UNKNOWN；客户端不得自动重发写操作。

`pnpm --filter @auto-agent/climber-mcp test` 验证包自身的并发预留和恢复，当前根 `pnpm test` 包含这些工作区测试，不访问真实仪器。旧根 MCP 集成测试保留为迁移参考。独立包构建使用 `pnpm --filter @auto-agent/climber-mcp build`；真实接入与目标平台验收需单独验证。
