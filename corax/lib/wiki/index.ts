import { join } from 'node:path';
import { LlmWiki } from '@auto-agent/llm-wiki';
import type { AppConfig } from '../config/schema';
import { getRuntimeConfig } from '../config';

export function openLlmWiki(config: Pick<AppConfig, 'dataDir'>) {
  return new LlmWiki(join(config.dataDir, 'llm-wiki'));
}
export function getLlmWiki() {
  return openLlmWiki(getRuntimeConfig());
}

/** Application-owned binding of a shipped collection, never a model-supplied database path. */
export function referenceSource(
  projectRoot = process.env.AUTO_AGENT_PROJECT_ROOT ?? process.cwd(),
) {
  return {
    path: join(projectRoot, 'skills/device-automation/assets/library.sqlite'),
    parserId: 'sam.reference',
    note: '预置历史参数证据；不是完整 SAM 文件，也不证明当前仪器状态或科学适用。',
    protectedPaths: [
      join(projectRoot, 'skills/device-automation/assets'),
      join(projectRoot, 'skills/device-automation/references/materials'),
    ],
  };
}
