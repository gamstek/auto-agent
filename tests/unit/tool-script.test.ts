import { expect, test } from 'bun:test';
import { BuiltinToolRegistry, UncertainToolError } from '../../src/tool';
import { AppError, type ScriptResult } from '../../src/shared/types';
import { toolFixture } from '../tool-helpers';

const registry = new BuiltinToolRegistry();
const input = { skill: 'example', path: 'scripts/main.js', args: ['one'] };

for (const status of [
  'completed',
  'failed',
  'cancelled',
  'timeout',
  'output_limit',
  'unknown',
] as const) {
  test(`script tool records ${status} once and preserves its execution semantics`, async () => {
    const f = toolFixture();
    f.context.run.loadedSkills.add('example');
    const value: ScriptResult = {
      status,
      exitCode: status === 'completed' ? 0 : null,
      stdout: 'Fixture output',
      stderr: '',
    };
    let launches = 0;
    f.context.executor.execute = async () => {
      launches++;
      return value;
    };
    if (status === 'unknown') {
      await expect(
        registry.execute('execute_skill_script', input, f.context),
      ).rejects.toBeInstanceOf(UncertainToolError);
    } else {
      expect(await registry.execute('execute_skill_script', input, f.context)).toEqual({
        output: value,
        status,
      });
    }
    expect(f.calls.filter((call) => call.name === 'begin')).toHaveLength(1);
    expect(f.calls.filter((call) => call.name === 'finish')).toEqual([
      { name: 'finish', input: { id: 'execution-1', result: value } },
    ]);
    expect(f.context.run.failedScripts.size).toBe(status === 'completed' ? 0 : 1);
    if (status !== 'completed') {
      await expect(
        registry.execute(
          'execute_skill_script',
          { ...input, path: 'scripts/./main.js' },
          f.context,
        ),
      ).rejects.toThrow('automatically retried');
      expect(launches).toBe(1);
      expect(f.calls.filter((call) => call.name === 'begin')).toHaveLength(1);
    }
  });
}

test('script exceptions distinguish known failure from an unknown outcome and finish audit once', async () => {
  for (const unexpected of [false, true]) {
    const f = toolFixture();
    f.context.run.loadedSkills.add('example');
    const error = unexpected
      ? new Error('Do not expose implementation details')
      : new AppError('script_interpreter', 'Interpreter unavailable');
    f.context.executor.execute = async () => {
      throw error;
    };
    const attempt = registry.execute('execute_skill_script', input, f.context);
    if (unexpected) await expect(attempt).rejects.toBeInstanceOf(UncertainToolError);
    else await expect(attempt).rejects.toBe(error);
    expect(f.calls.filter((call) => call.name === 'finish')).toEqual([
      {
        name: 'finish',
        input: {
          id: 'execution-1',
          result: {
            status: unexpected ? 'unknown' : 'failed',
            exitCode: null,
            stdout: '',
            stderr: '',
          },
        },
      },
    ]);
    expect(f.context.run.failedScripts.size).toBe(1);
  }
});

test('an audit publication failure stops execution without attempting to finish twice', async () => {
  const f = toolFixture();
  f.context.run.loadedSkills.add('example');
  let finishes = 0;
  f.context.audit.finishExecution = () => {
    finishes++;
    throw new Error('Database unavailable');
  };
  await expect(registry.execute('execute_skill_script', input, f.context)).rejects.toBeInstanceOf(
    UncertainToolError,
  );
  expect(finishes).toBe(1);
  expect(f.context.run.failedScripts.size).toBe(1);
});

test('failed script replay protection belongs to a generation, not the registry', async () => {
  const first = toolFixture();
  first.context.run.loadedSkills.add('example');
  first.context.executor.execute = async () => ({
    status: 'failed',
    exitCode: 1,
    stdout: '',
    stderr: '',
  });
  await registry.execute('execute_skill_script', input, first.context);
  const second = toolFixture();
  second.context.run.loadedSkills.add('example');
  expect((await registry.execute('execute_skill_script', input, second.context)).status).toBe(
    'completed',
  );
  expect(first.context.run.failedScripts.size).toBe(1);
  expect(second.context.run.failedScripts.size).toBe(0);
});
