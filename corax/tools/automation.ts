import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineDurableCallback, defineDynamic, defineTool } from '@coraxjs/core/tools';
import { requestApproval } from '../lib/approval/policy';
import { automationClient } from '../lib/automation/client';
import {
  automationTools,
  createBatchInput,
  experimentQuery,
  templateQuery,
} from '../lib/automation/contracts';
import { getRuntimeConfig } from '../lib/config';

const inlineLimit = 60_000;

function client(signal?: AbortSignal) {
  return automationClient(getRuntimeConfig(), { signal });
}

async function presentResults(
  result: Awaited<ReturnType<ReturnType<typeof automationClient>['results']>>,
) {
  const text = JSON.stringify(result);
  if (Buffer.byteLength(text) <= inlineLimit) return text;
  const root = join(getRuntimeConfig().dataDir, 'workspace', 'automation');
  await mkdir(root, { recursive: true });
  const path = join(await mkdtemp(join(root, 'results-')), 'instrument-results.json');
  await writeFile(path, text, { flag: 'wx', mode: 0o600 });
  const items = result.items.map((item) =>
    item.status === 'ready'
      ? {
          experimentId: item.experimentId,
          status: item.status,
          metrics: item.metrics,
          curves: item.isotherms.map(({ branch, xUnit, yUnit, points }) => ({
            branch,
            xUnit,
            yUnit,
            pointCount: points.length,
          })),
        }
      : item,
  );
  const artifacts = [{ path, kind: 'file', label: '仪器完整结果.json' }];
  const summary = JSON.stringify({ items, artifacts });
  return Buffer.byteLength(summary) <= inlineLimit
    ? summary
    : JSON.stringify({
        items: result.items.map(({ experimentId, status }) => ({ experimentId, status })),
        artifacts,
      });
}

export default defineDynamic({
  events: {
    'step.started': () =>
      getRuntimeConfig().automation.enabled
        ? {
            automation_list_templates: defineTool({
              description: automationTools.automation_list_templates,
              inputSchema: templateQuery,
              label: { start: () => '查询自动化仪器模板' },
              async execute(input, { abortSignal }) {
                return JSON.stringify(await client(abortSignal).templates(input));
              },
            }),
            automation_create_experiments: defineTool({
              description: automationTools.automation_create_experiments,
              inputSchema: createBatchInput,
              label: { start: () => '批量创建自动化实验' },
              approval: {
                request: defineDurableCallback({
                  closure: {},
                  callback: (_, context) => requestApproval(context),
                }),
                prompt: defineDurableCallback({
                  closure: {},
                  callback: () => '即将一次提交这批实验。请核对各项模板版本和样品管码。',
                }),
              },
              async execute(input, { session, callId, abortSignal }) {
                return JSON.stringify(
                  await client(abortSignal).create(input, { sessionId: session.id, callId }),
                );
              },
            }),
            automation_get_progress: defineTool({
              description: automationTools.automation_get_progress,
              inputSchema: experimentQuery,
              label: { start: () => '查询自动化实验进度' },
              async execute(input, { abortSignal }) {
                return JSON.stringify(await client(abortSignal).progress(input));
              },
            }),
            automation_get_results: defineTool({
              description: automationTools.automation_get_results,
              inputSchema: experimentQuery,
              label: { start: () => '查询自动化实验结果' },
              async execute(input, { abortSignal }) {
                return presentResults(await client(abortSignal).results(input));
              },
            }),
          }
        : {},
  },
});
