import { tool } from 'ai';
import { z } from 'zod';
import { AppError } from '../shared/types';
import { UncertainToolError, type ToolContext, type ToolResult } from './context';
import { skillTool } from './tools/skill';
import { readTool } from './tools/read';
import { executeScriptTool } from './tools/script';
import { wikiTool } from './tools/wiki';
import { webFetchTool } from './tools/web-fetch';
import { webSearchTool } from './tools/web-search';
export { UncertainToolError } from './context';
export type { ToolContext, ToolResult, ToolSpec, ToolEffect } from './context';

export const toolSpecs = {
  skill: skillTool,
  read: readTool,
  execute_script: executeScriptTool,
  wiki: wikiTool,
  web_fetch: webFetchTool,
  web_search: webSearchTool,
} as const;

export type ToolName = keyof typeof toolSpecs;
export type ToolInput<K extends ToolName> = z.infer<(typeof toolSpecs)[K]['inputSchema']>;

export const toolSchemas = Object.fromEntries(
  Object.entries(toolSpecs).map(([name, spec]) => [name, spec.inputSchema]),
) as { [K in ToolName]: (typeof toolSpecs)[K]['inputSchema'] };

export function contextRetentionFor(name: string) {
  return Object.hasOwn(toolSpecs, name) ? toolSpecs[name as ToolName].retention : undefined;
}

export class BuiltinToolRegistry {
  specs() {
    return Object.entries(toolSpecs).map(([name, spec]) => ({ name, ...spec }));
  }

  modelTools() {
    return Object.fromEntries(
      this.specs().map(({ name, description, inputSchema }) => [
        name,
        tool({ description, inputSchema: inputSchema as z.ZodType }),
      ]),
    );
  }

  contextTokenEstimate(): number {
    const definitions = this.specs().map(({ name, description, inputSchema }) => ({
      name,
      description,
      parameters: z.toJSONSchema(inputSchema, { io: 'input' }),
    }));
    return Math.ceil(Buffer.byteLength(JSON.stringify(definitions), 'utf8') / 3);
  }

  async execute(name: string, rawInput: unknown, context: ToolContext): Promise<ToolResult> {
    if (!Object.hasOwn(toolSpecs, name))
      throw new AppError('unknown_tool', 'Tool is not available');
    return this.dispatch(name as ToolName, rawInput, context);
  }

  private async dispatch<K extends ToolName>(
    name: K,
    rawInput: unknown,
    context: ToolContext,
  ): Promise<ToolResult> {
    const spec = toolSpecs[name];
    const input = spec.inputSchema.parse(rawInput) as ToolInput<K>;
    if (
      spec.requiresLoadedSkill &&
      (!('skill' in input) || !context.run.loadedSkills.has(input.skill))
    )
      throw new AppError(
        'skill_not_loaded',
        'Load skill instructions before accessing resources or scripts',
      );
    const execute = spec.execute as (
      input: ToolInput<K>,
      context: ToolContext,
    ) => Promise<ToolResult>;
    const result = await execute(input, context);
    const parsed = spec.outputSchema.safeParse(result.output);
    if (!parsed.success) {
      if (spec.effects.includes('process'))
        throw new UncertainToolError(
          'Tool returned an invalid process result; operator review is required',
        );
      throw new AppError('tool_output', 'Tool returned an invalid result');
    }
    const format = spec.toModelContent as ((output: unknown) => string) | undefined;
    return {
      ...result,
      output: parsed.data,
      ...(format ? { modelText: format(parsed.data) } : {}),
    };
  }
}
