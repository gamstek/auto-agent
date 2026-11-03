import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { native, errorText, desktop } from '../../bridge';
import { Button } from '../Button/Button';
import { SettingsSection, SettingsRow } from '../SettingsSection/SettingsSection';
import './Maintenance.css';

type Update = { channel: string; version: string | null; notes: string | null };
export function Maintenance() {
  const [update, setUpdate] = useState<Update>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (!desktop) return;
    const subscription = listen<{ downloaded: number; total: number | null }>(
      'update-progress',
      ({ payload }) => {
        setMessage(
          payload.total
            ? `正在下载 ${Math.min(100, Math.round((payload.downloaded / payload.total) * 100))}%`
            : `已下载 ${(payload.downloaded / 1048576).toFixed(1)} MB`,
        );
      },
    );
    return () => {
      void subscription.then((off) => off()).catch(() => {});
    };
  }, []);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await action();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="maintenance-panel">
      <SettingsSection title="更新与诊断">
        <SettingsRow
          label="软件更新"
          description="预览版使用 Beta 渠道，正式版使用稳定渠道。安装前校验签名；任务执行期间不能安装。"
          control={
            <div className="maintenance-actions">
              <Button
                variant="subtle"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    setUpdate(undefined);
                    const result = await native<Update>('update_check');
                    setUpdate(result);
                    setMessage(
                      result.version
                        ? `发现新版本 ${result.version} · ${result.channel}`
                        : `当前已是最新版本 · ${result.channel}`,
                    );
                  })
                }
              >
                检查更新
              </Button>
              {update?.version && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      setMessage('正在下载并校验更新…');
                      await native('update_install');
                      setMessage('正在启动安装程序…');
                    })
                  }
                >
                  下载并安装 {update.version}
                </Button>
              )}
            </div>
          }
        />
        {update?.notes && (
          <div className="maintenance-release-notes">
            <h3>版本说明</h3>
            <p>{update.notes}</p>
          </div>
        )}
        <SettingsRow
          label="诊断包"
          description="仅包含版本、运行配置数值和日志元数据，不包含密钥、路径、聊天正文或脚本输出。"
          control={
            <Button
              variant="subtle"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const saved = await native<boolean>('export_diagnostics');
                  setMessage(saved ? '诊断包已导出' : '已取消导出');
                })
              }
            >
              导出诊断包
            </Button>
          }
        />
        <p className="maintenance-status" role="status" aria-live="polite">
          {message}
        </p>
      </SettingsSection>
    </div>
  );
}
