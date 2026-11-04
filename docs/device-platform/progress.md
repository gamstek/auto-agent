# 实施状态

本页记录源码实施情况，不代表安装包发布或真实仪器验收。通用内核和包边界以 [architecture.md](../architecture.md) 为准。

## 已落实的架构修正

- 使用 pnpm workspace，根应用、desktop 和 packages/* 共享锁文件；包之间使用 workspace:* 和 exports。
- Agent 只依赖通用 `McpService`，不持有仪器服务。
- 不存在按 `input.skill` 的具体名称、脚本文件名、Climber 品牌或厂家命令进行判断的通用执行分支。
- 已删除宿主 device 业务层。仪器规则、批次约束、预留和独立状态数据库全部归 Climber MCP。
- 仪器页面是应用展示扩展；通用 HTTP handler 通过扩展接口挂载路由，没有仪器路由特判。
- devices 是可选页面绑定；没有绑定，Agent 仍可使用配置的 MCP 工具。
- 默认角色改为通用任务助手，业务方法与流程指导由 Skill 提供。

## 阶段状态

| 阶段  | 状态                                                                               |
| ----- | ---------------------------------------------------------------------------------- |
| P0    | 首版契约和通用/业务边界已确定                                                      |
| P1    | 通用 stdio 客户端、宿主工具允许列表、schema 校验、目录快照、预算和通用审计已实现   |
| P2    | 独立 Climber MCP 的四项厂家能力、持久化预留及显式服务端核对已实现；待打包/真机验收 |
| P3    | 页面/卡片/详情组件已拆分，轮询与 SSE 提示更新、重连快照、隐藏/离开停止刷新已验证   |
| P4    | Skill 指引使用 MCP，原直控脚本仅保留在测试 fixture；SAM 与模拟流程独立             |
| P5–P9 | 通用持久化流程、流程恢复、常驻服务、定时与跨设备调度待实施                         |

## 代码位置

- `src/mcp/`：通用客户端、权限、契约验证及执行；不 import 仪器包。
- `src/storage/index.ts`：通用 `tool_operations` 和会话核对，不存在设备预留表。
- `packages/climber-mcp/src/controller.ts`：设备预留、厂家前置检查及服务自身 SQLite；不 import Agent Store。
- `src/integrations/mcp-servers.ts`：发行应用的内置程序注册表；`--mcp-server <name>` 独立运行程序。
- `src/integrations/instruments.ts`：只读页面状态投影，不参与工具执行。
- `desktop/src/components/Instruments/`：仪器页，仅调用清单/状态/刷新接口。
- `desktop/src/components/InstrumentCard/`、`InstrumentDetails/`：独立卡片和详情展示及各自样式。
- `desktop/src/hooks/useInstruments.ts`：串行化轮询与快照获取，处理 SSE、重连、可见性和订阅清理。

当前阶段任务为39项完成、37项待办（P5–P9共36项，P2交付验收1项）；真机验收单列保留，不计为已完成。明细以 implementation-plan.md 为准。

## 验证与未决验收

通用边界由 `tests/unit/generic-boundaries.test.ts` 约束；同名历史 Skill 的测试验证它与其它 Skill 执行规则一致。根测试覆盖通用 MCP、真实 stdio 子进程和应用 API；Climber 包的独立测试覆盖无 Agent 身份的标准调用、并发预留与未知效果恢复；桌面 UI 使用本地桥接 mock。

使用 `pnpm typecheck`、`pnpm test`、`pnpm desktop:test` 验证整个工作区。未运行付费模型的 Skill A/B 实测，不宣称模型任务成功率已经提升。

P3收尾的针对性验证已通过：工作区类型检查；MCP/SSE、Agent、CLI renderer及通用边界测试31项通过，保留3项既有 skip；完整UI测试21项通过。新增用例覆盖通知字段白名单、重复状态抑制、无事件重放、发布失败不污染快照、刷新回路防护、断线恢复、隐藏/卸载清理，以及聊天和仪器订阅共存。

已增加公共二进制验收：从仓库外目录启动，清空 PATH，验证应用能够启动内置 MCP、读取厂家 mock 状态且正常关闭；确认一次刷新只产生一次厂家查询，避免库入口在打包后重复启动。Windows 使用隔离临时产物验证，不覆盖运行中的开发程序或重打安装包。Linux 运行验收由对应平台 CI 执行。真实仪器只读连通与实际登记/启动仍需另行验收，不能用本地 mock 代替。

当前没有宿主持久化流程、计划任务或关闭桌面后的无人值守承诺。后续引擎必须读取业务包提供的版本化模板，不能把 Climber 流程重新硬编码进通用 Agent。
