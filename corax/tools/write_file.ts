import { defineTool } from '@coraxjs/core/tools';
import writeFile from '@coraxjs/core/tools/write_file';
import { requestApproval } from '../lib/approval';

export default defineTool({
  ...writeFile,
  approval: {
    request: (context) => requestApproval(context),
    prompt: () => '即将写入文件；目标已存在时会覆盖内容。请核对路径和内容后批准本次调用。',
  },
});
