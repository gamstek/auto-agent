import type { InstrumentSnapshot } from '../../types/instrument';
import './InstrumentDetails.css';

const fact = (value: boolean | null, yes: string, no: string) =>
  value === true ? yes : value === false ? no : '未能确认';

export function InstrumentDetails({
  device,
  compact = false,
}: {
  device: InstrumentSnapshot;
  compact?: boolean;
}) {
  return (
    <>
      <dl className="instrument-facts">
        {!compact && (
          <div>
            <dt>MCP 连接</dt>
            <dd>
              {(
                { connected: '已连接', disabled: '未启用', disconnected: '未连接' } as Record<
                  string,
                  string
                >
              )[device.transport] ?? '未能确认'}
            </dd>
          </div>
        )}
        <div>
          <dt>厂家接口</dt>
          <dd>
            {(
              { reachable: '可访问', unreachable: '暂不可访问', unknown: '未能确认' } as Record<
                string,
                string
              >
            )[device.vendorReachability] ?? '未能确认'}
          </dd>
        </div>
        <div>
          <dt>软件就绪</dt>
          <dd>{fact(device.health.softwareReady, '已就绪', '未就绪')}</dd>
        </div>
        <div>
          <dt>仪器连接</dt>
          <dd>{fact(device.health.deviceConnected, '已连接', '未连接')}</dd>
        </div>
        <div>
          <dt>仪器忙闲</dt>
          <dd>{fact(device.health.deviceBusy, '忙碌', '空闲')}</dd>
        </div>
        {!compact && (
          <div>
            <dt>最后成功更新</dt>
            <dd>
              {device.observedAt
                ? new Date(device.observedAt).toLocaleString('zh-CN')
                : '尚无成功查询'}
            </dd>
          </div>
        )}
      </dl>
      {device.error && (
        <p className="instrument-details-error" role="status">
          {device.error.message}
        </p>
      )}
      <section className="instrument-task">
        <h3>{device.stale ? '最后已知任务' : '当前任务'}</h3>
        {device.task ? (
          <>
            <div className="instrument-task-summary">
              <span>批次：{device.task.batchId}</span>
              <span>厂家状态：{device.task.state}</span>
            </div>
            {compact && !!device.task.experiments?.length && (
              <p>
                {device.task.experiments.length} 个实验 · 分析口{' '}
                {device.task.experiments
                  .slice(0, 4)
                  .map((experiment) => experiment.analysisPort ?? '未提供')
                  .join('、')}
                {device.task.experiments.length > 4 ? '…' : ''}
              </p>
            )}
            {!compact && !!device.task.experiments?.length && (
              <div className="instrument-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>实验</th>
                      <th>分析口</th>
                      <th>厂家状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {device.task.experiments.map((experiment) => (
                      <tr key={experiment.experimentId}>
                        <td>{experiment.experimentId}</td>
                        <td>{experiment.analysisPort ?? '未提供'}</td>
                        <td>{experiment.state ?? '未提供'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : (
          <p>{device.taskKnown ? '最近一次成功查询未返回活动任务' : '尚未取得任务状态'}</p>
        )}
      </section>
    </>
  );
}
