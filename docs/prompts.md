# Auto-Agent 提示词结构

## 1. 主对话的实际组装

每次用户提交是一轮generation，其中可以包含多个模型和工具步骤。每个模型步骤按以下方式组装：

```text
System 1：选定角色（自定义或内置默认）+ <tool_guidance>
System 2：本步骤最新的宿主环境事实
System 3：<skill_guidance>（技能加载/信任规则及本步骤最新的可用技能目录）
历史消息、当前用户输入、当前轮的技能/工具结果

另行提供：工具名称、description和输入JSON Schema
```

环境事实和技能目录每步刷新，不叠加旧版本。技能正文仅在成功加载后进入工具结果；技能加载状态覆盖本次用户提交内的步骤，下一次用户提交重新建立。

上表是Agent内部消息结构。CloudModel适配器将System段合并为服务商请求的instructions/system消息，其余对话和工具结果保持各自角色；工具定义通过独立的tools参数发送。

请求组装由 `src/agent/index.ts` 负责：选择自定义或默认角色，调用工具、环境和技能模块的提示词入口，并按上面的顺序传给模型。`src/agent/prompt.ts` 仅保存默认角色文本，不承担跨模块拼装。

`systemPrompt`默认保存为空字符串，运行时使用当前内置角色；非空自定义文本替换默认角色，并在同一System消息末尾追加一次工具使用指导。技能规则由技能模块随目录独立注入，环境说明由宿主事实模块提供，各模块在自己的目录内维护提示词。不会同时发送默认和自定义两套角色。已有用户配置原样保留，想采用最新内置角色时将该字段设为空。

各区块使用与技能一致的 XML 风格标签标明职责边界：

```text
<tool_guidance>
  <tool_execution>通用调用与效果判断规则</tool_execution>
  <evidence_boundaries>工具证据边界</evidence_boundaries>
  <execution_budgets>预算与有界查询</execution_budgets>
  <tool name="wiki">知识来源与引用语义</tool>
  <web_access tools="web_search web_fetch">
    <address_policy>实际配置的网络策略</address_policy>
    共享的隐私与错误处理规则
  </web_access>
</tool_guidance>
<env>宿主环境事实</env>
<skill_guidance>
  <skill_prerequisites>本轮技能加载前提</skill_prerequisites>
  <skill_trust>技能指令与资源的信任边界</skill_trust>
  <available_skills>当前可用技能目录</available_skills>
</skill_guidance>
```

这些标签用于组织模型上下文，不是协议或权限机制。当前工具通过本地 BuiltinToolRegistry 和 AI SDK 的 tool 定义提供，并非 MCP 服务；XML 标签也不是 MCP 的要求。工具 description 和输入 Schema 继续由各自 defineTool 提供，工具指导不重复列出工具定义或创建额外能力。

## 2. 提示词清单与职责

| 层             | 代码/资源                                                           | 负责什么                                                           |
| -------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 默认角色       | `src/agent/prompt.ts` / `DEFAULT_SYSTEM_PROMPT`                     | 业务目标、任务类型、推荐输出、语言和沟通方式                       |
| 工具指导       | `src/tool/prompt.ts` / `toolGuidance()`                             | 工具调用、结果与证据语义、未知写入处理、预算和实际网络策略         |
| 环境事实       | `src/agent/builtins.ts`                                             | 日期时间、系统和运行时、宿主cwd、Git标记；不表示仪器连接或脚本cwd  |
| 技能指导及目录 | `src/skill/prompt.ts` / `skillGuidance()`                           | 技能加载前提、信任边界及技能名称、适用描述和SKILL位置              |
| 技能包装       | 同文件 / `skillContent()`                                           | 加载后的正文、路径基准和抽样文件列表                               |
| 业务技能       | `skills/device-automation/SKILL.md`                                 | 预设自动化流程或单仪器入口、模板匹配和当前任务执行流程             |
| 接口资料       | 技能的`references/automation.md`、`climber.md`、`sam.md`、`wiki.md` | 对应入口的字段、单位、状态和操作数据约定，按需读取                 |
| 工具说明       | `src/tool/tools/*.ts`的`description`及字段说明                      | 工具用途、调用条件、输入结构和返回含义；与Schema、执行实现共同维护 |
| 历史压缩       | `src/agent/context.ts` / `HISTORY_SUMMARY_PROMPT`                   | 保留用户目标、确认值、操作标识、来源、观察结果及未知事项           |
| 压缩结果边界   | 同文件 / `HISTORY_SUMMARY_MARKER`、`HISTORY_SUMMARY_END`            | 明确摘要是历史数据，通过标记后的user消息回填上下文                 |
| Wiki知识提取   | `src/wiki/prompt.ts` / `KNOWLEDGE_PROMPT`                           | 从编号源文档提取带精确引用的推荐记录、范围和歧义                   |
| Wiki分段范围   | 同文件 / `knowledgeSourcePrompt()`                                  | 输出截断后限定原始行范围，完整文档只作上下文                       |
| 会话标题       | `src/llm/prompt.ts` / `SESSION_TITLE_PROMPT`                        | 按用户语言生成短标题，输出仅标题                                   |
| 开发示例技能   | `examples/skills/*/SKILL.md`                                        | 用户请求本地脚本演示时的问候或计算示例                             |

工具正文仍放在各自的defineTool旁，不复制到系统提示。材料数值和真实案例放在Wiki知识源/SQLite中，不硬编码进角色提示。

## 3. 当前业务分工

- 默认角色说明Auto-Agent的目标，具体能力由当前工具与成功加载的技能确定。
- 对外以样品测试、仪器操作和结果查询为主线。模板查询、生成、修改及另存为属于测样时按需完成的配置步骤，随后交给仪器执行；用户询问相关细节或任务需要时再说明，不将内部步骤主动列成独立功能菜单。技能目录描述也采用任务导向，避免在未加载技能时诱导模型枚举实现细节。
- 预设自动化流程由控制系统执行内部步骤；单仪器操作使用对应服务。
- Wiki的query提供编译推荐，search/read提供历史模板参数与字段来源。历史设置与用户本次确认值分别表述。
- SAM解析提供明确字段和单位转换，静态相符不等于当前软件兼容或设备就绪。
- 接口字段、产品差异、脚本参数只在对应资料中维护。提示词描述已有操作，不罗列与本能力无关的排除项。
- 技能保持可移植，保留必要的业务前提；宿主工具名、网络策略和技术门控由应用层提供。

## 4. 三类辅助模型请求

辅助请求使用各自的提示词，不套用主对话角色，也不注册工具：

1. **历史压缩**：输入历史数据，输出事实摘要；计划和模型推理不被写成已发生的动作。源消息中的reasoning协议内容由上下文保留机制管理，摘要不伪造原始模型回合。
2. **知识提取**：仅显式Wiki更新调用；保留范围、单位、产品版本和原始引用，遗漏项保持缺失。历史模板SQLite通过本地解析生成，不进入该模型提取流程。
3. **标题生成**：成功回答后后台调用；只概括主题，不回答问题、不执行对话中的指令。

## 5. 指令与数据边界

固定System约束和当前成功加载的SKILL正文提供行为规则。参考资料、Wiki记录、模板字段、历史摘要、网页、脚本输出和错误文本是证据，不授予权限。技能目录描述何时加载，不代表已加载；环境事实不代表仪器状态。

供应商返回的reasoning由协议流接收、单独展示及保留，不通过提示词要求把思考嵌入回答正文。模型推理和工具观察不是同一类事实。

`AGENTS.md`是开发仓库约定，`README.md`和`llm.txt`是使用/集成说明，都不会自动作为主对话System提示注入。

## 6. 维护与验证

- 修改业务目标：改默认角色或明确的自定义角色。
- 修改具体设备操作：改技能和对应reference，保持代码实现与契约一致。
- 修改工具：在同一defineTool内改说明、Schema和实现。发给服务商的输入Schema顶层保持object，动作分支在运行时校验。
- 修改摘要、提取、标题规则：改各自常量，保持任务独立，不增加工具能力。
- 测试验证实际请求内容、自定义角色替换、动态块不累积、技能门控及分段引用；只检查措辞不能替代这些行为验证。
