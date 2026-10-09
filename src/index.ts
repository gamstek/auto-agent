import { loadConfig } from './config';
import { Skills } from './skills';
import { ScriptExecutor } from './execution';
import { Store } from './storage';
import { CloudModel } from './llm';
import { AgentService } from './agent';
import { serve } from './api';
import { argumentsFor, cli, help } from './cli';
import { AppError, errorText } from './shared/types';
import { warning } from './shared/console';
export async function main(
  argv = process.argv.slice(2),
  options: { development?: boolean; defaultConfig?: string } = {},
) {
  const args = argumentsFor(argv);
  if (args.values.help) {
    console.log(help);
    return;
  }
  const isServer = args.positionals[0] === 'serve';
  if (isServer && (args.positionals.length !== 1 || args.values.session || args.values.json))
    throw new AppError('usage', 'serve does not accept chat arguments, --session or --json.');
  const configFile = args.values.config ?? options.defaultConfig;
  if (options.development) console.log(`Mode: development\nSelected configuration: ${configFile}`);
  const config = await loadConfig(configFile, isServer && args.values['no-token'], !isServer);
  console.log(
    `Configuration: ${config.configPath}\nModel: ${config.model}\nData: ${config.dataDir}`,
  );
  if (!config.apiKey)
    warning(
      'AUTO_AGENT_API_KEY is not set. Set it before starting this process to enable chat. Configuration and health endpoints remain available.',
    );
  if (isServer && config.noToken)
    warning(
      '--no-token disables authentication. Local processes can access sessions and execute trusted scripts.',
    );
  const skills = new Skills(config);
  await skills.discover();
  const store = new Store(config.dataDir);
  const service = new AgentService(
    config,
    store,
    skills,
    new ScriptExecutor(config, skills),
    new CloudModel(config),
  );
  if (isServer) {
    let server: ReturnType<typeof serve>;
    try {
      server = serve(service);
    } catch (error) {
      store.close();
      throw error;
    }
    console.log(
      JSON.stringify({ event: 'listening', url: `http://${config.host}:${server.port}` }),
    );
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      server.stop();
      await service.shutdown();
      store.close();
    };
    process.once('SIGINT', () => void stop());
    process.once('SIGTERM', () => void stop());
  } else {
    try {
      await cli(args, config, service);
    } finally {
      await service.shutdown();
      store.close();
    }
  }
}
if (import.meta.main)
  main().catch((error) => {
    console.error(errorText(error));
    process.exitCode = 1;
  });
