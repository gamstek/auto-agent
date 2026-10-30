# 真实模型多场景问答验证

## 运行

从仓库根目录执行，使用当前配置的真实模型及 `AUTO_AGENT_API_KEY`，会产生模型调用费用：

```powershell
bun scripts/evaluate-live.ts
# 只复查指定场景，输出目录必须是新的空目录：
bun scripts/evaluate-live.ts --cases "methods,offline,wrong-product,missing-run-input" --output ".auto-agent-evaluations/recheck"
# 固定其它脚本/参考资料，仅更换技能入口做同题对照：
bun scripts/evaluate-live.ts --skill-body "path/to/old/SKILL.md" --eval-set "evals/device-automation/holdout.json" --repeat 2 --configuration old_skill
bun scripts/evaluate-live.ts --skill-body "skills/device-automation/SKILL.md" --eval-set "evals/device-automation/holdout.json" --repeat 2 --configuration with_skill
```

默认输出到 `.auto-agent-evaluations/<timestamp>`，目录被 Git 忽略。使用 `examples/config.json` 的模型、工具预算和内置资源，替换为隔离的 dataDir、模板目录及本地模拟厂家 URL，不复用生产会话或厂家地址。每个场景单独启动 `bun run dev --config ... --json`，只有同一场景内的追问共享会话。脚本不会被 CI 单元测试、应用启动或聊天自动执行。

## 覆盖场景

- 普通问候、BET/BJH解释、石墨推荐及引用、只读状态查询。
- 包含 bet/bjh 变量名的普通编程问题、包含设备名的通知润色，检查相近词汇不会误触发仪器技能。
- 缺少称量时保存待填模板；实际生成、原地修改、报告勾选与另存为。
- 不支持气体的配置能力确认；厂家忙碌、查询失败、管号取余冲突、产品不匹配。
- 缺少分析口/原管号时只询问缺项；登记明确拒绝后不继续启动。
- READY → STARTING 的状态区别；登记或启动回执身份不明后阻断依赖并返回持久化诊断。
- 上一批 COMPLETED 不作为目标批次完成；预设自动化清单与 simulation 标记。

全部设备请求只指向本地测试服务。服务会真实读取测试SAM并校验样品参数，按场景返回错误、READY、STARTING或身份冲突。模拟回执不证明真实仪器动作或厂家设备验收。

## 结果与判定

根目录有 `summary.json`、`results.json`；每个场景有 `result.json`、各轮 `turn-*.json`、渲染后的 `reply-*.txt`、`dev-stderr.log`、模板和宿主文件日志。

manifest.json 保留模型、预算、技能入口哈希和对照时共享脚本/资料哈希。对照组均使用配置的 dev 模型；--skill-body 只覆盖暂存技能包的 SKILL.md，其它文件保持当前版本，避免把代码改进与提示词改进混为一谈。--repeat 支持1–3次，每次独立会话；记录实际主生成步骤、耗时与SDK报告用量，失败步骤缺少用量时保持未知，不把字符数冒充token。

`holdout.json` 是改写问法集合：首次运行可检查未见问法，参与过反馈后应视为回归用例，不能继续宣称是独立保留测试集。小样本的作者评审不能证明普遍优越；回复、工具轨迹与实际文件应和分数一起评审，可按 skill-creator 的 grading/benchmark 格式交给其 review viewer 展示。

自动检查文件版本/结构、精确字段差异、UUID、报告选择、源文件哈希、实际HTTP顺序、禁止错误写入、未知结果后的诊断和命令名等不变量；不会把模型输出中的“成功”当作文件或设备成功。

人工还要检查物理量与单位是否正确、是否过度推断状态、引用是否支持结论、是否重复问已有值、是否读取无关大文件，以及回复是否围绕当前目标。自动通过不等于所有技术表述已获科学确认。某次采样通过也不保证模型后续永远采用相同工具顺序。

保留原始失败记录，再区分应用缺陷、模型服务错误与判据误报。例如 CO₂/CO2 的显示差异不能判为没有解释气体；明确报告503及未确认字段的正确回答，不应因没有某个中文关键词被判为“报告就绪”。模型请求超时也不能归因于厂家登记拒绝；日志应明确 model_timeout，且不可自动重放写操作。

## 已复现的设计缺口

真实问答曾发现：报告选择没有轻量修改入口，模型读源码和大型配置库直到步数耗尽；已给定方法、称量时仍要求重新推荐或提供模板；把枚举暂不归一化理解为必然无效；把状态服务失败当成物理不就绪；方法解释混淆面积基准和质量归一化。相应修复分别落实在脚本接口、目标路由、按需参考文档及实际错误反馈，而不是仅增加步数或重复堆叠通用规则。
