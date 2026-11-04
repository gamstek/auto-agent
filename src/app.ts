import { loadConfig } from './config';
import { Skills } from './skill';
import { ScriptExecutor } from './execution';
import { Store } from './storage';
import { CloudModel } from './llm';
import { AgentService } from './agent';
import { serve } from './api';
import { argumentsFor, cli, help } from './cli';
import { wikiCommand } from './cli/wiki';
import { AppError } from './shared/types';
import { output } from './shared/console';
import { Diagnostics } from './shared/diagnostics';
import { version } from '../package.json';
import { mcpEnvironmentSecrets } from './mcp/config';
import { InstrumentViews } from './integrations/instruments';
import { instrumentViewsSchema } from './integrations/config';
import { createWikiLibrary } from './integrations/wiki-library';
import { WikiError, type WikiLibrary } from '@auto-agent/wiki-core';

export async function main(argv = process.argv.slice(2), options: { development?: boolean; defaultConfig?: string } = {}) {
  const args = argumentsFor(argv);
  if (args.values.help) { output.text(help); return; }
  const index = Boolean(args.values['wiki-index']);
  const isServer = args.positionals[0] === 'serve';
  const isWiki = index || args.positionals[0] === 'wiki';
  if (index && args.positionals.length) throw new AppError('usage', '--wiki-index does not accept positional arguments');
  if (isWiki && (args.values.session || args.values.json || args.values['no-token']))
    throw new AppError('usage', 'Wiki commands do not accept --session, --json or --no-token');
  if (isServer && (args.positionals.length !== 1 || args.values.session || args.values.json))
    throw new AppError('usage', 'serve does not accept chat arguments, --session or --json.');
  const selected = args.values.config ?? options.defaultConfig;
  output.info(`Auto-Agent · ${isServer ? 'HTTP service' : isWiki ? 'Wiki' : 'interactive CLI'}`);
  if (options.development) output.info(`Mode: development\nSelected configuration: ${selected}`);
  const config = await loadConfig(selected, isServer && args.values['no-token'], !isServer);
  const bindings = isServer && config.configPath
    ? instrumentViewsSchema.parse((await Bun.file(config.configPath).json()).devices ?? []) : [];
  output.info(`Configuration: ${config.configPath}\nModel: ${config.model}\nData: ${config.dataDir}`);
  if (!config.apiKey && !isWiki) output.warn('AUTO_AGENT_API_KEY is not set. Set it before starting this process to enable chat. Configuration and health endpoints remain available.');
  if (isServer && config.noToken) output.warn('--no-token disables authentication. Local processes can access sessions and execute trusted scripts.');
  const store = new Store(config.dataDir);
  let storeClosed = false;
  const closeStore = () => { if (!storeClosed) { storeClosed = true; store.close(); } };
  let library: WikiLibrary | undefined;
  let service: AgentService | undefined;
  try {
    library = createWikiLibrary(config);
    const diagnostics = new Diagnostics(config.dataDir, [config.apiKey ?? '', config.token, ...mcpEnvironmentSecrets(config.mcpServers)]);
    diagnostics.write('agent', 'app.started', { version, configPath: config.configPath, dataDir: config.dataDir, mode: isServer ? 'http' : isWiki ? 'wiki' : 'cli', platform: process.platform, runtime: process.versions.bun, model: config.model });
    output.info(`Logs: ${diagnostics.directory}`);
    if (isWiki) {
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      try {
        output.info('Local Wiki: no model request is made.');
        output.json(await wikiCommand(library, config, index ? ['refresh'] : args.positionals.slice(1), controller.signal));
      } finally {
        process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
        await library.close(); closeStore();
      }
      return;
    }
    const skills = new Skills(config);
    const catalog = await skills.discover();
    output.info(`Skill roots: ${config.skillRoots.length ? config.skillRoots.join(', ') : '(none configured)'}\nSkills: ${catalog.length ? catalog.map((skill) => `${skill.name} (${skills.source(skill.name)})`).join(', ') : '(none discovered)'}`);
    const activeService = new AgentService(config, store, skills, new ScriptExecutor(config, skills, diagnostics), new CloudModel(config), diagnostics, library);
    service = activeService;
    const status = library.catalog();
    output.info(`Wiki: ${status.generation ? 'ready' : 'unbuilt'}; ${status.sources.length} indexed sources. Use wiki refresh to index configured sources explicitly.`);
    if (!isServer) {
      try { await cli(args, config, activeService); }
      finally { await activeService.shutdown(); closeStore(); }
      return;
    }
    const views = new InstrumentViews(bindings, config, activeService.mcp, (event) => activeService.events.publish(event));
    const server = serve(activeService, process.env.AUTO_AGENT_DESKTOP === '1' ? () => void stop() : undefined, [views.http]);
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      server.stop();
      try { await activeService.shutdown(); }
      finally {
        server.stop(true); closeStore();
        if (process.env.AUTO_AGENT_DESKTOP === '1') process.stdin.destroy();
      }
    };
    const url = `http://${config.host}:${server.port}`;
    output.info(`Listening: ${url}\nAuthentication: ${config.noToken ? 'disabled (loopback only)' : 'bearer token'}`);
    output.json({ event: 'listening', url });
    if (process.env.AUTO_AGENT_DESKTOP === '1') { process.stdin.resume(); process.stdin.once('end', () => void stop()); }
    process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
  } catch (error) {
    try { await service?.shutdown(); await library?.close(); } finally { closeStore(); }
    if (error instanceof WikiError) throw new AppError(error.code, error.message, error.status);
    throw error;
  }
}
