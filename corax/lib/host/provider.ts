import { join } from 'node:path';
import {
  defineSandboxProvider,
  type SandboxProviderSessionContext,
} from '@coraxjs/core/sandbox/provider';
import { getRuntimeConfig } from '../config';
import { createHostSession } from './session';
import { toShellPath } from './paths';

async function open(context: SandboxProviderSessionContext) {
  const session = await createHostSession({
    workspace: join(getRuntimeConfig().dataDir, 'workspace'),
    skills: context.host.resolveProjectPath('skills'),
    project: context.host.resolveProjectPath('.'),
  });
  return {
    sandbox: session.sandbox,
    onRuntimeShutdown: session.close,
    onSandboxDelete: session.close,
    onSandboxStop: session.close,
  };
}

/** A durable Corax provider handle over the real host, with no template cache. */
export const HostSandbox = defineSandboxProvider<undefined, undefined, null, null>({
  name: 'host',
  environment() {
    return {
      // Metadata only: use the launcher/CLI project root, not bundled module
      // locations. Skill discovery must not require opening a host session.
      get paths() {
        const project =
          process.env.AUTO_AGENT_PROJECT_ROOT ?? process.env.CORAX_PROJECT_ROOT ?? process.cwd();
        return { skills: toShellPath(join(project, 'skills')) };
      },
      async prepare() {
        return null;
      },
      async start(context) {
        return { handle: await open(context), state: null };
      },
      async resume(context) {
        return open(context);
      },
    };
  },
});
