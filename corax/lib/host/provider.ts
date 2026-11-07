import { join } from 'node:path';
import {
  defineSandboxProvider,
  type SandboxProviderSessionContext,
} from '@coraxjs/core/sandbox/provider';
import { getRuntimeConfig } from '../config';
import { createHostSession } from './session';

async function open(context: SandboxProviderSessionContext) {
  const session = await createHostSession({
    workspace: join(getRuntimeConfig().dataDir, 'workspace'),
    skills: context.host.resolveProjectPath('skills'),
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
