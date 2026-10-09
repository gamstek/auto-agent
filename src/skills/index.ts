import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseDocument } from 'yaml';
import type { Config } from '../config';
import { AppError, type SkillInfo } from '../shared/types';

const validName = /^(?:[\p{Ll}\p{Lo}\p{N}]+)(?:-[\p{Ll}\p{Lo}\p{N}]+)*$/u;
const copy = (skill: SkillInfo): SkillInfo => structuredClone(skill);
interface Entry {
  skill: SkillInfo;
  root: string;
}

/** Trusted local skills, not an OS sandbox. Discovery is atomic and fails closed. */
export class Skills {
  private entries = new Map<string, Entry>();
  constructor(private readonly config: Config) {}

  async discover(): Promise<SkillInfo[]> {
    this.entries.clear();
    const found = new Map<string, Entry>();
    const diagnostics: string[] = [];
    for (const configured of this.config.skillRoots) {
      const root = resolve(configured);
      try {
        await this.confined(root, root, false);
        const children = await readdir(root, { withFileTypes: true });
        for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
          if (!child.isDirectory() && !child.isSymbolicLink()) continue;
          const directory = join(root, child.name);
          try {
            await this.confined(root, directory, false);
            const path = join(directory, 'SKILL.md');
            try {
              await lstat(path);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
              throw error;
            }
            const frontmatter = await this.bytes(root, path, true);
            const document = parseDocument(frontmatter, { uniqueKeys: true });
            if (document.errors.length) throw new Error('Invalid YAML');
            const data: unknown = document.toJS({ maxAliasCount: 0 });
            const skill = this.validate(data, directory);
            if (found.has(skill.name)) throw new Error(`Duplicate skill name: ${skill.name}`);
            found.set(skill.name, { skill, root });
          } catch (error) {
            diagnostics.push(
              `${directory}: ${error instanceof Error ? error.message : 'Invalid skill'}`,
            );
          }
        }
      } catch (error) {
        diagnostics.push(`${root}: ${error instanceof Error ? error.message : 'Invalid root'}`);
      }
    }
    if (diagnostics.length) throw new AppError('skill_discovery', diagnostics.join('\n'));
    this.entries = found;
    return this.list();
  }

  list(): SkillInfo[] {
    return [...this.entries.values()].map((entry) => copy(entry.skill));
  }

  /** Return the complete SKILL.md, including its frontmatter, only when requested. */
  async load(name: string): Promise<string> {
    return this.read(name, 'SKILL.md');
  }

  async read(name: string, path: string): Promise<string> {
    const entry = this.entry(name);
    const target = this.target(entry.skill.directory, path);
    await this.confined(entry.root, entry.skill.directory, false);
    return this.bytes(entry.skill.directory, target, false);
  }

  async resolveScript(name: string, path: string): Promise<{ skill: SkillInfo; path: string }> {
    const entry = this.entry(name);
    const target = this.target(entry.skill.directory, path);
    if (path.split(/[\\/]/)[0] !== 'scripts')
      throw new AppError('skill_path', 'Scripts must be inside scripts/');
    await this.confined(entry.root, entry.skill.directory, false);
    await this.confined(entry.skill.directory, target, true);
    return { skill: copy(entry.skill), path: target };
  }

  private entry(name: string): Entry {
    const entry = this.entries.get(name);
    if (!entry) throw new AppError('skill_not_found', `Unknown skill: ${name}`, 404);
    return entry;
  }

  private target(directory: string, path: string): string {
    if (
      typeof path !== 'string' ||
      !path ||
      isAbsolute(path) ||
      /[:\0]/.test(path) ||
      path
        .split(/[\\/]/)
        .some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part))
    ) {
      throw new AppError('skill_path', 'Invalid relative skill path');
    }
    return resolve(directory, ...path.split(/[\\/]/));
  }

  private async confined(root: string, target: string, file: boolean): Promise<void> {
    const rel = relative(root, target);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`))
      throw new AppError('skill_path', 'Path escapes skill directory');
    let current = root;
    const parts = rel ? rel.split(sep) : [];
    for (let i = -1; i < parts.length; i++) {
      if (i >= 0) current = join(current, parts[i]!);
      const stat = await lstat(current);
      if (stat.isSymbolicLink())
        throw new AppError('skill_path', 'Symbolic links are not permitted');
      if (i < parts.length - 1 || !file) {
        if (!stat.isDirectory()) throw new AppError('skill_path', 'Expected a directory');
      } else if (!stat.isFile()) throw new AppError('skill_path', 'Expected a regular file');
      if (relative(current, await realpath(current)) !== '')
        throw new AppError('skill_path', 'Non-canonical path is not permitted');
    }
  }

  private async bytes(root: string, path: string, headerOnly: boolean): Promise<string> {
    await this.confined(root, path, true);
    const before = await lstat(path);
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
        throw new AppError('skill_path', 'File changed while opening');
      const limit = this.config.resourceLimitBytes;
      if (!headerOnly && opened.size > limit)
        throw new AppError('resource_limit', 'Skill resource exceeds byte limit');
      const chunks: Buffer[] = [];
      let length = 0;
      while (length <= limit) {
        const buffer = Buffer.alloc(Math.min(4096, limit + 1 - length));
        const { bytesRead } = await handle.read(buffer);
        if (!bytesRead) break;
        chunks.push(buffer.subarray(0, bytesRead));
        length += bytesRead;
        if (headerOnly) {
          const text = Buffer.concat(chunks).toString('utf8');
          const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
          if (match) {
            if (Buffer.byteLength(match[0]) > limit)
              throw new AppError('resource_limit', 'Skill frontmatter exceeds byte limit');
            await this.confined(root, path, true);
            return match[1]!;
          }
        }
      }
      if (length > limit) throw new AppError('resource_limit', 'Skill resource exceeds byte limit');
      await this.confined(root, path, true);
      if (headerOnly) throw new AppError('skill_metadata', 'SKILL.md requires YAML frontmatter');
      return Buffer.concat(chunks).toString('utf8');
    } finally {
      await handle.close();
    }
  }

  private validate(data: unknown, directory: string): SkillInfo {
    if (!data || typeof data !== 'object' || Array.isArray(data))
      throw new Error('Frontmatter must be a mapping');
    const fields = data as Record<string, unknown>;
    const { name, description, ...metadata } = fields;
    if (
      typeof name !== 'string' ||
      [...name].length > 64 ||
      !validName.test(name) ||
      name !== basename(directory)
    )
      throw new Error('Invalid name or directory-name mismatch');
    if (typeof description !== 'string' || !description.trim() || [...description].length > 1024)
      throw new Error('Invalid description');
    for (const field of ['license', 'compatibility', 'allowed-tools', 'argument-hint']) {
      if (
        field in metadata &&
        (typeof metadata[field] !== 'string' || !(metadata[field] as string).trim())
      )
        throw new Error(`Invalid ${field}`);
    }
    if (typeof metadata.compatibility === 'string' && [...metadata.compatibility].length > 500)
      throw new Error('Compatibility exceeds 500 characters');
    for (const field of ['user-invocable', 'disable-model-invocation']) {
      if (field in metadata && typeof metadata[field] !== 'boolean')
        throw new Error(`Invalid ${field}`);
    }
    if ('metadata' in metadata) {
      const value = metadata.metadata;
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.values(value).some((item) => typeof item !== 'string')
      )
        throw new Error('Metadata must map strings to strings');
    }
    return { name, description, directory, metadata };
  }
}
