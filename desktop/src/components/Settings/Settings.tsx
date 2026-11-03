import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import {
  ArrowLeft,
  BookOpen,
  Check,
  Cpu,
  FolderOpen,
  Info,
  LoaderCircle,
  Settings2,
  SlidersHorizontal,
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
    label: '设备连接',
    description: 'Climber 模板 输出目录 超时',
    icon: SlidersHorizontal,
    group: '工作空间',
  },
  {
    id: 'resources',
    label: '技能与知识库',
    description: '来源 目录 Wiki 内置 技能',
    icon: BookOpen,
    group: '工作空间',
  },
  {
    id: 'advanced',
    label: '运行参数',
    description: '高级 Token 步数 网络 提示词 超时',
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
    delay.current =
      typeof value === 'boolean' || Array.isArray(value) || name === 'templateDirectory' ? 0 : 700;
    setDraft((valueBefore) => valueBefore && { ...valueBefore, [name]: value });
    setError('');
  }
  async function pick(name: 'templateDirectory' | 'skillRoots' | 'wikiRoots' | 'wikiIndexRoots') {
    try {
      const path = await open({ directory: true, multiple: false, title: '选择目录' });
      if (typeof path === 'string')
        update(
          name,
          name === 'templateDirectory' ? path : [...new Set([...(draft![name] as string[]), path])],
        );
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
  const toggle = (
    label: string,
    name: 'builtinSkills' | 'builtinWiki' | 'webAllowPrivateAddresses',
    description: string,
  ) => (
    <Row
      id={name}
      label={label}
      description={description}
      control={
        <Switch
          id={name}
          checked={draft?.[name] ?? false}
          onChange={(event) => update(name, event.target.checked)}
        />
      }
    />
  );
  const paths = (
    label: string,
    name: 'skillRoots' | 'wikiRoots' | 'wikiIndexRoots',
    description: string,
  ) => (
    <>
      <Row
        label={label}
        description={description}
        control={
          <Button variant="subtle" onClick={() => void pick(name)}>
            <FolderOpen size={15} />
            添加目录
          </Button>
        }
      />
      {!!draft?.[name].length && (
        <div className="setting-paths">
          {draft[name].map((path) => (
            <div key={path}>
              <code title={path}>{path}</code>
              <IconButton
                label={`移除 ${path}`}
                onClick={() =>
                  update(
                    name,
                    draft[name].filter((value) => value !== path),
                  )
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
              {initialTab === 'device' && (
                <>
                  <Group title="Climber 厂家接口">
                    {text(
                      '厂家 API 地址',
                      'manufacturerUrl',
                      '同机使用默认地址，异机填写厂家 PC 地址。保留 /api/v1。',
                    )}
                    {numeric(
                      '请求超时',
                      'manufacturerTimeoutMs',
                      100,
                      120000,
                      '单位：毫秒。不是仪器实验时长。',
                    )}
                  </Group>
                  <Group title="文件位置">
                    <Row
                      label="模板输出目录"
                      description="新建模板的默认保存位置。异机登记使用厂家可读的盘符文件路径。"
                      control={
                        <div className="directory-control">
                          <code title={draft.templateDirectory}>
                            {draft.templateDirectory || '默认用户目录'}
                          </code>
                          <Button variant="subtle" onClick={() => void pick('templateDirectory')}>
                            更改
                          </Button>
                          {draft.templateDirectory && (
                            <IconButton
                              label="恢复默认模板目录"
                              title="恢复默认目录"
                              onClick={() => update('templateDirectory', '')}
                            >
                              <X size={14} />
                            </IconButton>
                          )}
                        </div>
                      }
                    />
                  </Group>
                </>
              )}
              {initialTab === 'resources' && (
                <>
                  <Group title="内置资源">
                    {toggle('内置技能', 'builtinSkills', '加载随应用提供的设备自动化技能。')}
                    {toggle('内置知识库', 'builtinWiki', '使用推荐知识与历史模板参考。')}
                  </Group>
                  <Group title="外部来源">
                    {paths('技能目录', 'skillRoots', '仅添加可信目录，脚本具有当前用户权限。')}
                    {paths('知识来源', 'wikiRoots', 'Markdown / TXT 内容，需要显式编译。')}
                    {paths('模板参考目录', 'wikiIndexRoots', 'SAM / SMP 案例，需要显式建立索引。')}
                  </Group>
                  <p className="settings-section-note">
                    添加目录不会自动扫描或调用模型。外部知识与案例索引由显式更新命令维护。
                  </p>
                </>
              )}
              {initialTab === 'advanced' && (
                <>
                  <Group title="请求与容量">
                    {numeric('最大步骤数', 'maxSteps', 1, 100, '一次请求允许的模型步骤上限。')}
                    {numeric(
                      '模型请求超时',
                      'modelTimeoutMs',
                      1000,
                      600000,
                      '每次模型请求的等待上限，单位毫秒。',
                    )}
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
                    {numeric(
                      '脚本超时',
                      'scriptTimeoutMs',
                      1000,
                      600000,
                      '单位毫秒。启动后中断可能进入待对账状态。',
                    )}
                  </Group>
                  <Group title="网络">
                    {toggle(
                      '允许网页工具访问内网',
                      'webAllowPrivateAddresses',
                      '允许访问本机、内网及保留地址，适用于可信部署。',
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
                      description="agent.jsonl / skills.jsonl"
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
