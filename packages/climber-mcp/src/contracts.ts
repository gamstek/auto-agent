import { inputs } from './vendor';
import { samFileInput } from './sam/contracts';

export {
  inputs,
  resultSchema,
  healthSchema,
  VendorError,
  type ClimberTool,
  type ClimberResult,
} from './vendor';
export { samFileInput, samWrites, type SamFileInput } from './sam/contracts';

export const mcpTools = {
  sam_file: {
    description:
      '在 MCP 执行宿主处理 SAM/SMP 文件。文件能力支持 Climber 和 SiCOPE 的模板，与 Climber 厂家设备控制分开；可处理 SiCOPE 文件不代表已接入 SiCOPE 控制。支持 profiles/inspect/compare/create/modify/save-as，input 为参数对象。路径是 MCP 宿主绝对路径，不是 Shell 的 /workspace 别名；复用 file.path。modify/save-as 核对源 expectedSha256。写入需用户授权；失败、取消或 writeOutcome=unknown 后先核对路径和哈希，不自动重试。未配置厂家地址仍可处理文件；成功不证明厂家可读或实验适用，不会登记或启动设备。JSON 参数最多16384字节，完整结果最多60000字节，不返回截断配置。',
    inputSchema: samFileInput,
  },
  get_health: {
    description: '只读查询 Climber 厂家软件就绪与设备连接状态；失败时状态未知，不推断设备停机。',
    inputSchema: inputs.get_health,
  },
  get_status: {
    description:
      '只读查询 Climber 当前批次、实验与健康状态，不查询历史任务。保留当前 batchId/experimentId、厂家状态与 simulation。',
    inputSchema: inputs.get_status,
  },
  register_batch: {
    description:
      '仅为 Climber（研发别称 G5）登记左侧1–3项实验，不启动；不用于 SiCOPE。samPath 必须为厂家 Windows 主机可读的盘符绝对 .SAM 文件，配置须为常规 labType=0；文件在其他主机时先落实部署映射。保留 batchId/experimentId 和原管号，返回1..72映射。仅在用户授权且样品/文件条件齐备时调用；OUTCOME_UNKNOWN、超时或取消后先核对批次，不自动重试或换编号重发。',
    inputSchema: inputs.register_batch,
  },
  start_batch: {
    description:
      '在 Climber 上启动已明确登记成功且当前 READY 的同一 batchId，不重复登记，不用于 SiCOPE。仅在用户授权且仪器就绪时调用；超时、取消或身份不明不得重试。取消对话不代表设备停止，此工具不提供 stop/pause。',
    inputSchema: inputs.start_batch,
  },
} as const;

export type ClimberMcpTool = keyof typeof mcpTools;
