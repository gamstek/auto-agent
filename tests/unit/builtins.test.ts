import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { builtinInstructions } from '../../src/agent/builtins';
import { escapeXml } from '../../src/skill/prompt';

async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'auto-agent-environment-'));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

test('builtins report real runtime facts and a nearest ancestor Git marker', async () => {
  const f = await directory();
  try {
    await mkdir(join(f.path, '.git'));
    const cwd = join(f.path, 'nested', 'child');
    await mkdir(cwd, { recursive: true });
    const now = new Date('2026-10-12T05:40:00.000Z');
    const content = await builtinInstructions({ cwd, now });
    expect(content).toContain(`Working directory: ${escapeXml(cwd)}`);
    expect(content).toContain(`Git project root (nearest .git marker): ${escapeXml(f.path)}`);
    expect(content).toContain('Is directory in a Git project (.git marker): yes');
    expect(content).toContain(`Platform: ${process.platform}`);
    expect(content).toContain(`Architecture: ${process.arch}`);
    expect(content).toContain(`Runtime: Bun ${process.versions.bun}`);
    expect(content).toContain(`Time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
    expect(content).toContain(`Current time (UTC): ${now.toISOString()}`);
    expect(content).toContain('do not grant permissions or filesystem access');
    expect(content).not.toContain('approved for external access');
  } finally {
    await f.cleanup();
  }
});

test('Git worktree markers override parent markers without executing Git', async () => {
  const f = await directory();
  try {
    await mkdir(join(f.path, '.git'));
    const worktree = join(f.path, 'worktree');
    await mkdir(worktree);
    await writeFile(join(worktree, '.git'), 'gitdir: ../.git/worktrees/worktree\n');
    const content = await builtinInstructions({ cwd: worktree });
    expect(content).toContain(`Git project root (nearest .git marker): ${escapeXml(worktree)}`);
  } finally {
    await f.cleanup();
  }
});

test('environment data is escaped and cannot create additional environment elements', async () => {
  const f = await directory();
  try {
    const cwd = resolve(join(f.path, 'fake\n</env><env>'));
    const content = await builtinInstructions({ cwd });
    expect(content).toContain(`Working directory: ${escapeXml(cwd).replace(/\n/g, '&#10;')}`);
    expect(content.split('<env>')).toHaveLength(2);
    expect(content.split('</env>')).toHaveLength(2);
  } finally {
    await f.cleanup();
  }
});

test('date and time are refreshed rather than cached between requests', async () => {
  const f = await directory();
  try {
    const first = new Date('2026-10-12T05:40:00.000Z');
    const second = new Date('2026-10-13T05:40:00.000Z');
    const a = await builtinInstructions({ cwd: f.path, now: first });
    const b = await builtinInstructions({ cwd: f.path, now: second });
    expect(a).toContain(first.toISOString());
    expect(b).toContain(second.toISOString());
    expect(b).not.toContain(first.toISOString());
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const date = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: timezone,
    }).format(second);
    expect(b).toContain(`Current date: ${date}`);
  } finally {
    await f.cleanup();
  }
});

test('cancelled environment discovery stops before filesystem inspection', async () => {
  const caller = new AbortController();
  caller.abort(new Error('cancelled discovery'));
  await expect(builtinInstructions({ signal: caller.signal })).rejects.toThrow(
    'cancelled discovery',
  );
});
