import { BookOpen, ChevronDown, CircleAlert, SquareTerminal, Users, Wrench } from 'lucide-react';
import type {
  CoraxDynamicToolPart,
  ConversationState,
  ChatCallState,
} from '@auto-agent/desktop-protocol';
import './ChatTool.css';
import { ProcessingLabel } from '../ProcessingLabel/ProcessingLabel';

const statusLabels: Record<ChatCallState['status'], string> = {
  running: '执行中',
  'awaiting-input': '等待确认',
  completed: '已完成',
  failed: '失败',
  rejected: '已拒绝',
  cancelled: '已取消',
  interrupted: '结果待确认',
};

function json(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text && text.length > 32000
    ? text.slice(0, 32000) + '\n…内容较长，已截断显示'
    : (text ?? '无');
}

export function ChatTool({
  part,
  conversation,
  callState,
  open,
  onOpenChange,
  paused = false,
}: {
  part: CoraxDynamicToolPart;
  conversation: ConversationState;
  callState: ChatCallState;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  paused?: boolean;
}) {
  const metadata = part.toolMetadata?.corax;
  const kind = metadata?.kind;
  const title =
    kind === 'load-skill' ? '加载 Skill' : kind === 'subagent-call' ? '子 Agent' : '工具调用';
  const name = metadata?.name ?? part.toolName;
  const shell = kind === 'tool-call' && name === 'bash';
  const input = part.input;
  const command =
    shell &&
    typeof input === 'object' &&
    input !== null &&
    'command' in input &&
    typeof input.command === 'string'
      ? input.command
      : undefined;
  const commandLine = command?.split(/\r?\n/)[0] ?? '';
  const preview =
    commandLine.slice(0, 240) +
    (command && (command.includes('\n') || commandLine.length > 240) ? ' …' : '');
  const output = part.state === 'output-available' ? part.output : undefined;
  const shellOutput =
    shell &&
    typeof output === 'object' &&
    output !== null &&
    'stdout' in output &&
    'stderr' in output &&
    typeof output.stdout === 'string' &&
    typeof output.stderr === 'string'
      ? output
      : undefined;
  const taskCall = Object.values(conversation.tasks)
    .flatMap((task) => Object.values(task.calls))
    .find((call) => call.callId === part.toolCallId);
  const nativeStatus = callState.status;
  const failed = nativeStatus === 'failed';
  const denied = nativeStatus === 'rejected';
  const awaiting = nativeStatus === 'awaiting-input';
  const running = nativeStatus === 'running';
  const cancelled = nativeStatus === 'cancelled';
  const uncertain = nativeStatus === 'interrupted';
  const status =
    paused && (running || uncertain)
      ? '状态待同步'
      : running && part.state === 'input-streaming'
        ? '接收参数'
        : awaiting && part.state === 'approval-responded'
          ? '确认已提交'
          : statusLabels[nativeStatus];
  const Icon =
    kind === 'load-skill'
      ? BookOpen
      : kind === 'subagent-call'
        ? Users
        : shell
          ? SquareTerminal
          : Wrench;
  return (
    <details
      className="chat-tool"
      data-call-id={part.toolCallId}
      data-kind={kind}
      data-status={status}
      open={open}
      onToggle={(event) => {
        if (event.currentTarget.open !== open) onOpenChange(event.currentTarget.open);
      }}
    >
      <summary>
        {failed || cancelled || denied || uncertain ? (
          <CircleAlert size={15} />
        ) : (
          <Icon size={15} />
        )}
        {kind === 'load-skill' && <span className="chat-tool-kind">{title}</span>}
        <span className="chat-tool-caption" title={command ?? metadata?.label ?? name}>
          {command
            ? `${nativeStatus === 'completed' ? '已运行' : '运行'} ${preview}`
            : kind === 'load-skill'
              ? name
              : (metadata?.label ?? name)}
        </span>
        <span className="chat-tool-status">
          {running && !paused ? <ProcessingLabel text={status} /> : status}
        </span>
        <ChevronDown size={14} className="chat-tool-chevron" aria-hidden="true" />
      </summary>
      <div className="chat-tool-body">
        <div className="chat-tool-console-title">{shell ? 'Shell' : name}</div>
        {shell && command ? (
          <pre className="chat-tool-command">$ {json(command)}</pre>
        ) : (
          <>
            <h4>调用参数</h4>
            <pre>
              {part.state === 'input-streaming'
                ? json(part.inputText || '参数生成中…')
                : json(part.input)}
            </pre>
          </>
        )}
        {part.state === 'output-available' && (
          <>
            {!shellOutput && <h4>{part.partial ? '阶段结果' : '返回结果'}</h4>}
            <pre className="chat-tool-output">
              {shellOutput
                ? json(
                    `${shellOutput.stdout}${shellOutput.stderr ? `\n${shellOutput.stderr}` : ''}`,
                  )
                : json(part.output)}
            </pre>
            {shellOutput &&
              'exitCode' in shellOutput &&
              typeof shellOutput.exitCode === 'number' && (
                <p className="chat-tool-exit">退出码 {shellOutput.exitCode}</p>
              )}
            {shellOutput && 'message' in shellOutput && typeof shellOutput.message === 'string' && (
              <p>{shellOutput.message}</p>
            )}
            {shellOutput && 'truncated' in shellOutput && shellOutput.truncated === true && (
              <p>Corax 已截断命令输出。</p>
            )}
          </>
        )}
        {failed && <p role="alert">{callState.errorText ?? '调用失败'}</p>}
        {denied && <p>{part.approval?.reason || '本次调用未获批准。'}</p>}
        {uncertain && <p>尚未记录最终调用结果；请核对实际状态。</p>}
        {taskCall?.status === 'completed' && taskCall.output !== undefined && (
          <>
            <h4>任务结果</h4>
            <pre>{json(taskCall.output)}</pre>
          </>
        )}
        {Object.values(conversation.agents)
          .filter((agent) => agent.callId === part.toolCallId)
          .map((agent) => (
            <p key={agent.sessionId}>
              子 Agent：{agent.name} · <code>{agent.sessionId}</code>
            </p>
          ))}
      </div>
    </details>
  );
}
