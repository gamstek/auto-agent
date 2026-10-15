import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fixture } from '../helpers';

test('embedded runtime completes a persistent automation workflow without Node or Bun on PATH', async () => {
  const f = await fixture();
  const directory = join(f.dir, 'simulated-automation');
  const script = resolve('skills', 'device-automation', 'scripts', 'automation.js');
  const executable = process.env.AUTO_AGENT_TEST_BINARY_PATH;
  const entry = executable ? [resolve(executable)] : [process.execPath, resolve('src', 'index.ts')];
  const run = async (...args: string[]) => {
    const child = Bun.spawn([...entry, '--auto-agent-internal-script', script, ...args], {
      cwd: f.dir,
      env: {
        ...process.env,
        PATH: '',
        AUTO_AGENT_SIMULATION_DIR: directory,
        AUTO_AGENT_SIMULATION_DURATION_MS: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    return JSON.parse(stdout);
  };
  try {
    expect((await run('list')).devices).toHaveLength(2);
    const { run: workflow } = await run(
      'submit-run',
      JSON.stringify({
        deviceId: 'sim-automation-1',
        templateFile: 'fixture.tpl',
      }),
    );
    await Bun.sleep(10);
    expect((await run('run', workflow.id)).run.state).toBe('completed');
    const { result } = await run('results', workflow.id);
    expect(result.templateFile).toBe('fixture.tpl');
    expect(result.runId).toBe(workflow.id);
    expect(result.provenance.backend).toBe('simulation');
    const { report } = await run('export-report', workflow.id);
    expect(report.path.startsWith(directory)).toBe(true);
    expect(await readFile(report.path, 'utf8')).toContain('simulation');
    expect(await readFile(join(directory, 'simulation-state.json'), 'utf8')).toContain(
      'simulation',
    );
  } finally {
    await f.cleanup();
  }
}, 30000);
