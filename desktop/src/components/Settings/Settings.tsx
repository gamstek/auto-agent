import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import {
  ArrowLeft,
  BookOpen,
  Check,
  Cpu,
  Cable,
  FolderOpen,
  Info,
  LoaderCircle,
  Puzzle,
  Settings2,
  X,
} from 'lucide-react';
import {
  desktop,
  errorText,
  native,
  type Settings as Config,
  type SettingsInfo,
} from '../../bridge';
import { Maintenance } from '../Maintenance/Maintenance';
import { Button } from '../Button/Button';
import { IconButton } from '../IconButton/IconButton';
import { Input } from '../Input/Input';
import { Textarea } from '../Textarea/Textarea';
import { NavigationItem } from '../NavigationItem/NavigationItem';
import { SearchField } from '../SearchField/SearchField';
import { Switch } from '../Switch/Switch';
import { SettingsSection as Group, SettingsRow as Row } from '../SettingsSection/SettingsSection';
import './Settings.css';

const categories = [
  {
    id: 'model',
    label: '模型连接',
    description: '服务地址 API Key 模型账户',
    icon: Cpu,
    group: '工作空间',
  },
  {
    id: 'device',
    label: '仪器连接',
    description: 'Climber MCP 厂家 地址 超时 仪器',
    icon: Cable,
    group: '工作空间',
  },
  {
    id: 'skills',
    label: '技能',
    description: '技能 来源 目录 内置 脚本',
    icon: Puzzle,
    group: '工作空间',
  },
  {
    id: 'knowledge',
    label: 'LLM Wiki',
    description: '纯文本 来源 Markdown 知识 摄入',
    icon: BookOpen,
    group: '工作空间',
  },
  {
    id: 'advanced',
    label: '运行参数',
    description: 'Token 容量 角色 提示词',
    icon: Settings2,
    group: '应用',
  },
  {
    id: 'about',
    label: '关于与诊断',
    description: '版本 更新 日志 诊断 导出 数据存储',
    icon: Info,
    group: '应用',
  },
];
export function SettingsNavigation({
  selected,
  onSelect,
  onBack,
}: {
  selected: string;
  onSelect: (id: string, animate: boolean) => void;
  onBack: (animate: boolean) => void;
}) {
  const [query, setQuery] = useState('');
  const visible = categories.filter((category) =>
    `${category.label} ${category.description}`.toLowerCase().includes(query.toLowerCase().trim()),
  );
  return (
    <div className="settings-sidebar-content">
      <header className="settings-sidebar-heading">
        <strong>设置</strong>
        <IconButton label="返回聊天" title="返回聊天" onClick={(event) => onBack(event.detail > 0)}>
          <ArrowLeft size={17} />
        </IconButton>
      </header>
      <SearchField label="搜索设置" value={query} onChange={setQuery} />
      <nav className="settings-menu" aria-label="设置分类">
        {['工作空间', '应用'].map((group) => {
          const items = visible.filter((category) => category.group === group);
          return (
            items.length > 0 && (
              <section key={group}>
                <h2>{group}</h2>
                {items.map(({ id, label, icon: Icon }) => (
                  <NavigationItem
                    key={id}
                    selected={selected === id}
                    label={label}
                    icon={<Icon size={16} />}
                    onClick={(event) => onSelect(id, event.detail > 0)}
                  />
                ))}
              </section>
            )
          );
        })}
        {!visible.length && <p className="settings-no-results">没有匹配的设置</p>}
      </nav>
    </div>
  );
}
export function Settings({
  initialTab = 'model',
  onSaved,
  active,
  instant,
}: {
  initialTab?: string;
  onSaved: (applied: boolean) => void;
  active: boolean;
  instant?: boolean;
}) {
  const [info, setInfo] = useState<SettingsInfo>();
  const [draft, setDraft] = useState<Config>();
  const [key, setKey] = useState('');
  const [editingKey, setEditingKey] = useState(false);
  const keyConfigured = !!info?.hasApiKey && !editingKey;
  const [saving, setSaving] = useState(false),
    [pendingApply, setPendingApply] = useState(false),
    [error, setError] = useState('');
  const inFlight = useRef(false),
    revision = useRef(0),
    delay = useRef(700),
    lastAttempt = useRef('');
  const [saveEpoch, setSaveEpoch] = useState(0);
  const content = useRef<HTMLDivElement>(null),
    animation = useRef<Animation | null>(null),
    previousTab = useRef(initialTab);
  function reload() {
    native<SettingsInfo>('settings_read')
      .then((value) => {
        setInfo(value);
        setDraft(value.settings);
        setPendingApply(value.pendingApply ?? false);
        setError('');
        lastAttempt.current = '';
        setKey('');
        setEditingKey(false);
      })
      .catch((e) => setError(errorText(e)));
  }
  useEffect(() => {
    if (!inFlight.current && (!info || (active && !changed))) reload();
  }, [active]);
  const changed = !!draft && (JSON.stringify(draft) !== JSON.stringify(info?.settings) || !!key);
  useEffect(() => {
    if (!changed || !draft) return;
    const fingerprint = JSON.stringify({ draft, key });
    if (lastAttempt.current === fingerprint) return;
    const timer = setTimeout(() => {
      if (inFlight.current) return;
      lastAttempt.current = fingerprint;
      void save();
    }, delay.current);
    return () => clearTimeout(timer);
  }, [draft, key, info, saveEpoch]);
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ applied: boolean; error?: string }>('settings-applied', ({ payload }) => {
      setPendingApply(false);
      if (payload.error) setError(payload.error);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  useLayoutEffect(() => {
    animation.current?.cancel();
    if (previousTab.current !== initialTab) {
      content.current?.scrollTo({ top: 0 });
      if (!instant && !matchMedia('(prefers-reduced-motion: reduce)').matches)
        animation.current =
          content.current?.animate(
            [
              { opacity: 0.65, transform: 'translateY(4px)' },
              { opacity: 1, transform: 'translateY(0)' },
            ],
            { duration: 160, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' },
          ) ?? null;
    }
    previousTab.current = initialTab;
    return () => animation.current?.cancel();
  }, [initialTab]);
  function update<K extends keyof Config>(name: K, value: Config[K]) {
    revision.current++;
    delay.current = typeof value === 'boolean' || name === 'llmWiki' ? 0 : 700;
    setDraft((valueBefore) => valueBefore && { ...valueBefore, [name]: value });
    setError('');
  }
  async function pickText(kind: 'file' | 'directory') {
    try {
      const path = await open(
        kind === 'directory'
          ? { directory: true, multiple: false, title: '选择 Markdown / TXT 来源目录' }
          : {
              directory: false,
              multiple: false,
              title: '选择纯文本文件',
              filters: [{ name: 'Markdown / TXT', extensions: ['md', 'markdown', 'txt'] }],
            },
      );
      if (
        typeof path === 'string' &&
        draft &&
        !draft.llmWiki.sources.some((entry) => entry.path === path)
      ) {
        const id = `text-${crypto.randomUUID()}`;
        update('llmWiki', {
          sources: [
            ...draft.llmWiki.sources,
            {
              id,
              type: kind,
              path,
            },
          ],
        });
      }
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function save() {
    if (!draft || inFlight.current) return;
    inFlight.current = true;
    const savedRevision = revision.current;
    setSaving(true);
    setError('');
    try {
      const result = await native<{
        saved: boolean;
        applied?: boolean;
        configRevision: string;
        error?: string;
      }>('settings_save', {
        settings: draft,
        configRevision: info?.configRevision,
        apiKey: key.trim() || null,
        clearKey: false,
      });
      setInfo(
        (previous) =>
          previous && {
            ...previous,
            settings: draft,
            configRevision: result.configRevision,
            hasApiKey: key.trim() ? true : previous.hasApiKey,
          },
      );
      if (revision.current === savedRevision) {
        setKey('');
        setEditingKey(false);
      }
      setPendingApply(result.applied === false);
      if (result.error) setError(`配置已保存，应用失败：${result.error}`);
      onSaved(result.applied !== false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
      inFlight.current = false;
      setSaveEpoch((value) => value + 1);
    }
  }
  const text = (label: string, name: keyof Config, description: string, placeholder?: string) => (
    <Row
      id={name}
      label={label}
      description={description}
      control={
        <Input
          id={name}
          aria-describedby={`${name}-help`}
          value={String(draft?.[name] ?? '')}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(event) => update(name, event.target.value)}
        />
      }
    />
  );
  const numeric = (
    label: string,
    name: keyof Config,
    min: number,
    max: number,
    description: string,
  ) => (
    <Row
      id={name}
      label={label}
      description={description}
      control={
        <Input
          id={name}
          className="setting-number"
          aria-describedby={`${name}-help`}
          type="number"
          min={min}
          max={max}
          required
          value={Number(draft?.[name] ?? 0)}
          onChange={(event) => update(name, Number(event.target.value))}
        />
      }
    />
  );
  const paths = () => (
    <>
      <Row
        label="纯文本来源"
        description="添加文件或目录；目录内只导入 UTF-8 Markdown/TXT。"
        control={
          <div className="maintenance-actions">
            <Button variant="subtle" onClick={() => void pickText('file')}>
              添加文件
            </Button>
            <Button variant="subtle" onClick={() => void pickText('directory')}>
              <FolderOpen size={15} />
              添加目录
            </Button>
          </div>
        }
      />
      {!!draft?.llmWiki.sources.length && (
        <div className="setting-paths">
          {draft.llmWiki.sources.map((entry) => (
            <div key={entry.id}>
              <code title={entry.path}>{entry.path}</code>
              <IconButton
                label={`移除 ${entry.path}`}
                onClick={() =>
                  update('llmWiki', {
                    sources: draft.llmWiki.sources.filter((value) => value.id !== entry.id),
                  })
                }
              >
                <X size={14} />
              </IconButton>
            </div>
          ))}
        </div>
      )}
    </>
  );
  return (
    <form
      className="settings-page settings-form"
      hidden={!active}
      onBlur={() => {
        delay.current = 0;
        setSaveEpoch((value) => value + 1);
      }}
      onSubmit={(event) => {
        event.preventDefault();
      }}
    >
      <div className="settings-scroll" ref={content}>
        <div className="settings-body">
          {error && (
            <div className="error-banner" role="alert">
              {error}
              <Button variant="subtle" disabled={saving} onClick={reload}>
                重新读取配置
              </Button>
            </div>
          )}
          {!draft ? (
            <div className="empty-state">{error ? '设置暂不可用' : '正在读取设置…'}</div>
          ) : (
            <>
              <h1 className="settings-page-title">
                {categories.find((category) => category.id === initialTab)?.label}
                {saving && (
                  <LoaderCircle
                    className="spin autosave-indicator"
                    size={14}
                    aria-label="自动保存中"
                  />
                )}
                {pendingApply && <small className="pending-apply">已保存，任务结束后生效</small>}
              </h1>
              {initialTab === 'model' && (
                <>
                  <Group title="连接服务">
                    {text(
                      '服务地址',
                      'baseURL',
                      '兼容 OpenAI 的接口基址。',
                      'https://api.deepseek.com',
                    )}
                    {text('模型名称', 'model', '使用服务商提供的模型标识。', 'deepseek-flash')}
                    <Row
                      id="modelKey"
                      label="API Key"
                      description={
                        info?.apiKeySource === 'environment'
                          ? '已配置 · 来自 AUTO_AGENT_API_KEY 环境变量，与 CLI 一致。'
                          : info?.hasApiKey
                            ? '已配置。留空保留现有 Key。'
                            : '仅保存在系统凭据库，不写入配置文件。'
                      }
                      control={
                        <Input
                          id="modelKey"
                          type="password"
                          autoComplete="new-password"
                          spellCheck={false}
                          value={keyConfigured ? '••••••••••••' : key}
                          readOnly={info?.apiKeySource === 'environment'}
                          aria-describedby="modelKey-help"
                          placeholder={info?.hasApiKey ? '输入新的 API Key' : '输入你的 API Key'}
                          onFocus={() => {
                            if (info?.apiKeySource !== 'environment') setEditingKey(true);
                          }}
                          onBlur={() => {
                            if (!key) setEditingKey(false);
                          }}
                          onChange={(event) => {
                            revision.current++;
                            delay.current = 700;
                            setKey(event.target.value);
                          }}
                        />
                      }
                    />
                  </Group>
                </>
              )}
              {initialTab === 'skills' && (
                <>
                  <Group title="技能管理">
                    <Row
                      label="技能发现"
                      description="由 Corax 加载随应用发布的 skills，按需读取技能内容与资源。"
                      control={<span className="setting-value">Corax 原生技能</span>}
                    />
                  </Group>
                  <p className="settings-section-note">
                    技能定义操作方法，实际执行能力由当前工具提供。技能目录和工具模块属于应用版本，在构建时发布。
                  </p>
                </>
              )}
              {initialTab === 'device' && (
                <>
                  <Group title="Climber MCP">
                    <Row
                      id="climberEnabled"
                      label="启用设备连接"
                      description="通过内置 MCP 服务查询仪器、登记批次和启动。SAM 文件能力独立可用。"
                      control={
                        <Switch
                          id="climberEnabled"
                          checked={draft.climber.enabled}
                          disabled={!draft.climber.serviceURL && !draft.climber.enabled}
                          onChange={(event) =>
                            update('climber', { ...draft.climber, enabled: event.target.checked })
                          }
                        />
                      }
                    />
                    <Row
                      id="climberServiceURL"
                      label="厂家接口地址"
                      description="厂家主机的 HTTP(S) /api/v1 地址；先填写地址，再启用连接。"
                      control={
                        <Input
                          id="climberServiceURL"
                          value={draft.climber.serviceURL}
                          spellCheck={false}
                          placeholder="http://厂家主机:端口/api/v1"
                          onChange={(event) =>
                            update('climber', { ...draft.climber, serviceURL: event.target.value })
                          }
                        />
                      }
                    />
                    <Row
                      id="climberTimeoutMs"
                      label="厂家请求超时"
                      description="单位为毫秒，范围100–60000；写入超时不代表设备没有执行。"
                      control={
                        <Input
                          id="climberTimeoutMs"
                          className="setting-number"
                          type="number"
                          min={100}
                          max={60000}
                          value={draft.climber.timeoutMs}
                          onChange={(event) =>
                            update('climber', {
                              ...draft.climber,
                              timeoutMs: Number(event.target.value),
                            })
                          }
                        />
                      }
                    />
                  </Group>
                  <p className="settings-section-note">
                    连接设置保存后在空闲时应用，不会自动登记或启动设备。SAM
                    路径必须由厂家主机实际可读；跨机生成需要部署映射。
                  </p>
                </>
              )}
              {initialTab === 'knowledge' && (
                <>
                  <Group title="LLM Wiki 来源">{paths()}</Group>
                  <p className="settings-section-note">
                    添加来源只保存配置。明确要求助手摄入这些来源，或运行 pnpm llm-wiki
                    ingest，才会调用模型分析并生成持久 Markdown 知识页。普通问答只查询已整理的知识。
                  </p>
                  <Group title="内置仪器资料">
                    <Row
                      label="device-automation"
                      description="人工规则属于技能指导，历史参考由 Wiki 只读集合提供；不进入用户摄入流程。"
                      control={<span className="setting-value">只读内置资料</span>}
                    />
                  </Group>
                </>
              )}
              {initialTab === 'advanced' && (
                <>
                  <Group title="请求与容量">
                    {numeric(
                      '输入 Token 容量',
                      'maxInputTokens',
                      1,
                      10000000,
                      '按当前模型实际支持的容量填写。',
                    )}
                    {numeric(
                      '输出 Token 容量',
                      'maxOutputTokens',
                      1,
                      1000000,
                      '每次模型响应的输出上限。',
                    )}
                  </Group>
                  <Group title="个性化">
                    <Row
                      id="systemPrompt"
                      label="自定义角色提示词"
                      description="留空使用内置角色。工具和技能约束仍然有效。"
                      wide
                      control={
                        <Textarea
                          id="systemPrompt"
                          rows={5}
                          value={draft.systemPrompt}
                          onChange={(event) => update('systemPrompt', event.target.value)}
                          placeholder="留空跟随内置角色"
                        />
                      }
                    />
                  </Group>
                </>
              )}
              {initialTab === 'about' && (
                <>
                  <Group title="应用信息">
                    <Row
                      label="Auto-Agent"
                      description="量仔 · AI 助理"
                      control={<span className="setting-value">v{info?.version}</span>}
                    />
                    <Row
                      label="桌面架构"
                      control={<span className="setting-value">Tauri 2 · 本地 Agent</span>}
                    />
                  </Group>
                  <Maintenance />
                  <Group title="数据与诊断">
                    <Row
                      label="共享配置"
                      description="与 CLI 直接读写同一份 config.json。外部修改在重启后生效。"
                      control={
                        <code className="directory-value selectable" title={info?.configPath}>
                          {info?.configPath}
                        </code>
                      }
                    />
                    <Row
                      label="数据目录"
                      description="会话、执行审计和知识快照存储在本机。"
                      control={
                        <code className="directory-value selectable" title={info?.dataDirectory}>
                          {info?.dataDirectory}
                        </code>
                      }
                    />
                    <Row
                      label="诊断日志"
                      description="Corax 运行日志"
                      control={
                        <Button
                          variant="subtle"
                          onClick={() =>
                            native('open_logs').catch((error) => setError(errorText(error)))
                          }
                        >
                          打开日志目录
                        </Button>
                      }
                    />
                  </Group>
                  <p className="settings-section-note">
                    执行结果未知时，请在对应会话中核对厂家任务并记录处理结论。取消回复不代表仪器停止。
                  </p>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </form>
  );
}
