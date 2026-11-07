import { homedir } from 'node:os';
import { resolve } from 'node:path';

export const DATA_LAYOUT = 'corax-node-llm-wiki-v1';
export const defaultConfigPath = () => resolve(homedir(), '.auto-agent/config.json');
export const developmentConfigPath = (projectRoot: string) =>
  resolve(projectRoot, '.auto-agent/config.json');
