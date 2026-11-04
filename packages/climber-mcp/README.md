# Climber MCP

pnpm workspace 中的独立标准 stdio MCP Server，提供 `get_health`、`get_status`、`register_batch`、`start_batch`。厂家规则、批次验证和设备预留都在本包实现，不依赖 Agent、Skill 名称或 Agent 数据库。

运行环境变量：

- `CLIMBER_SERVICE_URL`：明确配置的厂家 HTTP(S) `/api/v1` 地址。
- `CLIMBER_TIMEOUT_MS`：100–60000毫秒，默认5000。
- `CLIMBER_STATE_DIR`：本服务的持久化目录，默认 `~/.climber-mcp`；同一设备的多个本地服务实例应共用该目录。按规范化厂家地址区分 SQLite 文件。

预留协调范围是共用状态目录与相同规范化端点的服务实例，不替代厂家全局锁或跨主机仲裁；部署中不要用不同主机别名重复配置同一物理设备。

在仓库根目录 `pnpm install --frozen-lockfile` 后，可运行 `pnpm --filter @auto-agent/climber-mcp --silent start`，也可用 `bun --no-env-file packages/climber-mcp/src/cli.ts` 作为客户端进程命令。stdout 仅为 MCP 协议，不使用带脚本提示横幅的包管理命令接入客户端。`server.ts` 是无启动副作用的库入口，只有 `cli.ts` 或发行应用的程序注册表负责启动。

发行应用通过可选程序注册表提供 `--mcp-server climber` 入口，运行在独立 stdio 进程中，不启动 Agent、HTTP 服务或 Agent Store。Climber 自己的数据库记录批次操作与预留；未知写入不自动重放。`reconcile_operation` 是额外的操作者核对能力，不在默认 Agent 工具允许列表内，不是厂家 stop 命令；核对保留原始 unknown，禁止重放未知批次。

工具输入和输出由 `src/vendor.ts` 定义。只提供已确认的四项厂家能力，不含 stop、pause、历史任务或文件上传。登记使用原管号，适配器返回1..72的映射。厂家请求超时或身份矛盾返回 OUTCOME_UNKNOWN；客户端不得自动重发写操作。

`pnpm --filter @auto-agent/climber-mcp test` 验证包自身的并发预留和恢复；根目录 MCP 集成测试验证标准 stdio 连接。`pnpm test` 包含两层测试，不访问真实仪器。独立包构建使用 `pnpm --filter @auto-agent/climber-mcp build`；安装包/目标平台二进制验收仍需在打包阶段执行。
