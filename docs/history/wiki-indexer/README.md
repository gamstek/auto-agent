# 已退役的通用 Wiki 索引器

保留旧 wiki-core/wiki-sam 的实现用于追溯原始资料切块、SQLite FTS 和资料包设计。它们不再是 workspace 包，不被应用导入或打包，也不是 LLM Wiki 的兼容入口。

当前知识编译在 `packages/llm-wiki`，Agent 通用 Wiki 接入在 `lib/wiki`；仪器历史证据位于 `skills/device-automation/assets/library.sqlite`，通过 Wiki 的只读 reference 集合查询。此处保留代码不代表仍对用户提供数据库或通用解析器接口。
