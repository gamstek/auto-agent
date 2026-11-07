import { join } from 'node:path';
import { defineMemory } from '@coraxjs/core/memory';
import { fileMemory, sqliteMemory } from '@coraxjs/core/memory/file';
import { getRuntimeConfig } from './lib/config';

// One local-user scope per selected data directory, stable across sessions,
// process restarts and relocated application resources. Corax owns the backend.
export default defineMemory({
  description: '本地用户跨会话的稳定偏好与长期事实，不用于当前任务状态或应用配置。',
  namespace: 'auto-agent',
  scope: 'local-user',
  provider: fileMemory({
    backend: sqliteMemory({ path: join(getRuntimeConfig().dataDir, 'corax', 'memory.sqlite') }),
  }),
});
