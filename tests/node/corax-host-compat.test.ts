import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import bash from '@coraxjs/core/tools/bash';
import glob from '@coraxjs/core/tools/glob';
import grep from '@coraxjs/core/tools/grep';
import readFileTool from '@coraxjs/core/tools/read_file';
import writeFileTool from '@coraxjs/core/tools/write_file';
import { defineSandboxProvider } from '@coraxjs/core/sandbox/provider';
import { createHostSession } from '../../corax/lib/host/session';
import { toShellPath } from '../../corax/lib/host/paths';
import { HostSandbox } from '../../corax/lib/host/provider';

// Operator-approved pnpm patch contract only. Application code uses public exports.
const sdk = dirname(fileURLToPath(import.meta.resolve('@coraxjs/core')));
const internal = (path: string) => import(pathToFileURL(join(sdk, path)).href);
const { ContextContainer, contextStorage } = await internal('context/container.js');
const { SandboxKey } = await internal('context/keys.js');
const { createSkillLoader } = await internal('execution/catalog/skills.js');
const { normalizePath, isAbsolutePath } = await internal('shared/host-paths.js');

const quote = (path: string) => `'${toShellPath(path).replaceAll("'", "'\\''")}'`;

test('activated Skill paths work through native read/write/glob/grep/bash with no global search', async () => {
  const root = await mkdtemp(join(tmpdir(), "corax skill 量仔's "));
  const skills = join(root, 'skills');
  const directory = join(skills, 'device-automation');
  await mkdir(join(directory, 'references'), { recursive: true });
  const markdown = '# Device workflow\nRead ./references/automation.md';
  await writeFile(join(directory, 'SKILL.md'), markdown);
  await writeFile(join(directory, 'references/automation.md'), 'installed-reference');
  const host = await createHostSession({ workspace: join(root, 'workspace'), skills });
  const previousProjectRoot = process.env.AUTO_AGENT_PROJECT_ROOT;
  process.env.AUTO_AGENT_PROJECT_ROOT = root;
  const scope = new ContextContainer();
  scope.set(SandboxKey, {
    environment: HostSandbox.environment(),
    get: async () => {
      throw new Error('Skill loading must not open a host session');
    },
  });
  const context = { getSandbox: async () => host.sandbox } as never;
  try {
    await contextStorage.run(scope, async () => {
      const loader = createSkillLoader(
        new Map([
          [
            'device-automation',
            {
              name: 'device-automation',
              description: 'fixture',
              markdown,
              deferred: false,
              path: '$HOME/.agents/skills/device-automation/SKILL.md',
            },
          ],
        ]),
      );
      const loaded = await loader.execute({ name: 'device-automation' });
      const resource = loaded.match(/^Resource directory: (.+)$/m)?.[1];
      assert.equal(resource, toShellPath(directory));
      assert.ok(loaded.endsWith(markdown));
      const filePath = `${resource}/references/automation.md`;
      const read = await readFileTool.execute!({ filePath }, context);
      assert.ok('content' in read);
      assert.match(read.content, /installed-reference/);
      const aliasRead = await readFileTool.execute!(
        {
          filePath: '$HOME/.agents/skills/device-automation/references/automation.md',
        },
        context,
      );
      assert.ok('content' in aliasRead);
      assert.equal(aliasRead.content, read.content);
      const files = await glob.execute!({ path: resource, pattern: '**/*.md' }, context);
      assert.ok('count' in files);
      assert.equal(files.count, 2);
      const matches = await grep.execute!(
        { path: resource, pattern: 'installed-reference' },
        context,
      );
      assert.ok('matchCount' in matches);
      assert.equal(matches.matchCount, 1);
      const shell = await bash.execute!(
        {
          command: `base=${quote(resource!)}; eval 'cat "$base/references/automation.md"'`,
        },
        context,
      );
      assert.ok('status' in shell && shell.status === 'completed');
      assert.equal(shell.exitCode, 0, shell.stderr);
      assert.equal(shell.stderr, '');
      assert.equal(shell.stdout, 'installed-reference');
      const output = join(root, 'workspace', 'roundtrip.txt');
      await writeFileTool.execute!({ filePath: output, content: 'native-write' }, context);
      const written = await readFileTool.execute!({ filePath: toShellPath(output) }, context);
      assert.ok('content' in written);
      assert.match(written.content, /native-write/);
      assert.equal(await readFile(output, 'utf8'), 'native-write');
    });
    const textOnly = createSkillLoader(
      new Map([
        [
          'text-only',
          {
            name: 'text-only',
            description: 'fixture',
            markdown: 'instructions only',
            deferred: false,
          },
        ],
      ]),
    );
    assert.equal(await textOnly.execute({ name: 'text-only' }), 'instructions only');
  } finally {
    if (previousProjectRoot === undefined) delete process.env.AUTO_AGENT_PROJECT_ROOT;
    else process.env.AUTO_AGENT_PROJECT_ROOT = previousProjectRoot;
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('file Skill instructions load with unavailable compute, with or without resource metadata', async () => {
  const root = process.platform === 'win32' ? 'C:/fixture/skills' : '/fixture/skills';
  const markdown = '# Available instructions\nRead ./references/guide.md as needed.';
  for (const metadata of [false, true]) {
    let provisions = 0;
    let gets = 0;
    const unavailable = async (): Promise<never> => {
      provisions++;
      throw new Error('provider unavailable');
    };
    const environment = defineSandboxProvider<undefined, undefined, null, null>({
      name: 'unavailable-fixture',
      environment: () => ({
        paths: metadata ? { skills: root } : undefined,
        prepare: unavailable,
        start: unavailable,
        resume: unavailable,
      }),
    }).environment();
    const scope = new ContextContainer();
    scope.set(SandboxKey, {
      environment,
      get: async () => {
        gets++;
        throw new Error('provider unavailable');
      },
    });
    const loader = createSkillLoader(
      new Map([
        [
          'guide',
          {
            name: 'guide',
            description: 'fixture',
            markdown,
            path: '$HOME/.agents/skills/guide/SKILL.md',
          },
        ],
      ]),
    );
    const result = await contextStorage.run(scope, () => loader.execute({ name: 'guide' }));
    assert.ok(result.endsWith(markdown));
    if (metadata) assert.ok(result.includes(`Resource directory: ${root}/guide`));
    else assert.equal(result, markdown);
    assert.equal(gets, 0, 'Skill loading must not request compute');
    assert.equal(provisions, 0, 'Resource metadata must not prepare/start/resume a provider');
  }
});

test('native bash preserves known outcomes when temporary-output cleanup fails', async () => {
  for (const exitCode of [0, 7])
    for (const synchronous of [false, true]) {
      let executions = 0,
        cleanups = 0,
        kills = 0;
      const cleanup = synchronous
        ? () => {
            cleanups++;
            throw new Error('fixture cleanup EPERM');
          }
        : async () => {
            cleanups++;
            throw new Error('fixture cleanup EPERM');
          };
      const result = await bash.execute!({ command: 'fixture-command' }, {
        getSandbox: async () => ({
          async startCommand() {
            executions++;
            return {
              pid: 123,
              outputDirectory: 'fixture',
              stopCommand: 'fixture-stop',
              wait: async () => ({ exitCode }),
              readOutput: async () => ({
                stdout: 'known output',
                stderr: 'known stderr',
                omittedBytes: { stdout: 0, stderr: 0 },
              }),
              kill: async () => {
                kills++;
              },
              cleanup,
            };
          },
        }),
      } as never);
      assert.ok('status' in result && result.status === 'completed');
      assert.equal(result.exitCode, exitCode);
      assert.equal(result.stdout, 'known output');
      assert.equal(result.stderr, 'known stderr');
      assert.equal(executions, 1);
      assert.equal(cleanups, 1);
      assert.equal(kills, 0, 'Housekeeping failure must not trigger process cancellation');
    }
});

test('provider path normalization preserves drive, UNC and POSIX roots and rejects relative drives', () => {
  assert.equal(normalizePath('C:\\Users\\name\\..\\sample.txt'), 'C:/Users/sample.txt');
  assert.equal(normalizePath('//server/share/folder/../sample.txt'), '//server/share/sample.txt');
  assert.equal(normalizePath('/workspace/a/../file.txt'), '/workspace/file.txt');
  for (const path of ['C:/Users/name', 'C:\\Users\\name', '//server/share/file', '/workspace'])
    assert.equal(isAbsolutePath(path), true, path);
  for (const path of ['C:relative', 'relative', 'file\nname', 'file\0name'])
    assert.equal(isAbsolutePath(path), false, path);
});

test('native bash bounds large output and preserves exit codes without replaying commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'corax-command-output-'));
  const host = await createHostSession({ workspace: root, skills: root });
  try {
    const result = await bash.execute!(
      {
        command: `${quote(process.execPath)} -e 'require("node:fs").appendFileSync("executions.txt", "one\\n"); process.stdout.write("line\\n".repeat(24000) + "TAIL-MARKER"); process.stderr.write("EXPECTED-ERROR"); process.exitCode=7'`,
      },
      { getSandbox: async () => host.sandbox } as never,
    );
    assert.ok('status' in result && result.status === 'completed');
    assert.equal(result.exitCode, 7);
    assert.equal(result.truncated, true);
    assert.ok(result.stdout.endsWith('TAIL-MARKER'));
    assert.ok(result.stdout.length < 70000);
    assert.equal(result.stderr, 'EXPECTED-ERROR');
    assert.equal(await readFile(join(root, 'executions.txt'), 'utf8'), 'one\n');
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});
