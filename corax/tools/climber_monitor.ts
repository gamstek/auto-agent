import { defineWorkflowTool } from '@coraxjs/core/tools';
import { monitorInput } from '../lib/climber/monitor';
import { monitor } from '../lib/climber/monitor-workflow';

export default defineWorkflowTool({
  description:
    'Climber 已启动批次的只读后台跟踪。仅在已启用 Climber 且启动回执明确成功或当前状态明确为同一批次 STARTING/RUNNING 后调用，复用 batchId 和完整 experimentIds；simulation 已知时原样传入。调用立即返回 Corax 原生任务回执，普通回复后任务继续，完成或异常结果随后回到原会话。默认每60秒查询，最长72小时，可设5–300秒及最多168小时。只读 get_status，不登记、启动或重试写入；同一批次只创建一个跟踪任务。未启用、状态失败、身份变化、配置变化或时限到达时结束并报告，不自动重开；未启用时不访问厂家。取消任务只取消跟踪，不停止设备；关闭应用会中断本机工作，不保证离线跟踪。SiCOPE 及完整外部自动化尚未接入。',
  inputSchema: monitorInput,
  label: { start: () => '后台跟踪 Climber 批次' },
  task: monitor,
});
