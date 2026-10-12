import { z } from 'zod';
import { skillContent } from '../../skill/prompt';
import { completed, defineTool } from '../context';

export const skillTool = defineTool({
  description:
    'Load a specialized skill when the task matches an available skill in the system context. The result provides workflow instructions, a base directory, and a sampled file list. The name must match an available skill.',
  effects: ['read'],
  requiresLoadedSkill: false,
  inputSchema: z.object({ name: z.string().min(1) }),
  outputSchema: z.object({ name: z.string(), directory: z.string(), output: z.string() }),
  toModelContent: (output) => output.output,
  retention: { kind: 'skill', keys: ['name'] },
  async execute({ name }, { skills, run }) {
    const content = await skills.load(name);
    const skill = skills.list().find((entry) => entry.name === name)!;
    const body = content.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
    const result = {
      name: skill.name,
      directory: skill.directory,
      output: skillContent(skill.name, skill.directory, body, await skills.files(skill.name)),
    };
    run.loadedSkills.add(skill.name);
    return completed(result);
  },
});
