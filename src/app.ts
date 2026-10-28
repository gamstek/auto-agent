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
import { Wiki } from './wiki';
export async function main(
  argv = process.argv.slice(2),
  options: { development?: boolean; defaultConfig?: string } = {},
) {
  const args = argumentsFor(argv);
  if (args.values.help) {
    output.text(help);
    return;
  }
  const updatingWiki = Boolean(args.values['wiki-update']);
  const indexingWiki = Boolean(args.values['wiki-index']);
  if (updatingWiki && indexingWiki)
    throw new AppError('usage', 'Select only one of --wiki-update and --wiki-index');
  if (
    (updatingWiki || indexingWiki) &&
    (args.positionals.length || args.values.session || args.values.json || args.values['no-token'])
  )
    throw new AppError(
      'usage',
      `${updatingWiki ? '--wiki-update' : '--wiki-index'} does not accept chat, serve, --session, --json or --no-token arguments`,
    );
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
  if (!config.apiKey && !indexingWiki)
    output.warn(
      'AUTO_AGENT_API_KEY is not set. Set it before starting this process to enable chat. Configuration and health endpoints remain available.',
    );
  if (isServer && config.noToken)
    output.warn(
      '--no-token disables authentication. Local processes can access sessions and execute trusted scripts.',
    );
  const store = new Store(config.dataDir);
  if (updatingWiki || indexingWiki) {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      output.info(
        updatingWiki
          ? 'Explicit wiki update: changed source text is sent to the configured model provider.'
          : 'Explicit local Wiki file indexing: files are read locally; no model request is made.',
      );
      const wiki = new Wiki(config, store.db);
      try {
        output.json(
          updatingWiki
            ? await wiki.update(new CloudModel(config), controller.signal)
            : await wiki.indexSources(controller.signal),
        );
      } finally {
        wiki.close();
      }
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      store.close();
    }
    return;
  }
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
  const wiki = await new Wiki(config).status();
  output.info(
    `Wiki roots: ${config.wikiRoots.length ? config.wikiRoots.join(', ') : '(none configured)'}\nWiki: ${wiki.sources.length ? wiki.sources.map((source) => `${source.slice(source.indexOf('/') + 1)} (${source.startsWith('builtin/') ? 'built-in' : 'configured'})`).join(', ') : '(none discovered)'}\nWiki knowledge: ${wiki.state}${wiki.state === 'ready' ? ` (${wiki.records} records; built ${new Date(wiki.builtAt!).toISOString()})` : ''}`,
  );
  if (wiki.state === 'invalid') output.warn(`Wiki: ${wiki.error}`);
  else if (wiki.state === 'unbuilt' || wiki.state === 'stale')
    output.warn(
      'Run --wiki-update explicitly before using wiki knowledge. No model request was made during startup.',
    );
  const service = new AgentService(
    config,
    store,
    skills,
    new ScriptExecutor(config, skills),
    new CloudModel(config),
  );
  const fileIndex = service.wiki.indexStatus();
  output.info(
    `Wiki index roots: ${config.wikiIndexRoots.length ? config.wikiIndexRoots.join(', ') : '(none configured)'}\nWiki file index: ${fileIndex.state} (${fileIndex.records} records)`,
  );
  if (fileIndex.state === 'unbuilt' || fileIndex.state === 'stale')
    output.warn(
      'Run --wiki-index explicitly before searching Wiki source files. Startup did not scan index roots.',
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
