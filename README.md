# Auto-Agent · 量仔

本地分析仪器助手，运行于 **Node.js 24+、npm `@coraxjs/core`、Tauri 2 和 React**。Corax 管理会话、工作流、事件、技能与工具执行；应用、工具与 Climber MCP 使用 Corax 官方支持的 Node 运行时及 node:sqlite。

## 能力与指导

- **Wiki Tool**：Agent 通用的知识查询与显式摄入能力，补齐 Corax 当前没有提供的 Wiki 功能。
- **knowledge-base Skill**：用户知识库的查询、原文核对和显式整理工作流；底层知识编译由 LLM Wiki 引擎实现。
- **sam_file Tool**：Climber（研发别称 G5）和 SiCOPE（研发别称 G12）的 SAM 文件处理能力，由 MCP 提供。
- **Climber Tool**：Climber 仪器的健康、当前状态、批次登记和启动能力；SiCOPE 文件支持不等于已接入其设备控制。
- **device-automation Skill**：方法、材料规则、文件准备及测样流程指导，按目标组合 Wiki 和 Climber。
- **宿主执行环境**：通过 ShellJS 接入真实宿主 Bash 与文件系统，保留 Corax 原生工具，不使用 JustBash 虚拟环境。
- **跨会话长期记忆**：使用 Corax 原生记忆能力，保留稳定的仪器使用背景、实验偏好和用户要求延续的项目摘要，重启后继续可用。
- **个性化问题推荐**：欢迎页根据最近会话主题、提问与当前可用能力，调用已配置模型静默更新推荐问题；模型不可用时保留通用问题。

Wiki 统一提供 collections/catalog/search/read 等操作。knowledge 集合保存用户文本编译的知识页；reference 集合提供随版本发布的只读证据。统一工具入口不改变数据归属，不把预置资料送入用户摄入流程。

### device-automation 内置资料

- Skill 的 `assets/library.sqlite`：178 份历史 SAM 只读证据，随 Skill 发布。
- Skill 的 `references/materials/选择规则.md`、`模板定义.md`：人工维护的材料、预处理与测试规则。
- 历史证据通过 `wiki` 的 reference 集合查询；两份人工规则是 Skill 指导，直接按 references 阅读。没有独立的设备资料查询工具、SQL 或数据库路径操作。

这些资料随版本发布，不进入用户 LLM Wiki，不交给模型重写。历史参数不代表当前仪器状态、科学适用或完整可执行模板。

### 本机 SAM 文件操作

`sam_file` 由 `@auto-agent/climber-mcp` 提供，支持 `profiles/inspect/compare/create/modify/save-as`。Auto-Agent 用官方 MCP SDK 和当前 Node 启动固定 stdio 服务，将其契约接入 Corax 工具；无需通过 Shell 查找解释器，也无需配置厂家地址即可处理文件。SAM 实现和完整产品配置在 MCP 包内，Skill 只保留领域工作流。

路径为 MCP 宿主的原生绝对文件路径，不是 Shell 的 POSIX 路径表示或 `/workspace` 别名。新建未指定路径时默认保存到用户主目录的 `Auto-Agent/templates`；复用返回的 `file.path`。修改/另存为核对源哈希；失败、超时或取消后先核验文件，不自动重试。文件成功写入不代表厂家主机可访问，也不会登记或启动仪器。

### Climber 设备连接

桌面“设置 → 仪器”默认开启 Climber，并预填本机厂家接口 `http://127.0.0.1:18080/api/v1`。可修改为实际厂家 HTTP(S) `/api/v1` 地址，或在唯一配置文件中设置 climber。设置空闲应用后，助手获得健康、当前状态、登记和启动四项工具；仪器页只读展示 MCP/厂家状态，不提供设备写入入口。

登记与启动分开执行，保留批次、实验、原管号及厂家路径。未知写入记录由 MCP 服务持久保存在 `dataDir/climber`，重启不解除阻断，也不重发操作。详情见 [Climber MCP](packages/climber-mcp/README.md)。

### 用户 LLM Wiki

LLM Wiki 接受纯文本并提前编译知识：

```text
UTF-8 Markdown/TXT → LLM 分析 → 生成/合并 Markdown 知识页
                                      ↓
                            实体、主题、交叉引用、来源、目录和日志
```

它不只是给原文切块建索引。知识页是持久产物；普通问答读取已整理内容，必要时回读原文，由当前 Corax Agent 形成有来源的回答。

只接受 `.md`、`.markdown`、`.txt`，也校验内容不是二进制。没有 SQLite 资料包导入、数据库路径、SQL 或 SAM 解析接口。

### 跨会话长期记忆

可以告诉助手“记住：我长期研究多孔碳材料，报告需要列出方法和单位”，或“下次继续这个测试项目，请记住目标、已确认约束和方案文件位置”，也可以要求“忘记这条偏好”。助手通过 Corax 原生记忆工具保存、删除；同一 dataDir 下的新会话会自动召回，关闭或重启应用后仍保留。记忆使用 Corax 的有界文本存储，默认最多 4000 字符，不是完整聊天历史。

`corax/memory.ts` 使用公开 `defineMemory`、`fileMemory` 和 `sqliteMemory`，数据存于 `dataDir/corax/memory.sqlite`。命名空间和本地用户作用域固定，不随会话 ID、启动令牌或安装目录改变；切换 dataDir 则使用对应目录中的记忆。

长期记忆可保留仪器使用背景、长期材料与测试需求、命名及报告习惯，以及用户明确要求下次继续的项目简短目标、约束和持久资料引用。可复用实验条件须经用户确认并注明适用范围，单次参数不自动成为默认条件。完整 SAM、详细方案与结果保留在实际文件中；明确授权后才整理进用户知识库。

记忆不保存凭据、应用配置副本、临时测试参数、执行状态或写入回执，也不构成本次执行授权。当前确认、工具结果和技能文档优先；批次登记或启动、管号完成、设备在线及未知写入状态须另行核验。删除记忆不删除聊天记录，删除聊天记录也不等于删除记忆。

### 欢迎页问题推荐

连接后预取一组推荐；返回新会话页或最近会话发生变化时，欢迎页使用当前模型静默更新 4 个相关问题，不显示加载或失败提示，也不阻塞输入。已有推荐会在新建对话的首帧复用，首次无结果时不先闪现通用问题；模型不可用后才回退。上下文限定为最近 3 个原生会话的主题及有限事件后缀中的近期提问，并结合当前设备工具启用情况与知识来源数量；不读取全部聊天历史。不要求匿名兼容服务必须填写 API Key。

推荐生成是无工具的独立模型请求，不创建聊天、不修改记忆或知识库，也不登记或启动设备。点击问题才进入普通聊天受理流程。同一上下文的成功结果缓存 5 分钟，失败结果缓存 1 分钟；仅保存有界的进程内推荐结果，使用情况变化或后端重启后重新判断。

## 开发与启动

仅使用 **pnpm 10.15.1** 安装依赖。应用、Corax CLI、MCP、构建与发布脚本使用 **Node.js 24+**；系统 Bun 1.4.2 仅用于部分测试。

ShellJS 调用宿主已安装的真实 Bash；Windows 使用 Git Bash，需使 Git/Bash 可通过 PATH 发现。ShellJS 不提供 Bash 解释器。`corax/sandbox.ts` 使用 Corax 公开 Provider 接口，文件和程序都在真实宿主执行；工作目录为 `dataDir/workspace`，Skill 引用由 Provider 绑定到实际安装资源，不依赖构建机的模板缓存。

```powershell
pnpm install --frozen-lockfile
pnpm dev
pnpm dev:desktop
```

- CLI dev/build 与桌面开发默认使用项目内 `.auto-agent/config.json`，缺失时创建当前配置。
- `pnpm dev` 使用 Node 启动 Corax 原生 `dev --resume`；桌面开发使用 `dev --no-ui --resume`，前端由 Vite 热更新。仍有有效运行快照的旧会话由 Corax 恢复；已取消或快照已清理的运行不能由应用复活。
- Corax 应用集中在 `corax/`：agent、instructions、sandbox、memory、lib、tools、channels 和 skills。CLI 与桌面以此为项目根目录，开发监听不扫描相邻的桌面 Cargo 构建目录。该 workspace 包保留 `auto-agent` 名称和会话身份；仓库根包为 `auto-agent-workspace`。
- 开发配置和可选 `.env` 仍位于仓库根目录，构建产物位于 `corax/.output`；独立源码目录不改变既有数据路径。
- CLI start、正式桌面版与 LLM Wiki CLI 默认使用 `~/.auto-agent/config.json`。
- CLI 用 `AUTO_AGENT_CONFIG` 选择配置；桌面可传 `--config` 或隔离的 `--data-dir`。
- Node 直接读取唯一 config.json，Corax 进程固定自己的内存配置。桌面忙碌时允许保存，空闲后重启生效。
- API Key 来自 `AUTO_AGENT_API_KEY` 或桌面 OS keyring，不写进 JSON，也不返回 WebView 明文。
- 是否需要 API Key 由所配置的模型服务决定；无需认证的本地或自建兼容模型服务可不填 Key。模型服务返回 HTTP 401/403 时，会明确提示检查服务地址、凭据和模型访问权限。

## 当前配置

```json
{
  "dataDir": ".",
  "model": "deepseek-flash",
  "baseURL": "https://api.deepseek.com",
  "maxInputTokens": 128000,
  "maxOutputTokens": 16000,
  "systemPrompt": "",
  "climber": { "enabled": true, "serviceURL": "http://127.0.0.1:18080/api/v1", "timeoutMs": 5000 },
  "llmWiki": {
    "sources": [{ "id": "manuals", "type": "directory", "path": "knowledge" }]
  }
}
```

所有相对路径相对所选配置文件解析。来源可以是 file 或 directory，格式限制由服务固定执行；没有 builtin/bundles/include/解析器配置。旧 wiki 与历史字段直接报错，不做转换。

## 使用 LLM Wiki

在桌面“设置 → 用户知识库”添加文本文件或目录，等待设置保存并生效，再点击“开始整理”（或“整理全部资料”）。该操作会调用当前模型并保存知识页；仅添加来源、查看状态和普通查询不会调用摄入模型。

页面区分待整理、已整理、需要更新和需要核对，展示分析/生成/发布阶段、已完成资料和生成页面，可分页预览正文。取消会等待实际处理结果并保留此前已发布内容，不自动重试；移除来源只取消后续整理，不删除已生成知识。仍可在聊天中明确要求助手整理配置来源，或使用下方 CLI；`wiki` 是通用工具，`knowledge-base` 是操作指南，`packages/llm-wiki` 是编译引擎，`dataDir/llm-wiki` 是持久内容。

也可使用 CLI。摄入使用当前配置的模型服务；服务需要认证时，CLI 从 `AUTO_AGENT_API_KEY` 读取 Key，桌面使用传给 Corax 的系统凭据。免认证服务可以不填 Key。

```powershell
# 维护开发目录时明确选择开发配置
$env:AUTO_AGENT_CONFIG = (Resolve-Path '.auto-agent/config.json').Path
pnpm llm-wiki init                      # 可选：先创建 purpose/schema，无模型调用
pnpm llm-wiki ingest                    # 处理配置的文本来源
pnpm llm-wiki ingest manuals            # 只处理指定来源
pnpm llm-wiki ingest --file '资料.md'    # 显式导入一份文本
pnpm llm-wiki catalog
pnpm llm-wiki search '关注的主题'
pnpm llm-wiki lint
pnpm llm-wiki reindex
```

- ingest：先分析事实、实体、概念和冲突，再生成/合并页面。未变更且产物完整的来源复用。
- search/read/source：通过通用 `wiki` 工具的 knowledge 集合查询知识页与固定原文，支持分页；reference 集合使用 catalog/search/read 查询预置证据。
- reindex：只重建检索缓存，不调用模型、不代替摄入。
- lint：检查结构、链接和来源完整性，不代表语义无矛盾或科学结论获认可。

原文和知识页按版本保留。新版本完整写入后才切换发布指针；失败或取消保留上一可用版本。批次按来源逐项提交，已完成来源不会因后续取消被回滚；失败报告列出 completed，不自动重试。

## 数据布局

```text
dataDir/
├─ config.json                    默认 dataDir 为配置所在目录
├─ .data-layout
├─ corax/                        Corax 会话、工作流、日志与缓存
│  └─ memory.sqlite              Corax 原生长期记忆（持久内容）
├─ climber/                      MCP 拥有的设备预留与操作结果，按厂家端点区分
├─ workspace/                    原生工具共享的真实宿主工作目录
└─ llm-wiki/
   ├─ raw/sources/               原文固定版本
   ├─ purpose.md                知识库目标
   ├─ schema.md                 维护规则
   └─ .state/
      ├─ current.json
      ├─ search-index.json      可重建缓存
      └─ generations/<uuid>/
         ├─ manifest.json
         └─ wiki/               持久 Markdown 页面、index/overview/log
```

目录查询会返回实际 wikiDirectory。发布版本目录是知识内容，不是可以随意删除的缓存。参考 [LLM Wiki 实现](packages/llm-wiki/README.md) 和 [设计](docs/llm-wiki-design.md)。

## 桌面、安装与更新

Rust 直接使用 Node 启动标准 `corax dev/start` 并连接其认证 HTTP/NDJSON。React 使用官方 reducer。没有额外应用 HTTP 桥接或 `auto-agent-backend.exe`。

`pnpm prepare:runtime` 将 Corax 产物、生产依赖、内置仪器资源、Node/许可证和安装初始化脚本部署到 `desktop/src-tauri/runtime`；`pnpm build:desktop` 在 Windows 构建 NSIS 安装包。依赖使用共享锁文件部署为普通目录，发布树不得包含目录链接。打包白名单不包含用户配置、凭据或运行数据库。

Windows 构建后运行 `pnpm test:installer`（需安装 7-Zip），解包实际 NSIS 产物并在隔离目录验证启动、Wiki、SAM、MCP 和旧应用资源清理；验证不执行安装器，不接触个人安装目录和用户数据。

本 Beta 当前布局标识为 `corax-node-llm-wiki-v1`。Windows 安装器对没有此标识的默认旧 `~/.auto-agent` 执行一次重置，旧配置、会话及该目录中的资料会清除，安装前需保留的内容应备份。同布局后续安装保留数据；开发启动不执行此清理，也不追踪外部 dataDir。

Rust updater 使用固定 stable/Beta GitHub feed，下载并校验签名后才停止空闲后端。发布需要更新公钥与签名私钥；用户在“关于与诊断”检查并安装更新。未配置公钥的开发构建不可更新。

更多：[架构](docs/architecture.md)、[应用接入层](docs/application-layer.md)、[提示词职责](docs/prompts.md)、[桌面](desktop/README.md)。
