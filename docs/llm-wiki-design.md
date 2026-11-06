# LLM Wiki 重新设计

状态：核心流程已落地。本文保留原设计边界；实际命令和数据布局以根 README 与 packages/llm-wiki/README 为准。

## 1. 纠正当前模型

当前 `wiki build` 的实际操作是：扫描配置来源、读取字节、计算哈希、调用本地解析器、写入版本/解析单元和 SQLite FTS。Markdown 解析器按最多 40 行或约 8 KiB 切块。没有 LLM 分析、知识综合、实体/主题页生成或跨页维护。

它是资料索引构建，不是用户最初要求的 LLM Wiki 摄入。当前“通用来源 + SQLite 资料包 + 内置领域库”应拆开，不能仅改名。

## 2. 参考依据

已阅读用户指定的 `C:/Users/lengjing/workspace/code/github/llm_wiki`：

- `llm-wiki.md`：原始资料、持久 Markdown Wiki、schema 三层；Ingest/Query/Lint；index/log 和交叉引用。
- `README_CN.md`：知识提前编译、持续维护，不在每个问题上重新综合所有原文。
- `src/lib/ingest.ts`：先分析，再生成；来源摘要、实体/概念页、来源 frontmatter 与页面合并。当前实现由应用管理聚合导航文件，不让模型反复重写整个大索引。
- `ingest-cache.ts`：来源哈希和已生成文件完整性共同决定是否跳过。
- `source-identity.ts`：来源身份不能只依赖同名文件的 basename。
- `ingest-commit-coordinator.ts`：准备与提交分开，发布有顺序。

参考这些核心流程，保留本项目的 Node/Corax 边界，不引入参考项目的另一套聊天 Agent。

## 3. 一个 Wiki 能力、两个数据集合与 Skill 指导

Wiki 是 Agent 通用能力，因 Corax 当前缺少原生支持而通过应用 Tool 补齐。knowledge/reference 区分数据归属和写入策略，不分别生成领域工具。device-automation Skill 按目标指导使用 Wiki 和唯一的 Climber 设备能力。

### A. device-automation 内置领域资料

内容：178 份历史 SAM 的已解析 SQLite 参考，以及人工维护的“选择规则.md”“模板定义.md”。

- 随版本发布，运行时只读，用来支持领域 Skill。
- SQLite 是内部存储，不成为用户导入类型，不接受数据库路径或 SQL。
- 两份 MD 是人工维护的规则原文，保留数值、范围、单位、报告勾选及待确认项，不经过 LLM 重写。
- 历史证据通过通用 wiki Tool 的 reference 集合检索/阅读，不与用户 LLM Wiki 共用来源配置；两份 MD 属于 Skill 指导，直接阅读 references，不提供专用 guidance 操作。
- 保留历史产品/软件版本、来源哈希、字段定位、presence/scope/active 和实验模式证据。
- 内置资产更新属于开发/发布维护，不属于用户 ingest。

目标位置：

```text
skills/device-automation/assets/library.sqlite
skills/device-automation/references/materials/选择规则.md
skills/device-automation/references/materials/模板定义.md
lib/wiki/reference.ts
tools/wiki.ts
```

SQLite 作为 Skill assets 下的独立二进制资产发布，Wiki 按应用绑定只读查询；两份人工 MD 放在 Skill references 中作为指导阅读。已有 SQLite 中重复收录的推荐文本在资产拆分时去除，历史 SAM 证据须逐项保持不变。

### B. 用户 LLM Wiki

对外只导入纯文本，首版限定 UTF-8 Markdown/TXT（`.md`、`.markdown`、`.txt`）。扩展名、编码和文件内容均需符合文本条件；改扩展名的 SQLite/其他二进制也不接受。

不提供 SQLite 资料包选择器、导入/导出数据库、数据库路径、SQL 或 SAM 解析接口。内置领域资产也不进入用户摄入队列。

## 4. LLM Wiki 的内容层

```text
dataDir/llm-wiki/
├─ raw/sources/          导入原文及其固定内容版本
├─ purpose.md            知识库目标与关注方向
├─ schema.md             页面类型、目录、引用和维护规则
├─ wiki/
│  ├─ index.md           导航目录
│  ├─ overview.md        当前知识概览
│  ├─ log.md             追加式维护记录
│  ├─ sources/           来源摘要
│  ├─ entities/          实体页面
│  └─ concepts/          概念/主题页面
└─ .state/               摄入哈希、发布记录、临时内容与可重建检索缓存
```

raw 是证据，wiki 是持久知识内容，检索缓存是派生数据。不能把生成的 Wiki 页面当作随时可以丢弃的索引缓存。Corax 的会话数据仍单独位于 dataDir/corax。

## 5. 摄入流程

1. **导入文本**：记录稳定来源身份和 SHA-256，保留原文，区分不同目录中的同名文件。
2. **检查是否需要处理**：原文哈希、摄入规则版本及生成物完整性均匹配才复用；只检查文件名或时间不够。
3. **LLM 分析**：结合 purpose、schema、现有索引和相关页面，提取实体、概念、主要事实、关联、冲突和未决问题。只保存简洁分析结果，不要求输出隐藏思维过程。
4. **LLM 生成/合并**：生成来源摘要，创建或更新相关实体/主题页，维护正文中的 wikilink。更新已有页面时保留其他来源支撑的内容，矛盾并列呈现，不能悄悄覆盖。
5. **应用验证与发布**：验证页面路径、frontmatter、来源标识、引用和写入基线；暂存完整变更后发布，失败或取消保留上次可用内容。不把截断分析当作完整输入继续生成。
6. **导航与检索**：应用根据已发布页面维护 index、日志和检索缓存。大索引不通过一次模型输出整体重写。

模型初期复用应用已配置的模型连接；摄入提示词独立于聊天角色。摄入是显式操作，不在启动或普通查询时自动调用模型。

## 6. 查询与检查

查询优先读取已经整理的 Wiki 页面，必要时回读其来源原文，交给当前 Corax Agent 形成带引用的回答。页面与原始证据应明确区分，引用保留来源内容版本。

LLM Wiki 不维护第二套聊天循环。普通查询不自动把聊天回答写成新事实；用户明确要求沉淀知识时，才进入维护流程。

Lint 分开表达两类结果：结构检查核对链接、来源和页面元数据；语义检查由 LLM 维护流程指出矛盾或过时结论。结构通过不代表科学正确。

## 7. 命名与接口

| 位置         | 目标名称/职责                                         |
| ------------ | ----------------------------------------------------- |
| 产品/UI      | LLM Wiki                                              |
| 配置         | `llmWiki`，只描述用户文本来源                         |
| 通用包       | `@auto-agent/llm-wiki`                                |
| 应用装配     | `lib/wiki/`                                           |
| 模型工具     | `tools/wiki.ts`，统一知识与参考查询，仅明确请求时摄入 |
| 维护入口     | `scripts/llm-wiki.ts` / `pnpm llm-wiki`               |
| 预置证据集合 | Wiki reference，独立于用户 LLM 摄入                   |

当前配置最小形式：

```json
{
  "llmWiki": {
    "sources": []
  }
}
```

文本来源可以是明确文件或目录；类型限制由服务固定执行，配置不能通过 include/glob 将 SQLite 重新接入。没有 builtin/bundles/数据库路径字段。

维护动词应明确区分：

- **ingest**：调用 LLM 提前整理知识，产生/合并 Markdown 页面。
- **search/read**：读取已发布知识及来源。
- **lint**：报告结构和来源问题。
- **reindex**：仅重建检索缓存，不生成知识。

旧的 wiki build 不继续充当“LLM 预解析”名称，也不静默转发到新流程。

## 8. 落地顺序

1. 先拆出内置 SQLite 与两份 MD，核对历史证据和原文内容不丢失，更新 Skill 的内置资料入口。
2. 建立纯文本 LLM Wiki 核心：raw/wiki/schema 分层、两阶段摄入、页面合并、来源和发布。
3. 将工具、CLI、配置和桌面入口统一到新名称，移除公共 SQLite 入口及旧的通用解析器配置。
4. 同步发布白名单、文档和配置初始化，整体切换，避免开发入口先改 schema 而功能尚未接通。

实现不读取参考仓库的运行时源码作为依赖，不执行真实模型摄入来验证代码，也不为切换设计删除用户个人资料。旧的通用资料库设计保留为历史记录，不再作为目标架构。

## 9. 实现中的发布目录

逻辑上的 wiki/ 树实际保存在 `.state/generations/<uuid>/wiki/` 中，current.json 只保存当前发布标识。这样发布是一次原子指针切换，查询可继续读取旧版本，新失败不会留下半套可见页面。catalog/ingest 返回实际 wikiDirectory，可直接阅读 Markdown；这些版本是内容，不作为检索缓存删除。检索缓存单独位于 .state/search-index.json。

内置历史资产位于 Skill assets/library.sqlite，人工指导位于同一 Skill references/materials；旧通用索引器源码归档到 docs/history/wiki-indexer，不参与 workspace 或应用发布。应用配置和对外工具不提供 SQLite 入口。
