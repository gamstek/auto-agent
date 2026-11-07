import { mcpTools, type ClimberMcpTool } from '@auto-agent/climber-mcp/contracts';
import type { AppConfig } from '../config';

/** The same configured tool set drives model registration and the desktop catalog. */
export function climberToolCatalog(config: Pick<AppConfig, 'climber'>) {
  return (Object.keys(mcpTools) as ClimberMcpTool[])
    .filter((operation) => operation === 'sam_file' || config.climber.enabled)
    .map((operation) => ({
      operation,
      name: operation === 'sam_file' ? operation : `climber_${operation}`,
      description: mcpTools[operation].description,
    }));
}
