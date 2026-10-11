import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config';
export async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'auto-agent-test-'));
  const root = join(dir, 'skills');
  await mkdir(root);
  for (const name of ['hello-world', 'sum-values']) {
    const skill = join(root, name);
    await mkdir(join(skill, 'scripts'), { recursive: true });
    await writeFile(
      join(skill, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${name === 'hello-world' ? 'Greet a person' : 'Sum numeric values'}\n---\nRead reference.txt then execute scripts/main.js.\n`,
    );
    await writeFile(join(skill, 'reference.txt'), 'Use the supplied arguments.');
    await writeFile(
      join(skill, 'scripts', 'main.js'),
      name === 'hello-world'
        ? "console.log('Hello '+process.argv[2]);"
        : 'console.log(process.argv.slice(2).reduce((a,b)=>a+Number(b),0));',
    );
  }
  const config: Config = {
    dataDir: join(dir, 'data'),
    skillRoots: [root],
    builtinSkills: false,
    builtinWiki: false,
    wikiRoots: [],
    host: '127.0.0.1',
    port: 0,
    allowRemote: false,
    token: 'test-bearer-token-value',
    apiKey: 'test-model-secret',
    model: 'test',
    baseURL: 'https://example.invalid/v1',
    maxSteps: 12,
    maxTokens: 32000,
    modelTimeoutMs: 10000,
    scriptTimeoutMs: 15000,
    outputLimitBytes: 4096,
    resourceLimitBytes: 4096,
    maxConcurrent: 4,
    requestLimitBytes: 4096,
    interpreters: { '.js': 'node' },
    scriptEnv: {},
  };
  return { dir, root, config, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
