# 统一 Wiki 实施进度

> 本文保留早期阶段的实施与原件核验记录。当前已发布 SQLite 资料包、统一文本/资料包配置和 Node 运行链路；现行入口与配置以 [README](../README.md) 和 [Wiki 说明](../wiki/README.md) 为准，下面的旧配置/命令不是当前兼容入口。

## 已完成的第一阶段

这轮已提供可运行的统一资料库，通过共享配置中的 `wiki.sources` 显式启用。旧配置和内置历史资产尚未全量切换；两套协议不会混在同一次 Wiki 工具调用中。

- `packages/wiki-core`：独立于 Agent Store 的 SQLite/FTS5 资料服务，稳定来源身份、内容版本、解析版本、引用单元、来源清单、构建记录。
- `packages/wiki-sam`：从宿主提取出的只读 SAM 解码和参考参数解析包。旧索引只保留兼容适配器，不复制两份解析实现。
- MD/TXT/JSON 与受支持的 SAM/SMP 共用扫描、解析、发布、搜索和阅读管线。未知格式登记为 unsupported；损坏的受支持文件会使本次发布失败并保留旧版本。
- 搜索按文档选取最佳命中单元，避免一个模板的几百个字段挤满结果页；支持中文词元、命名空间字段筛选和绑定 generation 的分页。
- 引用保留内容哈希和解析器版本。普通阅读不重新扫描原件，明确返回 `sourceVerified=false`；更新后旧引用仍可读取原来的内容版本，解除来源后的文档不可继续读取。
- 仅在源哈希、解析版本及已存单元/FTS 完整性都满足时复用缓存。`lint` 检查存储结构完整性，刷新可修复不完整的派生单元。
- 构建发布与完成状态在同一 SQLite 事务中提交。取消、解析失败、来源不可访问保留上一发布版本；关闭会取消在途构建。构建进程中断只记录 interrupted，不自动重放任务。
- 统一 `wiki` 模型工具提供 catalog/search/read，不要求任意 Skill 作为读资料的前置。资源读取和脚本执行的 Skill 限制保持各自契约。
- CLI、HTTP、模型工具共用同一服务。桌面原生配置快照会正确解析 `wiki.sources[].path`，普通设置保存保留该未展示配置及其原始相对路径。

## 案例库原件核验

用户提供的案例库已执行只读核验：

| 指标                |  结果 |
| ------------------- | ----: |
| 原目录文件数        | 1,136 |
| 旧 SQLite 记录数    |   178 |
| 找到且 SHA-256 一致 |   178 |
| 缺失 / 哈希不同     | 0 / 0 |
| 目录内 SAM 文件     |   178 |

旧快照 SHA-256：`2313a878670928b9ca4e0706a808d7c2ee2586243ebf191af8621721b9c7d246`。

统一索引已在临时验证目录中读取这 178 份原件和 1 份现有推荐文档，验证 179 份资料能同时检索；全部模板哈希和历史 labType 与旧快照一致，共 44,778 个模板解析单元可分页读取。未改动案例库原件或替换旧 `wiki/indexes/library.sqlite`。

案例库还有 PDF、Office、厂商数据、压缩包等文件。原件存在不等于这些格式已支持；本轮迁移验证明确选择 178 份 SAM 和推荐文档，不把其他文件的内容覆盖情况算作已通过。

可重复运行的离线检查：

```powershell
bun scripts/audit-wiki-library.ts --root "<案例库目录>" --snapshot wiki/indexes/library.sqlite
bun scripts/verify-wiki-migration.ts --originals "<案例库目录>" --snapshot wiki/indexes/library.sqlite --documents wiki/sources --state "<独立验证数据目录>"
```

前一条只读核验。后一条将解析索引写入明确指定的独立验证目录，不使用个人配置，不调用模型，不修改原件。

## 使用当前统一接口

参考 `examples/config.wiki.json`。将目录或单个文件登记到 `wiki.sources`；source ID 应保持稳定，路径相对所选配置文件解析。不要同时填写非空 `wikiRoots` / `wikiIndexRoots`。本阶段的统一模式只加载显式登记的来源，旧内置资料包尚未自动转换或接入，示例显式登记现有推荐原文。

```powershell
pnpm dev --config examples/config.wiki.json wiki refresh
pnpm dev --config examples/config.wiki.json wiki catalog
pnpm dev --config examples/config.wiki.json wiki search "石墨"
pnpm dev --config examples/config.wiki.json wiki lint
```

`wiki read` 接受 JSON 字符串，例如 `{"reference":{...搜索返回的引用...}}`。可省略引用的 unitId 以按 offset/limit 读取同一解析版本的所有单元；使用返回的 nextOffset 继续，不自行截断或跳到最新版本。

现行统一 HTTP 路由（需要既有 bearer 鉴权）：

| 路由                                                  | 行为                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------ |
| `GET /wiki`、`GET /wiki/catalog`、`GET /wiki/sources` | 索引状态、来源与解析字段目录                                       |
| `GET /wiki/documents?sourceId=...&offset=0&limit=100` | 包括 unsupported 在内的文档清单                                    |
| `GET /wiki/lint`                                      | 存储单元/FTS 完整性检查，不核验实时原件                            |
| `POST /wiki/search`                                   | 关键词、来源/资料集、注册字段筛选                                  |
| `POST /wiki/read`                                     | 固定版本引用和分页读取                                             |
| `POST /wiki/builds`，body `{}`                        | 对配置来源执行一次刷新，响应等待完成，断开取消；尚不是后台作业 API |

统一模式下旧 `/wiki/query`、旧 GET search 和 index/update 路由明确拒绝，不静默解释成另一种请求。

## 参考 llm_wiki 后的调整

已阅读用户指定仓库的 `llm-wiki.md`、`README_CN.md`，以及 `source-identity.ts`、`ingest-cache.ts`、`ingest-commit-coordinator.ts`、`search.ts` 和 MCP 入口。参考设计，采用本项目的 Bun/TypeScript/SQLite 实现，没有引入对该仓库的运行时依赖。

已吸收的要点：稳定来源身份与相对目录、缓存产物完整性校验、解析准备与原子发布分离、中文检索、所有入口共享检索服务、独立结构检查。

进一步明确：**最终 Wiki 不应止于文件搜索。原始资料、持续积累的 Wiki 页面、可重建检索索引具有不同生命周期。** 原始资料与 Wiki 页面可以统一检索，但要标明原文/派生内容及来源依赖。`pages` 是需要持久化、版本管理与导出的内容，不是可以随时丢弃的缓存。

本轮没有实现模型生成页面、双向链接图谱或自动摄入。后续页面维护将通过独立显式任务、来源版本引用和变更集发布实现，不把普通查询变成写入任务，不把聊天回答自动晋升为来源事实。

## 下一阶段

本轮验证：`pnpm typecheck` 全工作区通过；`pnpm test` 根项目 367 通过、9 跳过，wiki-core 10 通过、wiki-sam 2 通过、Climber 3 通过、桌面工具 1 通过。Rust 针对共享配置运行 11 项测试、针对原生接口范围运行 1 项测试，全部通过。真实原件验证从空库重建 179 份资料，第二次刷新复用全部 179 份。未调用真实模型、未执行设备操作、未打安装包。

1. 统一资料包发布/导入、原件或固定版本对象存储；完成内置资产构建切换，再移除旧两套运行路径。
2. 持久化 Wiki 页面、来源依赖与过期检测；导出可阅读的 Markdown 页面、目录和维护记录。页面链接/来源检查扩展到 lint。
3. 显式模型维护任务：基于证据提出页面变更集，验证引用后发布，记录模型/提示词版本。普通检索不依赖此能力。
4. 桌面资料管理：添加/移除来源、进度与逐项诊断；再考虑后台任务、目录监听及更多格式解析器。

当前未提供 bundle source、来源管理写 API、PDF/Office 解析、自动重试、向量检索或页面图谱。配置和接口仅采用本页已实现的部分；完整目标见 [wiki-redesign.md](./wiki-redesign.md)。
