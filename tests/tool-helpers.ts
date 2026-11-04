import type { ToolContext } from '../src/tool';

export function toolFixture() {
  const calls: { name: string; input: unknown }[] = [];
  const skill = {
    name: 'example',
    directory: 'C:\\skills\\example',
    description: 'Example',
    metadata: {},
  };
  const context: ToolContext = {
    skills: {
      load: async (name) => {
        calls.push({ name: 'load', input: name });
        return '---\nname: example\n---\nFollow example guidance.';
      },
      list: () => [skill],
      files: async () => ['scripts/main.js', 'reference.txt'],
      read: async (skill, path) => {
        calls.push({ name: 'read', input: { skill, path } });
        return 'Resource text';
      },
      resolveScript: async () => ({ skill, path: 'C:\\skills\\example\\scripts\\main.js' }),
    },
    library: {
      catalog: () => ({ sources: [] }),
      search: (input) => {
        calls.push({ name: 'wiki-search', input });
        return {
          generation: 'fixture',
          results: [],
          nextCursor: null,
          sourceVerified: false,
        };
      },
      read: async () => {
        throw new Error('No fixture source');
      },
    },
    executor: {
      execute: async (input) => {
        calls.push({ name: 'execute', input });
        return { status: 'completed', exitCode: 0, stdout: 'ok', stderr: '' };
      },
    },
    audit: {
      beginExecution: (runId, skill, path) => {
        calls.push({ name: 'begin', input: { runId, skill, path } });
        return 'execution-1';
      },
      finishExecution: (id, result) => {
        calls.push({ name: 'finish', input: { id, result } });
      },
    },
    network: { allowPrivateAddresses: false },
    run: {
      id: 'run-1',
      signal: new AbortController().signal,
      loadedSkills: new Set(),
      failedScripts: new Set(),
    },
  };
  return { context, calls };
}
