# Monorepo 与通用 Agent 边界

Agent 基座的源码现状、职责问题和建议调整顺序见 [agent-foundation.md](./agent-foundation.md)。工作流与设备扩展暂缓，先收敛通用核心的协议和生命周期。

Wiki 的统一资料入口、解析扩展、版本化引用和迁移设计见 [wiki-redesign.md](./wiki-redesign.md)；已实现的第一阶段见 [wiki-progress.md](./wiki-progress.md)。`@auto-agent/wiki-core` 拥有通用索引和引用协议，`@auto-agent/wiki-sam` 独立实现格式解析，应用组合层注册解析器。旧发布资产尚未全量切换。

## 工作区

使用 **pnpm workspace** 管理所有 JavaScript/TypeScript 包，根目录只有一份 `pnpm-lock.yaml`：

```text
auto-agent/                       # 根工作区：Agent/CLI/HTTP 发行应用
├── package.json
├── pnpm-workspace.yaml           # 工作区、共享依赖 catalog、构建脚本允许项
├── pnpm-lock.yaml
├── tsconfig.base.json
├── src/
│   ├── agent/                    # 通用模型循环
│   ├── tool/                     # 通用工具与 Skill 执行约束
│   ├── mcp/                      # 通用 stdio MCP 客户端与操作审计
│   ├── storage/                  # 会话、执行和通用操作记录
│   └── integrations/             # 发行应用组合、页面数据适配、内置程序注册
├── desktop/                      # auto-agent-desktop：Tauri + React 应用
│   ├── package.json
│   └── src-tauri/Cargo.lock      # Rust 仍由 Cargo 管理
└── packages/
    └── climber-mcp/              # @auto-agent/climber-mcp：独立设备 MCP 服务
        ├── package.json
        ├── tsconfig.json
        ├── src/
        └── tests/
```

根工作区包含现有 Agent/CLI/HTTP 应用，桌面和 MCP 服务分别是独立工作区包。无需分别进入目录安装依赖。

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm desktop:test
pnpm desktop:dev
pnpm --filter @auto-agent/climber-mcp test
pnpm --filter @auto-agent/climber-mcp build
```

`pnpm test` 执行根目录 Bun 测试及包级测试；Playwright 单独通过 `pnpm desktop:test` 运行。`pnpm typecheck` 检查根应用和各工作区。Bun 1.4.2 仅承担运行、测试和编译，`bun:sqlite` 不能改成直接用 Node 执行。依赖安装统一使用 pnpm，不生成 Bun/npm/yarn 锁文件，不安装 npm 的 `bun` shim。

桌面前端、构建脚本和 E2E 分别通过对应 tsconfig 检查。桌面准备后端时调用根工作区公开的 build 脚本，而不是导入根应用源码。

共享 SDK、Zod、Bun 类型和后端 TypeScript 版本由 workspace catalog 固定；内部依赖用 `workspace:*`，通过包 `exports` 引用。例如应用组合层使用 `@auto-agent/climber-mcp/server`，不能跨目录导入 `../../packages/climber-mcp/src/...`。

## 通用内核不得识别业务名称

Agent、工具执行、MCP 客户端和通用审计层不能依据 Skill 名称、脚本文件名、设备品牌或厂家命令走不同策略。

禁止这种实现：

```ts
if (input.skill === '某个业务 Skill') {
  /* 专用执行分支 */
}
if (toolName === '某个厂家的启动命令') {
  /* 仪器校验 */
}
```

通用层只使用：

- 已发现的工具 schema 和宿主配置的读写权限。
- 通用加载要求、路径边界、取消和资源限额。
- 通用操作意图、结果分类、未知效果与操作者核对。
- 与业务无关的调用来源和操作 ID；不解析批次、分析口或管号。

`tests/unit/generic-boundaries.test.ts` 约束这些边界。历史同名 Skill 的回归 fixture 也验证：启用 MCP 后不会因 Skill 名字而改变脚本执行规则。

## 业务能力与应用展示

```text
Agent ──► 通用 McpService ──► 标准 MCP 服务
                                   ├── Climber
                                   ├── SSH
                                   └── 其它配置的能力

桌面仪器页 ──► 应用 HTTP 扩展 ──► 通用 MCP 只读调用
```

- **Skill**：领域知识与流程指导，没有宿主特判。
- **Climber MCP 包**：厂家协议、就绪判断、批次约束、管号映射、设备预留与服务端核对；独立持久化在它自己的状态目录。包不导入 Agent 的 Store 或会话实现。
- **Agent MCP 层**：不 import Climber 包，不保存设备预留表；仅记录通用 `tool_operations`。远端 annotation 不自行授权。`outcomeContract: structured-v1` 是显式配置的通用结果约定，不按服务器名称识别。
- **应用组合层**：`src/integrations/mcp-servers.ts` 注册发行版包含的独立 MCP 程序；`--mcp-server <name>` 启动程序，不启动 Agent 或其数据库。
- **仪器展示扩展**：`src/integrations/instruments.ts` 只解释页面需要的状态数据，通过通用 HTTP 扩展注入。通用 API handler 不硬编码仪器路由，Agent 不持有仪器服务。
- **桌面设置**：属于应用功能，可以生成 Climber 的标准 `command/args/env/tools` 配置；这不是 Agent 核心认识 Climber。

`devices` 仅为仪器页面的可选展示绑定，通用配置加载器和 Agent 不消费它。没有仪器页或展示绑定，标准 MCP 工具仍能独立工作。

MCP 的 `cwd` 默认使用所选共享配置目录，也可显式指定；桌面运行快照保留这个基准。命令路径相对配置目录解析，参数按数组原样传递，服务自己的相对文件路径从配置的 cwd 解释。

后续持久化工作流执行器也必须保持通用：根据版本化流程定义调度声明的工具步骤，不在引擎中硬编码 `climber-batch`。首个业务流程模板由业务包/可信 Skill 提供，设备规则继续由 MCP 服务实现。
