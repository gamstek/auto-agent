import { test, expect } from 'bun:test';
import { join, resolve } from 'node:path';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fixture } from '../helpers';
import { collectBuiltinAssets } from '../../src/shared/builtin';
const binary = process.env.AUTO_AGENT_TEST_BINARY_PATH
  ? resolve(process.env.AUTO_AGENT_TEST_BINARY_PATH)
  : resolve('dist', process.platform === 'win32' ? 'auto-agent.exe' : 'auto-agent');
test.skipIf(!process.env.AUTO_AGENT_TEST_BINARY)(
  'compiled desktop sidecar exposes inspection and retains reasoning after restart',
  async () => {
    const f = await fixture();
    const model = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        const base = {
          id: 'compiled-model',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'fixture',
        };
        return new Response(
          [
            {
              ...base,
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    reasoning_content: 'Compiled reasoning persists.',
                    content: 'Compiled reply.',
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              ...base,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
            },
          ]
            .map((item) => `data: ${JSON.stringify(item)}\n\n`)
            .join('') + 'data: [DONE]\n\n',
          { headers: { 'Content-Type': 'text/event-stream' } },
        );
      },
    });
    const file = join(f.dir, 'inspection.json');
    await writeFile(file, JSON.stringify({ ...f.config, baseURL: `${model.url.origin}/v1` }));
    const headers = {
      Authorization: `Bearer ${f.config.token}`,
      'Content-Type': 'application/json',
    };
    async function start() {
      const child = Bun.spawn([binary, 'serve', '--config', file], {
        cwd: f.dir,
        env: {
          ...process.env,
          AUTO_AGENT_API_KEY: 'compiled-fixture-key',
          AUTO_AGENT_TOKEN: f.config.token,
          AUTO_AGENT_DESKTOP: '1',
        },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const errors = new Response(child.stderr).text();
      const reader = child.stdout.getReader();
      try {
        const listening = (async () => {
          let text = '';
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) throw new Error('Sidecar exited before listening');
            text += new TextDecoder().decode(chunk.value);
            const line = text
              .split('\n')
              .find((value) => value.startsWith('{') && value.endsWith('}'));
            if (line) return JSON.parse(line) as { url: string };
          }
        })();
        const { url } = await Promise.race([
          listening,
          Bun.sleep(10000).then(() => {
            throw new Error('Sidecar startup timeout');
          }),
        ]);
        return { child, reader, errors, url };
      } catch (error) {
        child.stdin.end();
        if (child.exitCode === null) child.kill();
        await child.exited;
        await reader.cancel();
        await errors;
        throw error;
      }
    }
    async function stop(backend: Awaited<ReturnType<typeof start>>) {
      try {
        const response = await fetch(`${backend.url}/desktop/shutdown`, {
          method: 'POST',
          headers,
        });
        expect(response.status).toBe(200);
        expect(await Promise.race([backend.child.exited, Bun.sleep(10000).then(() => -999)])).toBe(
          0,
        );
      } finally {
        backend.child.stdin.end();
        if (backend.child.exitCode === null) backend.child.kill();
        await backend.child.exited;
        await backend.reader.cancel();
        await backend.errors;
      }
    }
    let backend: Awaited<ReturnType<typeof start>> | undefined;
    try {
      backend = await start();
      expect(await (await fetch(`${backend.url}/global/health`)).json()).toMatchObject({
        capabilities: { runInspection: 1, persistedReasoning: 1, conversationProcess: 1 },
      });
      const session = await (
        await fetch(`${backend.url}/session`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ title: 'Compiled inspection' }),
        })
      ).json();
      const response = await fetch(`${backend.url}/session/${session.id}/message`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ content: 'Inspect this compiled request.' }),
      });
      expect(response.status).toBe(200);
      expect((await response.json()).content).toBe('Compiled reply.');
      for (let pass = 0; pass < 2; pass++) {
        const messages = await (
          await fetch(`${backend.url}/session/${session.id}/message?reasoning=true`, { headers })
        ).json();
        expect(messages.at(-1).reasoning).toBe('Compiled reasoning persists.');
        const runs = await (
          await fetch(`${backend.url}/session/${session.id}/runs`, { headers })
        ).json();
        expect(runs).toHaveLength(1);
        const processResponse = await fetch(
          `${backend.url}/session/${session.id}/runs/${runs[0].id}/trace?view=process`,
          { headers },
        );
        const process = await processResponse.json();
        expect(process.entries[0]).toMatchObject({
          kind: 'model',
          text: 'Compiled reply.',
          reasoning: 'Compiled reasoning persists.',
        });
        const tracePath = `${backend.url}/session/${session.id}/runs/${runs[0].id}/trace`;
        expect((await (await fetch(tracePath, { headers })).json()).graph.nodes).toContain('model');
        const snapshot = await (await fetch(`${tracePath}?node=model%3A1`, { headers })).json();
        expect(snapshot.request.payload.messages).toContainEqual({
          role: 'user',
          content: 'Inspect this compiled request.',
        });
        if (pass === 0) {
          await stop(backend);
          backend = undefined;
          backend = await start();
        }
      }
    } finally {
      if (backend) await stop(backend);
      model.stop(true);
      await f.cleanup();
    }
  },
  30000,
);
test.skipIf(!process.env.AUTO_AGENT_TEST_BINARY)(
  'compiled application starts its bundled MCP program without Node or Bun on PATH',
  async () => {
    const f = await fixture();
    const mcpCwd = join(f.dir, 'mcp-cwd');
    await mkdir(mcpCwd);
    let reads = 0;
    const vendor = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => {
        reads++;
        return Response.json({
          ok: true,
          data: {
            health: { softwareReady: true, deviceConnected: true, deviceBusy: false },
            task: null,
          },
        });
      },
    });
    const file = join(f.dir, 'config.json');
    await writeFile(
      file,
      JSON.stringify({
        ...f.config,
        mcpServers: {
          instrument: {
            command: 'builtin',
            args: ['--mcp-server', 'climber'],
            cwd: mcpCwd,
            env: {
              CLIMBER_SERVICE_URL: `${vendor.url.origin}/api/v1`,
              CLIMBER_TIMEOUT_MS: '1000',
              CLIMBER_STATE_DIR: 'state',
            },
            tools: { get_status: 'read' },
            timeoutMs: 5000,
          },
        },
        devices: [
          { id: 'instrument-1', name: 'Climber test', kind: 'climber', mcpServer: 'instrument' },
        ],
      }),
    );
    const proc = Bun.spawn([binary, 'serve', '--config', file], {
      cwd: f.dir,
      env: {
        PATH: '',
        SystemRoot: process.env.SystemRoot ?? '',
        AUTO_AGENT_TOKEN: f.config.token,
        AUTO_AGENT_DESKTOP: '1',
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const reader = proc.stdout.getReader();
    const errors = new Response(proc.stderr).text();
    try {
      const listening = (async () => {
        let text = '';
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error('Backend exited before listening');
          text += new TextDecoder().decode(chunk.value);
          const line = text.split('\n').find((s) => s.startsWith('{') && s.endsWith('}'));
          if (line) return JSON.parse(line) as { url: string };
        }
      })();
      const info = await Promise.race([
        listening,
        Bun.sleep(10000).then(() => {
          throw new Error('Startup timeout');
        }),
      ]);
      const headers = {
        Authorization: `Bearer ${f.config.token}`,
        'Content-Type': 'application/json',
      };
      const response = await fetch(`${info.url}/devices/instrument-1/refresh`, {
        method: 'POST',
        headers,
        body: '{}',
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        transport: 'connected',
        stale: false,
        health: { deviceConnected: true },
        task: null,
        taskKnown: true,
      });
      expect(reads).toBe(1);
      expect(
        (await readdir(join(mcpCwd, 'state'))).filter((name) => name.endsWith('.sqlite')),
      ).toHaveLength(1);
      expect(
        (await fetch(`${info.url}/desktop/shutdown`, { method: 'POST', headers })).status,
      ).toBe(200);
      expect(await Promise.race([proc.exited, Bun.sleep(10000).then(() => -999)])).toBe(0);
    } finally {
      proc.stdin.end();
      if (proc.exitCode === null) proc.kill();
      await proc.exited;
      await reader.cancel();
      await errors;
      vendor.stop(true);
      await f.cleanup();
    }
  },
  30000,
);
test.skipIf(!process.env.AUTO_AGENT_TEST_BINARY)(
  'compiled binary serves authenticated sessions and works outside repository cwd',
  async () => {
    const f = await fixture();
    try {
      const help = Bun.spawn([binary, '--help'], { cwd: f.dir, stdout: 'pipe', stderr: 'pipe' });
      expect(await new Response(help.stdout).text()).toContain('auto-agent [serve]');
      expect(await help.exited).toBe(0);
      const invalid = Bun.spawn([binary, '--config', join(f.dir, 'missing.json')], {
        cwd: f.dir,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(await new Response(invalid.stderr).text()).toContain('Cannot read configuration');
      expect(await invalid.exited).toBe(1);
    } catch (error) {
      await f.cleanup();
      throw error;
    }
    const file = join(f.dir, 'config.json');
    await writeFile(
      file,
      JSON.stringify({
        ...f.config,
        skillRoots: [],
        builtinSkills: true,
        builtinWiki: true,
        resourceLimitBytes: 65536,
      }),
    );
    const proc = Bun.spawn([binary, 'serve', '--config', file], {
      cwd: f.dir,
      env: { ...process.env, AUTO_AGENT_TOKEN: f.config.token },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    try {
      const reader = proc.stdout.getReader();
      const first = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('startup timeout')), 10000),
        ),
      ]);
      let startup = new TextDecoder().decode(first.value);
      while (!startup.split('\n').some((line) => line.startsWith('{'))) {
        const next = await reader.read();
        if (next.done) throw new Error('Server exited before listening');
        startup += new TextDecoder().decode(next.value);
      }
      const info = JSON.parse(startup.split('\n').find((line) => line.startsWith('{'))!);
      expect(startup).not.toContain('[info]');
      const fileLog = await readFile(join(f.config.dataDir, 'logs', 'agent.jsonl'), 'utf8');
      expect(
        fileLog
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
          .some((entry) => entry.event === 'app.started'),
      ).toBe(true);
      const builtinsRoot = join(f.config.dataDir, 'builtin-skills');
      const versions = await readdir(builtinsRoot);
      expect(versions).toHaveLength(1);
      for (const [path, content] of Object.entries(await collectBuiltinAssets('skills')))
        expect(await readFile(join(builtinsRoot, versions[0]!, ...path.split('/')), 'utf8')).toBe(
          content,
        );
      const sam = join(builtinsRoot, versions[0]!, 'device-automation', 'scripts', 'sam.js');
      const generation = Bun.spawn(
        [
          binary,
          '--auto-agent-internal-script',
          sam,
          'create',
          JSON.stringify({
            product: 'g12',
            settings: {
              analysisType: 'bet',
              sampleName: '离线生成样品',
              sampleMassG: 1.5,
              tubeMassG: 29.1,
            },
          }),
        ],
        {
          cwd: f.dir,
          env: { SystemRoot: process.env.SystemRoot, SAM_OUTPUT_DIR: join(f.dir, 'generated') },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const [generatedText, generatedError, generatedCode] = await Promise.all([
        new Response(generation.stdout).text(),
        new Response(generation.stderr).text(),
        generation.exited,
      ]);
      expect(generatedError).toBe('');
      expect(generatedCode).toBe(0);
      const generated = JSON.parse(generatedText);
      expect(generated.generation.sampleInputsComplete).toBe(true);
      expect(generated.facts.analysisType.value).toBe('bet');
      expect(generated.file.path.startsWith(join(f.dir, 'generated'))).toBe(true);
      expect((await readFile(generated.file.path)).readInt32BE(0)).toBe(0x2010);
      const base = info.url;
      await reader.cancel();
      expect((await fetch(base + '/global/health')).status).toBe(200);
      expect((await fetch(base + '/session')).status).toBe(401);
      const headers = {
        Authorization: `Bearer ${f.config.token}`,
        'Content-Type': 'application/json',
      };
      const session = await (
        await fetch(base + '/session', { method: 'POST', headers, body: '{}' })
      ).json();
      expect(session.id).toBeTruthy();
      const cases = await (
        await fetch(
          base +
            '/wiki/search?filters=' +
            encodeURIComponent('{"hasPretreatment":true}') +
            '&limit=1',
          { headers },
        )
      ).json();
      expect(cases.results[0].metadata.hasPretreatment).toBe(true);
      const referenceResponse = await fetch(
        base + '/wiki/source/' + cases.results[0].id + '?sections=sample,reports',
        { headers },
      );
      expect(referenceResponse.status).toBe(200);
      const reference = await referenceResponse.json();
      expect(reference.sourceVerified).toBe(false);
      expect(reference.record.configuration.referenceSettings.revision).toBe(
        'reference-settings-v1',
      );
      expect(
        Object.keys(reference.record.configuration.referenceSettings.groups.pretreatment.fields)
          .length,
      ).toBeGreaterThan(0);
      expect(
        reference.record.configuration.referenceSettings.reports.some(
          (report: any) => Object.keys(report.parameters).length > 0,
        ),
      ).toBe(true);
      proc.kill();
      await proc.exited;
      expect(await new Response(proc.stderr).text()).toContain('device-automation (built-in)');
      const cli = Bun.spawn([binary, '--config', file], {
        cwd: f.dir,
        env: { ...process.env, AUTO_AGENT_TOKEN: f.config.token },
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: new Blob(['/exit\n']),
      });
      expect(await cli.exited).toBe(0);
      expect(await new Response(cli.stdout).text()).toBe('');
      expect(await new Response(cli.stderr).text()).toContain('Session: ');
    } finally {
      proc.kill();
      await proc.exited;
      await f.cleanup();
    }
  },
  30000,
);
