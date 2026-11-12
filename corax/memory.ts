import { join } from 'node:path';
import { defineMemory } from '@coraxjs/core/memory';
import { fileMemory, sqliteMemory } from '@coraxjs/core/memory/file';
import { getRuntimeConfig } from './lib/config';

// One local-user scope per selected data directory, stable across sessions,
// process restarts and relocated application resources. Corax owns the backend.
export default defineMemory({
  description: `<memory_policy>
识别到用户直接陈述、跨会话仍有用的稳定事实与偏好时，应主动调用原生记忆工具保存，包括仪器背景、长期材料与测试需求、命名及报告习惯。无需等待用户说“记住”，也不逐条请求记忆授权；遵守用户不记录或忘记的要求。
对持续讨论或明确跨会话推进的项目，主动保留简短目标、已确认约束和持久资料引用，不要求用户说“下次继续”。不记录当前进度、待办或其他执行细节。完整 SAM、详细方案与结果留在实际文件中，明确授权后才整理进知识库。
可复用实验条件须经用户确认，并保留材料、方法等适用范围；不把单次参数、模型建议或推测升级为长期默认条件。
保存前对照已召回内容，避免重复；用户更正稳定事实时，通过原生记忆工具移除过时条目并保存更正。仅在工具确认成功后简短告知已记住或已更新，不把记忆意图说成保存完成。
不存凭据、应用配置副本、临时参数、执行状态或写入回执。召回可能过时，不覆盖本次确认、工具结果或技能指导；当前设备、批次和未知写入状态须另行核验。
</memory_policy>`,
  namespace: 'auto-agent',
  scope: 'local-user',
  provider: fileMemory({
    backend: sqliteMemory({ path: join(getRuntimeConfig().dataDir, 'corax', 'memory.sqlite') }),
  }),
});
