import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { ensureConfig } from '../../corax/lib/config';

const execute = promisify(execFile);
async function run(config: string, script: string) {
  const module = new URL('../../corax/lib/approval.ts', import.meta.url).href;
  const configModule = new URL('../../corax/lib/config/index.ts', import.meta.url).href;
  const source = `import fs from 'node:fs';
    const {approvalSetting,setApprovalSetting}=await import(${JSON.stringify(module)});
    const {getRuntimeConfig,getRuntimeConfigRevision}=await import(${JSON.stringify(configModule)});
    ${script}`;
  const result = await execute(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', source],
    {
      cwd: join(import.meta.dirname, '../..'),
      env: { ...process.env, AUTO_AGENT_CONFIG: config },
      timeout: 20_000,
    },
  );
  return JSON.parse(result.stdout);
}

test('approvalMode uses the existing config and is restored without persisting native grants', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'approval-config-'));
  const path = join(directory, 'config.json');
  try {
    ensureConfig(path);
    const before = JSON.parse(await readFile(path, 'utf8'));
    const saved = await run(
      path,
      `const setting=setApprovalSetting('never',0);
      console.log(JSON.stringify({setting,configRevision:getRuntimeConfigRevision()}));`,
    );
    assert.deepEqual(saved.setting, { mode: 'never', revision: 1 });
    const bytes = await readFile(path, 'utf8');
    assert.equal(saved.configRevision, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(JSON.parse(bytes), { ...before, approvalMode: 'never' });
    assert.deepEqual(await run(path, 'console.log(JSON.stringify(approvalSetting()))'), {
      mode: 'never',
      revision: 0,
    });
    assert.deepEqual(await run(path, "console.log(JSON.stringify(setApprovalSetting('once',0)))"), {
      mode: 'once',
      revision: 1,
    });
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { ...before, approvalMode: 'once' });
    assert.deepEqual((await readdir(directory)).sort(), ['.data-layout', 'config.json']);
    const stale = await run(
      path,
      `setApprovalSetting('always',0);let conflict=false;
      try{setApprovalSetting('never',0)}catch{conflict=true}
      console.log(JSON.stringify({conflict,setting:approvalSetting()}));`,
    );
    assert.equal(stale.conflict, true);
    assert.equal(stale.setting.mode, 'always');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a failed atomic config save keeps both the saved and effective approval mode unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'approval-config-failure-'));
  const path = join(directory, 'config.json');
  try {
    ensureConfig(path);
    const result = await run(
      path,
      `approvalSetting();fs.renameSync=()=>{throw new Error('busy')};
      let failed=false;try{setApprovalSetting('never',0)}catch{failed=true}
      console.log(JSON.stringify({failed,setting:approvalSetting(),saved:JSON.parse(fs.readFileSync(process.env.AUTO_AGENT_CONFIG,'utf8')).approvalMode}));`,
    );
    assert.equal(result.failed, true);
    assert.equal(result.saved, 'always');
    assert.deepEqual(result.setting, { mode: 'always', revision: 0 });
    assert.deepEqual((await readdir(directory)).sort(), ['.data-layout', 'config.json']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('saving approvalMode preserves pending settings without applying them to the running model', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'approval-config-deferred-'));
  const path = join(directory, 'config.json');
  try {
    ensureConfig(path);
    const result = await run(
      path,
      `const original=getRuntimeConfig();const revision=getRuntimeConfigRevision();
      const raw=JSON.parse(fs.readFileSync(process.env.AUTO_AGENT_CONFIG,'utf8'));
      fs.writeFileSync(process.env.AUTO_AGENT_CONFIG,JSON.stringify({...raw,model:'pending-model',dataDir:'relative-data'}));
      setApprovalSetting('never',0);
      console.log(JSON.stringify({saved:JSON.parse(fs.readFileSync(process.env.AUTO_AGENT_CONFIG,'utf8')),
        activeModel:getRuntimeConfig().model,originalModel:original.model,mode:getRuntimeConfig().approvalMode,
        revisionUnchanged:getRuntimeConfigRevision()===revision}));`,
    );
    assert.equal(result.saved.model, 'pending-model');
    assert.equal(result.saved.dataDir, 'relative-data');
    assert.equal(result.saved.approvalMode, 'never');
    assert.equal(result.activeModel, result.originalModel);
    assert.equal(result.mode, 'never');
    assert.equal(result.revisionUnchanged, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
