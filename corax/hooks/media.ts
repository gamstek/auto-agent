import { defineHook } from '@coraxjs/core/hooks';
import { toolMedia } from '@auto-agent/desktop-protocol';
import { snapshotChatMedia } from '../lib/media/attachments';
import { getRuntimeConfig } from '../lib/config';

export default defineHook({
  events: {
    async 'action.result'(event) {
      if (event.data.status !== 'completed' || event.data.result.kind !== 'tool-result') return;
      const { toolName, output } = event.data.result;
      if (toolName !== 'read_file') return;
      const [image] = toolMedia(toolName, output);
      if (image?.kind !== 'file') return;
      try {
        await snapshotChatMedia(getRuntimeConfig().dataDir, `${event.meta.id}:0`, image);
      } catch {
        /* Preview is optional; its absence must not affect the tool result. */
      }
    },
  },
});
