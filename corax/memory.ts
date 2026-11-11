import { join } from 'node:path';
import { defineMemory } from '@coraxjs/core/memory';
import { fileMemory, sqliteMemory } from '@coraxjs/core/memory/file';
import { getRuntimeConfig } from './lib/config';

// One local-user scope per selected data directory, stable across sessions,
// process restarts and relocated application resources. Corax owns the backend.
export default defineMemory({
  description: `<memory_policy>
保留用户明确要求记住或跨会话稳定的事实与偏好，包括仪器背景、长期材料与测试需求、命名及报告习惯。可复用实验条件须经用户确认，并保留材料、方法等适用范围。
用户明确要求下次继续的项目，只记跨会话仍有用的简短目标、已确认约束和持久资料引用。完整 SAM、详细方案与结果留在实际文件中，明确授权后才整理进知识库。
不存凭据、应用配置副本、临时参数、执行状态或写入回执。召回可能过时，不覆盖本次确认、工具结果或技能指导；当前设备、批次和未知写入状态须另行核验。
</memory_policy>`,
  namespace: 'auto-agent',
  scope: 'local-user',
  provider: fileMemory({
    backend: sqliteMemory({ path: join(getRuntimeConfig().dataDir, 'corax', 'memory.sqlite') }),
  }),
});
