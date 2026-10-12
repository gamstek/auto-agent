import type { z } from 'zod';
import type { Skills } from '../skill';
import type { Wiki } from '../wiki';
import type { ScriptExecutor } from '../execution';
import type { Store } from '../storage';
import { AppError, type ScriptResult } from '../shared/types';

export interface ToolContext {
  skills: Pick<Skills, 'load' | 'list' | 'files' | 'read' | 'resolveScript'>;
  wiki: Pick<Wiki, 'query'>;
  executor: Pick<ScriptExecutor, 'execute'>;
  audit: Pick<Store, 'beginExecution' | 'finishExecution'>;
  network: { allowPrivateAddresses: boolean };
  run: {
    id: string;
    signal: AbortSignal;
    loadedSkills: Set<string>;
    failedScripts: Set<string>;
  };
}

export interface ToolResult<T = unknown> {
  output: T;
  status: ScriptResult['status'];
  modelText?: string;
}

export type ToolEffect = 'read' | 'network' | 'process';
export interface ContextRetention {
  kind: 'skill' | 'resource' | 'evidence';
  keys?: readonly string[];
}
export interface ToolSpec<S extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  description: string;
  effects: readonly ToolEffect[];
  requiresLoadedSkill: boolean;
  inputSchema: S;
  outputSchema: O;
  toModelContent?: (output: z.infer<O>) => string;
  retention?: ContextRetention;
  execute: (input: z.infer<S>, context: ToolContext) => Promise<ToolResult>;
}

export function defineTool<S extends z.ZodType, O extends z.ZodType>(
  spec: ToolSpec<S, O>,
): ToolSpec<S, O> {
  return spec;
}

export function completed<T>(output: T): ToolResult<T> {
  return { output, status: 'completed' };
}

export class UncertainToolError extends AppError {
  constructor(message: string) {
    super('uncertain_execution', message);
  }
}
