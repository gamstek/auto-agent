import type { z } from 'zod';
import type { Skills } from '../skill';
import type { ScriptExecutor } from '../execution';
import type { Store } from '../storage';
import { AppError } from '../shared/types';
import type { Diagnostics } from '../shared/diagnostics';
import type { SearchInput, ReadInput } from '@auto-agent/wiki-core';

export interface ToolContext {
  skills: Pick<Skills, 'load' | 'list' | 'files' | 'read' | 'resolveScript'>;
  library?: {
    catalog(): unknown;
    search(input: SearchInput): unknown;
    read(input: ReadInput): unknown;
  };
  executor: Pick<ScriptExecutor, 'execute'>;
  audit: Pick<Store, 'beginExecution' | 'finishExecution'>;
  network: { allowPrivateAddresses: boolean };
  diagnostics?: Pick<Diagnostics, 'sanitize' | 'write'>;
  run: {
    id: string;
    signal: AbortSignal;
    loadedSkills: Set<string>;
    failedScripts: Set<string>;
  };
}

export interface ToolResult<T = unknown> {
  output: T;
  status: 'completed' | 'failed' | 'cancelled' | 'timeout' | 'output_limit';
  effect: 'none' | 'acknowledged' | 'unknown';
  modelText?: string;
}

export type ToolEffect = 'read' | 'network' | 'process';
export interface ContextRetention {
  kind: 'skill' | 'resource' | 'evidence';
  keys?: readonly string[];
  preserve?: (output: unknown) => boolean;
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
  return { output, status: 'completed', effect: 'none' };
}

export class UncertainToolError extends AppError {
  constructor(
    message: string,
    readonly diagnostic?: Record<string, unknown>,
    readonly toolResult?: ToolResult,
  ) {
    super('uncertain_execution', message);
  }
}
