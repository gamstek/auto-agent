import { loadConfig } from './config';
import { Skills } from './skill';
import { ScriptExecutor } from './execution';
import { Store } from './storage';
import { CloudModel } from './llm';
import { AgentService } from './agent';
import { serve } from './api';
import { argumentsFor, cli, help } from './cli';
import { AppError } from './shared/types';
import { output } from './shared/console';
export async function main(
  argv = process.argv.slice(2),
  options: { development?: boolean; defaultConfig?: string } = {},
) {
  const args = argumentsFor(argv);
  if (args.values.help) {
    output.text(help);
    return;
  }
  const isServer = args.positionals[0] === 'serve';
  if (isServer && (args.positionals.length !== 1 || args.values.session || args.values.json))
    throw new AppError('usage', 'serve does not accept chat arguments, --session or --json.');
  const configFile = args.values.config ?? options.defaultConfig;
  output.info(`Auto-Agent · ${isServer ? 'HTTP service' : 'interactive CLI'}`);
  if (options.development) output.info(`Mode: development\nSelected configuration: ${configFile}`);
  const config = await loadConfig(configFile, isServer && args.values['no-token'], !isServer);
  output.info(
    `Configuration: ${config.configPath}\nModel: ${config.model}\nData: ${config.dataDir}`,
  );
  if (!config.apiKey)
    output.warn(
      'AUTO_AGENT_API_KEY is not set. Set it before starting this process to enable chat. Configuration and health endpoints remain available.',
    );
  if (isServer && config.noToken)
    output.warn(
      '--no-token disables authentication. Local processes can access sessions and execute trusted scripts.',
    );
  const store = new Store(config.dataDir);
  const skills = new Skills(config);
  let catalog;
  try {
    catalog = await skills.discover();
  } catch (error) {
    store.close();
    throw error;
  }
  output.info(
    `Skill roots: ${config.skillRoots.length ? config.skillRoots.join(', ') : '(none configured)'}\nSkills: ${catalog.length ? catalog.map((skill) => `${skill.name} (${skills.source(skill.name)})`).join(', ') : '(none discovered)'}`,
  );
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
    const url = `http://${config.host}:${server.port}`;
    output.info(
      `Listening: ${url}\nAuthentication: ${config.noToken ? 'disabled (loopback only)' : 'bearer token'}`,
    );
    output.json({ event: 'listening', url });
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
