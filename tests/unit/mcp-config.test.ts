import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { fixture } from '../helpers';
import { loadConfig } from '../../src/config';

test('MCP configuration is generic and does not require instrument bindings', async () => {
  const f = await fixture();
  const file = join(f.dir, 'config.json');
  const load = async (value: unknown) => {
    await writeFile(file, JSON.stringify(value));
    return loadConfig(file, false, true);
  };
  try {
    const plain = await load({
      scriptEnv: { CLIMBER_SERVICE_URL: 'http://127.0.0.1:18080/api/v1' },
    });
    expect(plain.mcpServers).toEqual({});
    const parsed = await load({
      mcpServers: { helper: { command: './helpers/mcp', tools: { echo: 'read' } } },
    });
    expect(parsed.mcpServers!.helper!.command).toBe(join(f.dir, 'helpers', 'mcp'));
    expect(parsed.mcpServers!.helper!.cwd).toBe(f.dir);
    expect(parsed.mcpServers!.helper!.outcomeContract).toBe('opaque');
    expect('devices' in parsed).toBe(false);
    await expect(
      load({ mcpServers: { helper: { command: 'node', envFrom: { TOKEN: 'AUTO_AGENT_TOKEN' } } } }),
    ).rejects.toThrow('configuration fields');
  } finally {
    await f.cleanup();
  }
});
