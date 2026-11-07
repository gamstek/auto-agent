# Auto-Agent · 量仔

本地分析仪器助手，运行于 **Node.js 24+、npm `@coraxjs/core`、Tauri 2 和 React**。Corax 管理会话、工作流、事件、技能与工具执行；应用、工具与 Climber MCP 使用 Corax 官方支持的 Node 运行时及 node:sqlite。

## 能力与指导

- **Wiki Tool**：Agent 通用的知识查询与显式摄入能力，补齐 Corax 当前没有提供的 Wiki 功能。
- **Climber Tool**：SAM 文件与仪器操作能力，通过 Climber MCP 实现。
- **device-automation Skill**：方法、材料规则、文件准备及测样流程指导，按目标组合 Wiki 和 Climber。
- **宿主执行环境**：通过 ShellJS 接入真实宿主 Bash 与文件系统，保留 Corax 原生工具，不使用 JustBash 虚拟环境。

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

## 开发与启动

仅使用 **pnpm 10.15.1** 安装依赖。应用、Corax CLI、MCP、构建与发布脚本使用 **Node.js 24+**；系统 Bun 1.4.2 仅用于部分测试。

ShellJS 调用宿主已安装的真实 Bash；Windows 使用 Git Bash，需使 Git/Bash 可通过 PATH 发现。ShellJS 不提供 Bash 解释器。`corax/sandbox.ts` 使用 Corax 公开 Provider 接口，文件和程序都在真实宿主执行；工作目录为 `dataDir/workspace`，Skill 引用由 Provider 绑定到实际安装资源，不依赖构建机的模板缓存。

```powershell
pnpm install --frozen-lockfile
pnpm dev
pnpm dev:desktop
```

- CLI dev/build 与桌面开发默认使用项目内 `.auto-agent/config.json`，缺失时创建当前配置。
- `pnpm dev` 使用 Node 启动 Corax 原生 dev；桌面开发使用 dev --no-ui，前端由 Vite 热更新。
- Corax 应用集中在 `corax/`：agent、instructions、sandbox、lib、tools、channels 和 skills。CLI 与桌面以此为项目根目录，开发监听不扫描相邻的桌面 Cargo 构建目录。该 workspace 包保留 `auto-agent` 名称和会话身份；仓库根包为 `auto-agent-workspace`。
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

在桌面“LLM Wiki”中添加文本文件或目录，等待设置生效后，明确要求助手“摄入配置的文本来源”。工具会调用模型并保存知识页；普通查询不会自动摄入。

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
