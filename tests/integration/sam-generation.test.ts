import { test, expect } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from '../helpers';
import { AgentService } from '../../src/agent';
import { Skills } from '../../src/skill';
import { ScriptExecutor } from '../../src/execution';
import { Store } from '../../src/storage';

test('agent generates a BET SAM from packaged configuration through the loaded skill without a base file', async () => {
  const f = await fixture();
  const config = {
    ...f.config,
    skillRoots: [],
    builtinSkills: true,
    maxInputTokens: 64000,
    outputLimitBytes: 65536,
    resourceLimitBytes: 65536,
    scriptEnv: { SAM_OUTPUT_DIR: join(f.dir, 'generated') },
  };
  const skills = new Skills(config);
  await skills.discover();
  const store = new Store(config.dataDir);
  const calls = [
    { name: 'skill', input: { name: 'device-automation' } },
    { name: 'read', input: { skill: 'device-automation', path: 'references/sam-create.md' } },
    {
      name: 'execute_script',
      input: {
        skill: 'device-automation',
        path: 'scripts/sam.js',
        args: ['profiles', '{"product":"g12"}'],
      },
    },
    {
      name: 'execute_script',
      input: {
        skill: 'device-automation',
        path: 'scripts/sam.js',
        args: [
          'create',
          JSON.stringify({
            product: 'g12',
            settings: {
              analysisType: 'bet',
              sampleName: '石墨',
              sampleMassG: 1.5,
              tubeMassG: 29.1,
            },
          }),
        ],
      },
    },
  ];
  let step = 0;
  let target = '';
  const service = new AgentService(config, store, skills, new ScriptExecutor(config, skills), {
    async generate(messages) {
      const next = calls[step++];
      if (next)
        return { text: '', usage: { totalTokens: 1 }, toolCalls: [{ id: `sam-${step}`, ...next }] };
      const last = messages.at(-1)!;
      if (last.role !== 'tool' || !Array.isArray(last.content))
        throw new Error('Missing generation result');
      const result = last.content[0]!;
      if (result.type !== 'tool-result' || result.output.type !== 'json')
        throw new Error('Missing JSON result');
      const execution = result.output.value as { status: string; stdout: string };
      expect(execution.status).toBe('completed');
      const generated = JSON.parse(execution.stdout);
      expect(generated.generation.sampleInputsComplete).toBe(true);
      expect(generated.facts.analysisType.value).toBe('bet');
      expect(generated.status.state).toBe('new');
      target = generated.file.path;
      return { text: '已生成石墨 BET 模板。', usage: { totalTokens: 1 }, toolCalls: [] };
    },
  });
  try {
    const reply = await service.submit(
      store.createSession().id,
      '用 G12 为石墨样品生成 BET 模板，净样1.5g、空管29.1g。',
    );
    expect(reply.content).toBe('已生成石墨 BET 模板。');
    expect(target.startsWith(config.scriptEnv.SAM_OUTPUT_DIR)).toBe(true);
    const bytes = await readFile(target);
    expect(bytes.readInt32BE(0)).toBe(0x2010);
    const root = JSON.parse(new TextDecoder('utf-16be').decode(bytes.subarray(8)));
    expect(root['analysis conditions']['isotherm collection'].pressures).toHaveLength(5);
    expect(root['analysis data']).toBeUndefined();
    expect(store.db.query('SELECT status FROM executions').all()).toEqual([
      { status: 'completed' },
      { status: 'completed' },
    ]);
  } finally {
    await service.shutdown();
    store.close();
    await f.cleanup();
  }
});
