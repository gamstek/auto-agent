import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fixture } from '../helpers';

test('embedded runtime completes a persistent instrument workflow without Node or Bun on PATH', async () => {
  const f = await fixture();
  const directory = join(f.dir, 'simulated-instruments');
  const script = resolve('skills', 'device-automation', 'scripts', 'instrument.js');
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
    const payload = {
      name: 'Interface fixture',
      deviceId: 'sim-analyzer-1',
      method: 'BET',
      gas: 'N2',
      temperatureK: 77,
      preprocessing: { temperatureC: 25, durationHours: 1 },
      sampleMassG: 1,
    };
    const { template } = await run('save-template', JSON.stringify(payload));
    expect((await run('get-template', template.id)).template.id).toBe(template.id);
    const { measurement } = await run(
      'submit-measurement',
      JSON.stringify({
        deviceId: payload.deviceId,
        templateId: template.id,
        sampleId: 'fixture-sample',
      }),
    );
    await Bun.sleep(10);
    expect((await run('measurement', measurement.id)).measurement.state).toBe('completed');
    const { result } = await run('results', measurement.id);
    expect(result.sampleId).toBe('fixture-sample');
    expect(result).not.toHaveProperty('simulated');
    const { report } = await run('export-report', measurement.id);
    expect(report.path.startsWith(directory)).toBe(true);
    expect(await readFile(report.path, 'utf8')).toContain('simulation');
    expect(await readFile(join(directory, 'simulation-state.json'), 'utf8')).toContain(
      'simulation',
    );
  } finally {
    await f.cleanup();
  }
}, 30000);
