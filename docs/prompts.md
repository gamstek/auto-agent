# 提示词职责

应用 authored 路径（instructions、tools、skills）相对仓库的 `corax/` 目录。

| 所有者                                | 内容                                               |
| ------------------------------------- | -------------------------------------------------- |
| instructions.ts                       | 身份、中文回复、复用输入、按目标使用能力与证据边界 |
| tools/wiki.ts                         | 通用 Wiki 集合、查询、显式摄入及来源/分页契约      |
| packages/climber-mcp/src/contracts.ts | SAM 与四项设备工具的 schema、操作边界及未知写恢复  |
| tools/climber.ts                      | 按配置向 Corax 暴露 MCP 契约，不复制领域指导       |
| device-automation Skill               | 方法、材料规则、文件准备与设备/流程任务路由        |
| llm-wiki Skill                        | 用户文本知识的查询、原文核对和显式维护             |
| packages/llm-wiki/src/prompts.ts      | 摄入专用分析/生成提示词，不复用聊天角色            |

自定义 systemPrompt 替换角色，共享原则追加一次；Corax 负责技能与默认工具指导。角色不重复工具 schema、仪器常量或数值程序。

## 内置资料

两份材料规则是 Skill references/materials 内的人工指导，按需通过原生资源阅读。历史 SQLite 是 Wiki reference 集合的只读证据，用户知识在 knowledge 集合；二者共享通用 Wiki Tool，不共享摄入流程。Skill 按目标组织方法解释、资料查询、文件准备和执行，不再提供领域专用查询工具或 guidance 操作。加载技能不自动提供设备连接或宿主执行。

当前应用通过 Climber MCP 的 sam_file 提供 SAM 宿主文件能力；启用配置后再提供设备工具。MCP 包拥有工具契约、实现与完整产品配置，Skill 参考文档拥有产品、单位和工作流指导；角色不重复这些契约。通用宿主执行由独立的 ShellJS Provider 提供，仍保留 Corax 原生工具；角色只追加实际 OS、工作目录和资源目录等运行环境事实，不复制工具 schema 或领域程序。

## LLM Wiki 摄入

分析阶段结合纯文本、purpose/schema、目录和相关页，输出简洁的最终事实分析、实体、概念、关联与冲突；生成阶段据此写出/合并 Markdown 页。都不要求输出隐藏思维过程。

原文和现有页是证据，不覆盖维护指令。内部模型调用没有工具或文件执行权限；应用验证路径、来源引用和发布基线后才写入。更新不能丢弃其他来源的引用，矛盾和未决项继续保留。

普通查询只读已整理页面，必要时回读固定原文。只有用户明确要求导入/更新才 ingest；不把聊天回答自动晋升为事实。按 completed 说明批次完成、取消与失败，不声称全部回滚或自动重试。

结构 lint 不代替语义判断，文档结论不证明设备状态或科学批准。
