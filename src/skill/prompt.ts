import { join } from 'node:path';
import type { SkillInfo } from '../shared/types';

export const escapeXml = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!,
  );

export function skillGuidance(skills: SkillInfo[]): string {
  const catalog = [...skills].sort((a, b) => a.name.localeCompare(b.name));
  return [
    'Skills provide specialized instructions and workflows for specific tasks.',
    'Use the skill tool to load a skill when a task matches its description.',
    ...(catalog.length === 0
      ? ['No skills are currently available.']
      : [
          '<available_skills>',
          ...catalog.flatMap(({ name, description, directory }) => [
            '  <skill>',
            `    <name>${escapeXml(name)}</name>`,
            `    <description>${escapeXml(description)}</description>`,
            `    <location>${escapeXml(join(directory, 'SKILL.md'))}</location>`,
            '  </skill>',
          ]),
          '</available_skills>',
        ]),
  ].join('\n');
}

export function skillContent(
  name: string,
  directory: string,
  content: string,
  files: string[],
): string {
  return [
    `<skill_content name="${escapeXml(name)}">`,
    `# Skill: ${name}`,
    '',
    content.trim(),
    '',
    `Base directory for this skill: ${directory}`,
    'Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.',
    'Note: file list is sampled.',
    '',
    '<skill_files>',
    ...files.map((file) => `<file>${escapeXml(file)}</file>`),
    '</skill_files>',
    '</skill_content>',
  ].join('\n');
}
