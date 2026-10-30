import { expect, test } from 'bun:test';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Diagnostics } from '../../src/shared/diagnostics';
import { fixture } from '../helpers';
import { Skills } from '../../src/skill';
import { ScriptExecutor } from '../../src/execution';

test('Agent and skill diagnostics are correlated JSONL files with bounded records and credential redaction', async () => {
  const f = await fixture();
  try {
    const logs = new Diagnostics(f.dir, ['model-key-value', 'bearer-value']);
    logs.write('agent', 'generation.failed', {
      runId: 'run-1',
      message: 'model-key-value bearer-value',
      headers: { Authorization: 'Bearer vendor-token' },
      apiKey: 'some-other-key',
      totalTokens: 42,
      args: ['private-argument'],
      stdout: 'private-output',
    });
    logs.write('skills', 'http.failed', {
      runId: 'run-1',
      executionId: 'exec-1',
      batchId: 'batch-1',
      stage: 'start',
      status: 202,
      detail: 'Bearer other-token',
    });
    const app = await readFile(logs.paths().agent, 'utf8');
    const skill = await readFile(logs.paths().skills, 'utf8');
    for (const value of [
      'model-key-value',
      'bearer-value',
      'vendor-token',
      'some-other-key',
      'other-token',
      'private-argument',
      'private-output',
    ])
      expect(app + skill).not.toContain(value);
    expect(JSON.parse(app)).toMatchObject({
      event: 'generation.failed',
      runId: 'run-1',
      totalTokens: 42,
    });
    expect(JSON.parse(skill)).toMatchObject({
      event: 'http.failed',
      runId: 'run-1',
      executionId: 'exec-1',
      stage: 'start',
    });
  } finally {
    await f.cleanup();
  }
});

test('file diagnostic channel does not consume the script JSON output budget and bounds oversized log lines', async () => {
  const f = await fixture();
  try {
    const config = { ...f.config, outputLimitBytes: 64 };
    const skills = new Skills(config);
    await skills.discover();
    const executor = new ScriptExecutor(config, skills);
    for (const bytes of [6000, 20000]) {
      const line = `[skill-log] ${JSON.stringify({ event: 'fixture.note', detail: 'x'.repeat(bytes) })}\n`;
      await writeFile(
        join(f.root, 'hello-world', 'scripts', 'logging.js'),
        `process.stderr.write(${JSON.stringify(line)}); console.log('ok');`,
      );
      const result = await executor.execute(
        { skill: 'hello-world', path: 'scripts/logging.js' },
        new AbortController().signal,
        { runId: 'log-run', executionId: `exec-${bytes}` },
      );
      expect(result.status).toBe('completed');
      expect(result.stdout).toBe('ok\n');
      expect(result.stderr).toBe('');
    }
    await writeFile(
      join(f.root, 'hello-world', 'scripts', 'logging.js'),
      "process.stderr.write('x'.repeat(80)); console.log('ok');",
    );
    const bounded = await executor.execute(
      { skill: 'hello-world', path: 'scripts/logging.js' },
      new AbortController().signal,
    );
    expect(bounded.status).toBe('output_limit');
    expect(
      Buffer.byteLength(bounded.stdout) + Buffer.byteLength(bounded.stderr),
    ).toBeLessThanOrEqual(64);
    const records = (await readFile(join(config.dataDir, 'logs', 'skills.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(
      records.some((entry) => entry.event === 'fixture.note' && entry.executionId === 'exec-6000'),
    ).toBe(true);
    expect(
      records.some(
        (entry) => entry.event === 'skill_log.truncated' && entry.executionId === 'exec-20000',
      ),
    ).toBe(true);
  } finally {
    await f.cleanup();
  }
}, 30000);

test('file diagnostics rotate with bounded retention and truncate oversized fields without losing valid JSON', async () => {
  const f = await fixture();
  try {
    const logs = new Diagnostics(f.dir, ['secret-value'], 512, 2);
    for (let index = 0; index < 15; index++)
      logs.write('skills', 'record', { index, detail: 'x'.repeat(90) });
    logs.write('skills', 'oversized', { detail: 'secret-value'.repeat(4000) });
    const files = await readdir(logs.directory);
    expect(files.sort()).toEqual(['skills.jsonl', 'skills.jsonl.1', 'skills.jsonl.2']);
    for (const file of files) {
      expect((await stat(join(logs.directory, file))).size).toBeLessThanOrEqual(512);
      const text = await readFile(join(logs.directory, file), 'utf8');
      expect(text).not.toContain('secret-value');
      for (const line of text.trim().split('\n')) expect(JSON.parse(line).event).toBeString();
    }
    expect(JSON.parse((await readFile(logs.paths().skills, 'utf8')).trim()).truncated).toBe(true);
  } finally {
    await f.cleanup();
  }
});
