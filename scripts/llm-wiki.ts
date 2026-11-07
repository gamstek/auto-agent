import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { loadConfig, ensureConfig, defaultConfigPath } from 'auto-agent/config';
import { openLlmWiki } from 'auto-agent/wiki';
import { ingestLlmWiki } from 'auto-agent/wiki/ingest';
import type { PageReference, SourceReference } from '@auto-agent/llm-wiki';

const args = process.argv.slice(2);
process.env.AUTO_AGENT_PROJECT_ROOT ??= resolve(import.meta.dirname, '../corax');
const path = process.env.AUTO_AGENT_CONFIG ?? defaultConfigPath();
if (!process.env.AUTO_AGENT_CONFIG) ensureConfig(path);
const config = loadConfig(path);
const wiki = openLlmWiki(config);
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => controller.abort());
let result: unknown;
switch (args[0] ?? 'catalog') {
  case 'init':
    result = await wiki.initialize();
    break;
  case 'catalog':
    result = await wiki.catalog();
    break;
  case 'search':
    result = await wiki.search(args[1] ?? '');
    break;
  case 'read':
    result = await wiki.read(JSON.parse(args[1] ?? '') as PageReference, Number(args[2] ?? 0));
    break;
  case 'source': {
    const query = JSON.parse(args[1] ?? '') as { generation: string; reference: SourceReference };
    result = await wiki.source(query.generation, query.reference);
    break;
  }
  case 'lint':
    result = await wiki.lint();
    break;
  case 'reindex':
    result = await wiki.reindex();
    break;
  case 'resolve':
    result = await wiki.resolve(args[1] ?? '', args[2] ?? '', controller.signal);
    break;
  case 'ingest': {
    const selection = args[1] === '--file' || args[1] === '--directory' ? args[1] : undefined;
    if (selection) {
      if (!args[2]) throw new Error('请指定文本文件或目录');
      const selected = resolve(args[2]);
      const canonical = await realpath(selected);
      config.llmWiki.sources = [
        {
          id: `import-${createHash('sha256')
            .update(process.platform === 'win32' ? canonical.toLowerCase() : canonical)
            .digest('hex')
            .slice(0, 24)}`,
          type: selection === '--file' ? 'file' : 'directory',
          path: selected,
        },
      ];
    }
    const report = await ingestLlmWiki(config, selection ? undefined : args[1], controller.signal);
    if (report.status !== 'completed') process.exitCode = 1;
    result = report;
    break;
  }
  default:
    throw new Error(
      'Usage: pnpm llm-wiki init|catalog|search <query>|read <reference-json>|source <reference-json>|ingest [sourceId|--file path|--directory path]|resolve <issueId> <note>|lint|reindex',
    );
}
console.log(JSON.stringify(result, null, 2));
