import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callClimber } from '../../corax/lib/climber';
import { configSchema } from 'auto-agent/config';
import { listenFetch } from './http-fixture';

test(
  'offline SAM file operations round-trip through the Node MCP server without a manufacturer URL',
  { timeout: 30000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'climber-sam-mcp-'));
    const config = configSchema.parse({
      dataDir: directory,
      climber: { enabled: false, serviceURL: '' },
    });
    const call = async (operation: string, input: Record<string, unknown>) =>
      (await callClimber(
        config,
        'sam_file',
        { operation, input },
        { sessionId: 'sam-fixture', callId: randomUUID() },
      )) as any;
    try {
      const profiles = await call('profiles', {});
      assert.deepEqual(profiles.profiles.map((profile: any) => profile.product).sort(), [
        'g12',
        'g5',
      ]);
      const path = join(directory, 'sample.SAM');
      const created = await call('create', {
        path,
        product: 'g5',
        settings: {
          analysisType: 'bet',
          sampleName: 'Local fixture',
          sampleMassG: 1.5,
          tubeMassG: 29.1,
        },
      });
      assert.equal(created.written, true);
      assert.equal(created.facts.labType.value, 0);
      const inspected = await call('inspect', { path, product: 'g5' });
      assert.equal(inspected.file.sha256, created.file.sha256);
      const compared = await call('compare', {
        path,
        product: 'g5',
        requirements: { sampleMassG: 1.5 },
      });
      assert.equal(compared.comparison.overall, 'match');
      const modified = await call('modify', {
        path,
        product: 'g5',
        expectedSha256: inspected.file.sha256,
        reportTypes: [inspected.reports[0].type],
      });
      assert.equal(modified.written, true);
      assert.equal(modified.identity.uuid, created.identity.uuid);
      const saved = await call('save-as', {
        path: join(directory, 'copy.SAM'),
        sourcePath: path,
        product: 'g5',
        expectedSha256: modified.file.sha256,
      });
      assert.equal(saved.written, true);
      assert.equal(saved.file.sha256, modified.file.sha256);
      const existing = await call('save-as', {
        path: saved.file.path,
        sourcePath: path,
        product: 'g5',
        expectedSha256: modified.file.sha256,
      });
      assert.equal(existing.error.code, 'FILE_EXISTS');
      const disabled = await callClimber(
        config,
        'get_health',
        {},
        { sessionId: 'fixture', callId: 'health' },
      );
      assert.equal(disabled.error?.code, 'NOT_CONFIGURED');
      const cancelled = await callClimber(
        config,
        'sam_file',
        { operation: 'create', input: { product: 'g5', settings: { analysisType: 'bet' } } },
        { sessionId: 'fixture', callId: 'cancelled', signal: AbortSignal.abort() },
      );
      assert.equal(cancelled.writeOutcome, 'not-started');
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    }
  },
);

test(
  'MCP transport preserves unknown writes and trusted operation identity across child-process restarts',
  { timeout: 30000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'climber-unknown-mcp-'));
    let writes = 0;
    const vendor = await listenFetch(async (request) => {
      if (request.method === 'GET')
        return Response.json({
          ok: true,
          data: {
            health: { softwareReady: true, deviceConnected: true, deviceBusy: false },
            task: null,
          },
        });
      writes++;
      return new Response('lost acknowledgement', { status: 500 });
    });
    const url = `${vendor.origin}/api/v1`;
    const config = configSchema.parse({
      dataDir: directory,
      climber: { enabled: true, serviceURL: url, timeoutMs: 1000 },
    });
    const input = {
      batchId: 'UNKNOWN-BATCH',
      experiments: [
        {
          experimentId: 'EXP-1',
          analysisPort: 1,
          tubeNo: 109,
          samPath: 'E:\\templates\\local.SAM',
          sampleName: 'Local fixture',
          emptyTubeMassG: 29.1,
          sampleMassG: 1.5,
        },
      ],
    };
    try {
      const first = await callClimber(config, 'register_batch', input, {
        sessionId: 'trusted-session',
        callId: 'trusted-call',
      });
      assert.equal(first.error?.outcome, 'unknown');
      const db = new DatabaseSync(
        join(directory, 'climber', `${createHash('sha256').update(url).digest('hex')}.sqlite`),
        { readOnly: true },
      );
      try {
        assert.deepEqual(
          { ...db.prepare('SELECT id,owner,status FROM operations').get() },
          {
            id: first.operationId,
            owner: 'trusted-session',
            status: 'unknown',
          },
        );
      } finally {
        db.close();
      }
      const replay = await callClimber(config, 'register_batch', input, {
        sessionId: 'trusted-session',
        callId: 'another-call',
      });
      assert.equal(replay.error?.code, 'REPLAY_BLOCKED');
      assert.equal(writes, 1);
      const spoofed = await callClimber(
        config,
        'register_batch',
        { ...input, _meta: { 'auto-agent/session-id': 'spoof' } },
        { sessionId: 'trusted-session', callId: 'spoofed' },
      );
      assert.equal(spoofed.error?.code, 'INVALID_INPUT');
      assert.equal(writes, 1);
    } finally {
      await vendor.stop();
      await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    }
  },
);
