import { defineTool } from '@coraxjs/core/tools';
import bash from '@coraxjs/core/tools/bash';
import { requestApproval } from '../lib/approval';

// Keep the native schema and executor; Corax owns the approval pause and resume.
export default defineTool({
  ...bash,
  approval: {
    request: (context) => requestApproval(context),
    prompt: () => '即将执行宿主 Bash 命令。请核对完整命令后批准本次调用。',
  },
});
