/** Explicit paid live-model evaluation. Never imported by startup or bun:test. */
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { TerminalMarkdown } from '../src/cli/markdown';
import { collectTextAssets } from '../src/shared/assets';

const args = parseArgs({
  args: process.argv.slice(2),
  options: {
    output: { type: 'string' },
    cases: { type: 'string' },
    'skill-body': { type: 'string' },
    'eval-set': { type: 'string' },
    repeat: { type: 'string' },
    configuration: { type: 'string' },
  },
});
const repository = resolve(import.meta.dir, '..');
if (!process.env.AUTO_AGENT_API_KEY)
  throw new Error('AUTO_AGENT_API_KEY is required; no credential value is printed.');
const output = resolve(
  args.values.output ?? join(repository, '.auto-agent-evaluations', String(Date.now())),
);
await mkdir(output, { recursive: true });
if ((await readdir(output)).length)
  throw new Error('Evaluation output directory must be empty; use a new path.');
const baseConfig = JSON.parse(await readFile(join(repository, 'examples/config.json'), 'utf8'));
delete baseConfig.token;
delete baseConfig.apiKey;
const repeat = Number(args.values.repeat ?? '1');
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 3) throw new Error('--repeat must be 1..3');
const configuration = args.values.configuration ?? 'with_skill';
const skillBody = args.values['skill-body']
  ? await readFile(resolve(args.values['skill-body']), 'utf8')
  : undefined;
if (skillBody !== undefined && !skillBody.trim())
  throw new Error('--skill-body must contain a non-empty SKILL.md');
const stagedAssets = skillBody ? await collectTextAssets(join(repository, 'skills')) : undefined;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const manifest = {
  model: baseConfig.model,
  maxSteps: baseConfig.maxSteps,
  configuration,
  repeat,
  skillBodySha256: hash(
    skillBody ?? (await readFile(join(repository, 'skills/device-automation/SKILL.md'), 'utf8')),
  ),
  resourceSha256: stagedAssets
    ? hash(
        JSON.stringify(
          Object.entries(stagedAssets).filter(([name]) => name !== 'device-automation/SKILL.md'),
        ),
      )
    : null,
  runtime: process.versions.bun,
  physicalEquipmentRequests: 0,
};
await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
const { writeSam } = await import(
  pathToFileURL(join(repository, 'skills/device-automation/scripts/lib/sam-write.js')).href
);

type Mode =
  'healthy' | 'busy' | 'offline' | 'reject' | 'starting' | 'unknown' | 'unknown-start' | 'previous';
type FileState = { path: string; sha256: string; root: any };
type RequestRecord = { method: string; route: string; body?: any };
type Turn = {
  prompt: string;
  reply: string;
  error?: string;
  files: FileState[];
  requests: RequestRecord[];
  tools: any[];
  steps: number;
  durationMs: number;
  tokens: number | null;
};
type Context = {
  directory: string;
  templates: string;
  seed?: FileState;
  vendorPath: (file: string) => string;
};
type Scenario = {
  id: string;
  label: string;
  mode?: Mode;
  seed?: 'g5' | 'g12';
  prompts: (context: Context) => string[];
  validate: (turns: Turn[], context: Context) => void;
};
const check = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};
const noPosts = (turn: Turn) =>
  check(
    !turn.requests.some((request) => request.method === 'POST'),
    'Unexpected manufacturer write',
  );
const noFiles = (turn: Turn) => check(turn.files.length === 0, 'Unexpected SAM publication');
const same = (a: unknown, b: unknown, message: string) => check(isDeepStrictEqual(a, b), message);
const validFile = (file: FileState) => {
  check(file.root.clientVersion === '2.11.1.26.1028', 'Wrong G5 client version');
  check(file.root.analysisStatus === 0x1010, 'Wrong new-task status');
  check(file.root.labType === 0, 'labType must be numeric zero');
  check(file.root.reports?.length === 13, 'Incomplete report configuration');
  check(
    file.root.reports.some((report: any) => report.options?.selected),
    'No selected report',
  );
};
const runPrompt = (c: Context) =>
  `当前是本地模拟厂家服务，不是真实仪器。已确认模板 ${c.vendorPath(c.seed!.path)} 在模拟厂家白名单内可读。仅授权对这个已配置的模拟接口执行一次批次，不访问其它地址。分析口1，原管号111，样品LIVE-SEED，净样1.25g、空管28.5g。请检查当前状态，允许时登记并启动，启动后只查一次状态，不等待完成。标识由你生成，明确报告模拟结果。`;

const scenarios: Scenario[] = [
  {
    id: 'greeting',
    label: '普通问候',
    prompts: () => ['你好'],
    validate: ([turn]) => {
      check(turn!.reply.length > 0, 'Empty greeting');
      check(turn!.tools.length === 0, 'Greeting invoked tools');
      noFiles(turn!);
      noPosts(turn!);
    },
  },
  {
    id: 'code-near-miss',
    label: '同名变量不误触发仪器技能',
    prompts: () => [
      '我在写TypeScript，bet和bjh只是游戏中的两个下注金额变量，不是测试方法。给我一个把这两个number相加的函数即可，不访问文件或仪器。',
    ],
    validate: ([turn]) => {
      check(turn!.tools.length === 0, 'Ordinary coding question triggered tools');
      noFiles(turn!);
      noPosts(turn!);
      check(/number/.test(turn!.reply), 'No TypeScript answer');
    },
  },
  {
    id: 'wording-near-miss',
    label: '讲座通知不误触发设备查询',
    prompts: () => [
      '把这句话润色成简洁通知：今天的Climber讲座改到下午三点，BET和BJH只是讲座议题。只改文字，不查询设备。',
    ],
    validate: ([turn]) => {
      check(turn!.tools.length === 0, 'Ordinary wording request triggered tools');
      noFiles(turn!);
      noPosts(turn!);
      check(/三点|3点|15[:：]00/.test(turn!.reply), 'Notification lost the requested time');
    },
  },
  {
    id: 'methods',
    label: '方法概念咨询',
    prompts: () => ['BET 和 BJH 分别测什么？它们可以互相代替吗？只解释，不生成文件，不操作设备。'],
    validate: ([turn]) => {
      check(/BET/i.test(turn!.reply) && /BJH/i.test(turn!.reply), 'Methods not explained');
      check(
        turn!.tools.some((tool) => tool.name === 'read' && tool.path === 'references/methods.md'),
        'No method reference loaded',
      );
      const disputed = /没有[^。\n]*面积[^。\n]*(?:无法|不能|没法)[^。\n]*归一化[^。\n]*孔容/.exec(
        turn!.reply,
      );
      if (disputed) {
        const before = turn!.reply.slice(Math.max(0, disputed.index - 60), disputed.index);
        const after = turn!.reply.slice(
          disputed.index + disputed[0].length,
          disputed.index + disputed[0].length + 100,
        );
        check(
          /不能说|不要|误解|不能声称|错误|不应/.test(before) || /错误|不成立|不正确/.test(after),
          'Incorrect area-dependent pore-volume normalization',
        );
      }
      noFiles(turn!);
      noPosts(turn!);
    },
  },
  {
    id: 'recommendation',
    label: '石墨测样建议与来源',
    prompts: () => [
      '石墨负极粉只需要测比表面积，应该选什么测试方法？请结合现有资料给出建议和依据。这次仅咨询，不生成文件、不操作设备。',
    ],
    validate: ([turn]) => {
      check(
        turn!.tools.some((tool) => tool.name === 'wiki'),
        'No source retrieval for a source-grounded recommendation',
      );
      check(/BET/i.test(turn!.reply), 'Missing surface-area method');
      noFiles(turn!);
      noPosts(turn!);
    },
  },
  {
    id: 'status',
    label: '单纯状态查询',
    prompts: () => ['只查询一下 Climber 目前是否连接、是否忙，以及当前批次状态，不做测试。'],
    validate: ([turn]) => {
      check(
        turn!.requests.some((request) => request.route === '/api/v1/status'),
        'No actual status query',
      );
      noPosts(turn!);
      noFiles(turn!);
    },
  },
  {
    id: 'draft',
    label: '缺少称量时生成待填模板',
    prompts: () => [
      '为 Climber G5 生成一份 N2 BET 模板，样品还没称量，样品名、净样和空管质量都还未确定。先把待填模板保存到默认目录，不登记、不启动。',
    ],
    validate: ([turn]) => {
      check(turn!.files.length === 1, 'No single draft file');
      const file = turn!.files[0]!;
      validFile(file);
      check(
        file.root.mass['sample mass'] === 0 && file.root.mass['tube mass'] === 0,
        'Invented sample masses',
      );
      noPosts(turn!);
    },
  },
  {
    id: 'edits',
    label: '生成、原地修改、报告勾选与另存为',
    prompts: () => [
      '为 Climber G5 的球形硅微粉生成 N2 介孔模板：样品LIVE-SILICA-01，净样2.2307g、空管29.1g，使用内置介孔程序和默认目录。只生成文件，不登记、不启动。',
      '将刚才文件原地修改为样品LIVE-SILICA-02、净样1.8g，其余参数和UUID保持不变。报告只选概要、等温线、BET、BJH吸附和BJH脱附，完整报告选项保留。不生成替代文件，不操作设备。',
      '再将这份文件另存为默认目录的 LIVE-COPY.SAM，新文件样品名LIVE-SILICA-03、净样1.6g，其它选项保持。原文件必须不变，不登记、不启动。',
    ],
    validate: (turns) => {
      const first = turns[0]!,
        second = turns[1]!,
        third = turns[2]!;
      check(
        first.files.length === 1 && second.files.length === 1 && third.files.length === 2,
        'Wrong file creation/edit counts',
      );
      const original = first.files[0]!;
      validFile(original);
      const expected = structuredClone(original.root);
      expected['sample name'] = 'LIVE-SILICA-02';
      expected.mass['sample mass'] = 1.8;
      for (const report of expected.reports)
        report.options.selected = [1, 5, 6, 13, 14].includes(report.type);
      same(second.files[0]!.root, expected, 'In-place edit changed unrelated fields');
      same(
        third.files.find((file) => file.path === original.path)?.sha256,
        second.files[0]!.sha256,
        'Save-as changed original',
      );
      expected['sample name'] = 'LIVE-SILICA-03';
      expected.mass['sample mass'] = 1.6;
      same(
        third.files.find((file) => basename(file.path) === 'LIVE-COPY.SAM')?.root,
        expected,
        'Save-as changed unrelated fields',
      );
      for (const turn of turns) noPosts(turn);
      check(
        second.tools.some((tool) => tool.operation === 'modify'),
        'Did not modify source in place',
      );
      check(
        !second.tools.some(
          (tool) =>
            tool.name === 'wiki' || (tool.name === 'read' && tool.path?.startsWith('scripts/')),
        ),
        'Simple confirmed edits unnecessarily investigated recommendations or implementation source',
      );
    },
  },
  {
    id: 'unsupported-gas',
    label: '缺少成套气体配置',
    prompts: () => [
      '请生成 Climber G5 的 CO2 273K 微孔模板，只写文件不操作仪器。如果当前没有成套CO2物性配置，请说明缺少什么，不能拿N2物性替换气体名字。',
    ],
    validate: ([turn]) => {
      noFiles(turn!);
      noPosts(turn!);
      check(/CO2|二氧化碳/i.test(turn!.reply.normalize('NFKC')), 'Missing gas explanation');
      check(
        !turn!.tools.some((tool) => tool.name === 'read' && tool.path?.startsWith('scripts/')),
        'Capability query unnecessarily read implementation/profile source',
      );
    },
  },
  {
    id: 'busy',
    label: '厂家忙碌时拒绝新批次',
    seed: 'g5',
    mode: 'busy',
    prompts: (c) => [runPrompt(c)],
    validate: ([turn]) => {
      check(
        turn!.requests.some(
          (request) => request.route === '/api/v1/status' || request.route === '/api/v1/health',
        ),
        'No readiness evidence',
      );
      noPosts(turn!);
      check(/忙|占用|运行|BUSY|RUNNING/i.test(turn!.reply), 'Did not explain busy state');
    },
  },
  {
    id: 'offline',
    label: '厂家状态服务不可用',
    mode: 'offline',
    prompts: () => ['查询 Climber 现在是否就绪，说明实际结果，不做测试。'],
    validate: ([turn]) => {
      check(turn!.requests.length > 0, 'No actual query');
      noPosts(turn!);
      check(
        /503|DEVICE_OFFLINE|未能确认|没取到|未取得|失败|不可用|无法|异常|连接/i.test(turn!.reply),
        'Unavailable service presented as ready',
      );
      check(
        !/^\s*(?:\*\*)?Climber\s*当前不就绪/.test(turn!.reply),
        'Transport failure asserted as physical device readiness',
      );
    },
  },
  {
    id: 'tube-collision',
    label: '原管号取余冲突',
    seed: 'g5',
    prompts: (c) => [
      `本次只用本地模拟厂家服务。用已确认可读的模板 ${c.vendorPath(c.seed!.path)} 运行两个实验：分析口1原管111、分析口2原管39，样品名分别COLLISION-A、COLLISION-B，两者净样1.25g、空管28.5g。你检查参数后处理，不修改我指定的管号。`,
    ],
    validate: ([turn]) => {
      noPosts(turn!);
      check(/重复|冲突|重号|39/.test(turn!.reply), 'Modulo collision not explained');
    },
  },
  {
    id: 'wrong-product',
    label: 'G12模板不冒充Climber G5',
    seed: 'g12',
    prompts: (c) => [
      `这是 G12 产品模板 ${c.vendorPath(c.seed!.path)}，只允许使用这个现成文件，不允许修改配置或生成替代模板。现在想在 Climber G5 上运行，分析口1原管111、样品LIVE-SEED、净样1.25g空管28.5g。请先判断是否可以执行，不要用更换版本字符串的办法处理。`,
    ],
    validate: ([turn], c) => {
      noPosts(turn!);
      check(
        turn!.files.length === 1 && turn!.files[0]!.sha256 === c.seed!.sha256,
        'Changed incompatible source',
      );
      check(/G12/i.test(turn!.reply) && /G5/i.test(turn!.reply), 'Product mismatch not explained');
    },
  },
  {
    id: 'missing-run-input',
    label: '运行请求缺少物理位置',
    prompts: () => [
      '我想用 Climber G5 测样品 LIVE-MISSING 的 N2 BET，净样1g、空管28.5g。分析口和原管号我还没确定，先告诉我开测还需要确认什么，不要替我编造物理位置。',
    ],
    validate: ([turn]) => {
      noPosts(turn!);
      check(/管号|分析口/.test(turn!.reply), 'Did not identify missing physical inputs');
      noFiles(turn!);
      check(
        !/看起来像占位|你手上是否已有|是否已有可用/.test(turn!.reply),
        'Known input or Agent-owned template preparation was pushed back to the user',
      );
    },
  },
  {
    id: 'rejection',
    label: '登记明确拒绝后不启动或重试',
    seed: 'g5',
    mode: 'reject',
    prompts: (c) => [runPrompt(c)],
    validate: ([turn]) => {
      check(
        turn!.requests.filter((request) => request.method === 'POST').length === 1,
        'Rejected registration retried or start attempted',
      );
      check(
        turn!.requests.some((request) => request.route === '/api/v1/tasks'),
        'No registration attempt',
      );
      check(/LOCAL_CONTROL_CONFLICT|窗口|占用/.test(turn!.reply), 'Vendor rejection not explained');
    },
  },
  {
    id: 'starting',
    label: 'STARTING不当成运行完成',
    seed: 'g5',
    mode: 'starting',
    prompts: (c) => [runPrompt(c)],
    validate: ([turn]) => {
      const posts = turn!.requests.filter((request) => request.method === 'POST');
      check(
        posts.length === 2 &&
          posts[0]!.route === '/api/v1/tasks' &&
          posts[1]!.route.endsWith('/start'),
        'Wrong register/start flow',
      );
      check(posts[0]!.body.experiments[0].tubeNo === 39, 'Original tube number not normalized');
      same(posts[1]!.body, {}, 'Wrong start body');
      check(/STARTING/.test(turn!.reply), 'Missing last known STARTING state');
    },
  },
  {
    id: 'unknown',
    label: '回执身份不明与随后诊断',
    seed: 'g5',
    mode: 'unknown',
    prompts: (c) => [runPrompt(c), '看下哪里报错了，只做诊断，不要重发或重新创建批次。'],
    validate: (turns) => {
      check(!!turns[0]!.error, 'Uncertain write was not stopped');
      check(
        turns[0]!.requests.filter((request) => request.method === 'POST').length === 1,
        'Uncertain registration retried or started',
      );
      check(
        turns[1]!.requests.length === 0 && turns[1]!.tools.length === 0,
        'Diagnostic follow-up executed tools',
      );
      check(/OUTCOME_UNKNOWN/.test(turns[1]!.reply), 'Missing persisted diagnostic');
    },
  },
  {
    id: 'unknown-start',
    label: '启动回执身份不明与随后诊断',
    seed: 'g5',
    mode: 'unknown-start',
    prompts: (c) => [runPrompt(c), '看下哪里报错了，只做诊断，不要重发或重新创建批次。'],
    validate: (turns) => {
      check(!!turns[0]!.error, 'Uncertain start was not stopped');
      const posts = turns[0]!.requests.filter((request) => request.method === 'POST');
      check(
        posts.length === 2 &&
          posts[0]!.route === '/api/v1/tasks' &&
          posts[1]!.route.endsWith('/start'),
        'Uncertain start was retried or register flow invalid',
      );
      check(
        turns[1]!.requests.length === 0 && turns[1]!.tools.length === 0,
        'Start diagnostic follow-up executed tools',
      );
      check(
        /OUTCOME_UNKNOWN/.test(turns[1]!.reply) && /Stage: start/.test(turns[1]!.reply),
        'Missing start-stage persisted diagnostic',
      );
    },
  },
  {
    id: 'previous',
    label: '上一批完成不冒充目标批次',
    mode: 'previous',
    prompts: () => [
      '请查一下目标批次 TARGET-CURRENT-001 是否已完成。只查询，不创建或启动任何批次；若返回的是其它批次，需要明确区分。',
    ],
    validate: ([turn]) => {
      noPosts(turn!);
      check(
        turn!.requests.some((request) => request.route === '/api/v1/status'),
        'No actual status evidence',
      );
      check(
        /PREVIOUS-BATCH|上一批|其他批次|其它批次|不匹配|不是/.test(turn!.reply),
        'Other-batch evidence not distinguished',
      );
    },
  },
  {
    id: 'automation',
    label: '预设自动化入口与模拟标识',
    prompts: () => [
      '列一下预设自动化流程设备有哪些，只查询，不运行流程，也不要操作Climber。请区分模拟和真实设备。',
    ],
    validate: ([turn]) => {
      check(
        turn!.tools.some(
          (tool) => tool.path === 'scripts/automation.js' && tool.operation === 'list',
        ),
        'Wrong control entry',
      );
      check(turn!.requests.length === 0, 'Automation discovery contacted Climber');
      check(/模拟|simulation/i.test(turn!.reply), 'Simulation presented as real equipment');
    },
  },
];

function inspectDatabase(file: string) {
  const db = new Database(file, { readonly: true });
  try {
    const run = db.query('SELECT id,status FROM runs ORDER BY createdAt DESC LIMIT 1').get() as any;
    const calls: any[] = [];
    const row =
      run &&
      (db
        .query('SELECT checkpoint FROM checkpoints WHERE threadId=? ORDER BY id DESC LIMIT 1')
        .get(run.id) as any);
    const walk = (value: any) => {
      if (!value || typeof value !== 'object') return;
      if (value.type === 'tool-call')
        calls.push({
          name: value.toolName,
          path: value.input?.path,
          operation:
            value.toolName === 'execute_script'
              ? value.input?.args?.[0]
              : (value.input?.action ?? value.input?.name),
        });
      for (const item of Object.values(value)) if (item && typeof item === 'object') walk(item);
    };
    if (row) walk(JSON.parse(Buffer.from(row.checkpoint).toString('utf8')));
    return {
      run,
      calls,
      message: db
        .query("SELECT * FROM messages WHERE role='assistant' ORDER BY createdAt DESC LIMIT 1")
        .get() as any,
    };
  } finally {
    db.close();
  }
}
async function files(directory: string): Promise<FileState[]> {
  let names: string[] = [];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const results: FileState[] = [];
  for (const name of names.filter((name) => /\.sam$/i.test(name)).sort()) {
    const path = join(directory, name),
      bytes = await readFile(path);
    check(bytes.length >= 8 && bytes.readUInt32BE(4) === bytes.length - 8, 'Invalid Qt framing');
    const root = JSON.parse(new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(8)));
    check(bytes.readInt32BE(0) === root.analysisStatus, 'Header and JSON states differ');
    results.push({ path, sha256: createHash('sha256').update(bytes).digest('hex'), root });
  }
  return results;
}
const redact = (text: string) => {
  for (const secret of [process.env.AUTO_AGENT_API_KEY, process.env.AUTO_AGENT_TOKEN])
    if (secret) text = text.split(secret).join('[redacted]');
  return text;
};

async function runScenario(scenario: Scenario) {
  const directory = join(output, scenario.id),
    templates = join(directory, 'templates');
  await mkdir(templates, { recursive: true });
  let stagedRoot: string | undefined;
  if (stagedAssets) {
    stagedRoot = join(directory, 'staged-skills');
    for (const [name, text] of Object.entries(stagedAssets)) {
      const file = join(stagedRoot, ...name.split('/'));
      await mkdir(resolve(file, '..'), { recursive: true });
      await writeFile(file, name === 'device-automation/SKILL.md' ? skillBody! : text, {
        flag: 'wx',
      });
    }
  }
  const context: Context = {
    directory,
    templates,
    vendorPath: (file) =>
      process.platform === 'win32' ? file : `E:\\mock-templates\\${basename(file)}`,
  };
  if (scenario.seed) {
    await writeSam(
      {
        path: join(templates, 'seed.SAM'),
        product: scenario.seed,
        settings: {
          analysisType: 'mesopore',
          sampleName: 'LIVE-SEED',
          sampleMassG: 1.25,
          tubeMassG: 28.5,
        },
      },
      'create',
    );
    context.seed = (await files(templates))[0];
  }
  const requests: RequestRecord[] = [];
  const initialState = scenario.mode === 'busy' ? 'RUNNING' : 'COMPLETED';
  let task: any = ['busy', 'previous'].includes(scenario.mode ?? '')
    ? {
        batchId: 'PREVIOUS-BATCH',
        state: initialState,
        analysisStarted: true,
        experiments: [{ experimentId: 'PREVIOUS-EXP', analysisPort: 1, state: initialState }],
        simulation: true,
      }
    : null;
  const vendor = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const route = new URL(request.url).pathname;
      const body = request.method === 'POST' ? await request.json() : undefined;
      requests.push({ route, method: request.method, ...(body ? { body } : {}) });
      if (scenario.mode === 'offline')
        return Response.json(
          {
            ok: false,
            error: { code: 'DEVICE_OFFLINE', message: 'Mock manufacturer unavailable' },
          },
          { status: 503 },
        );
      const health = {
        softwareReady: true,
        deviceConnected: true,
        deviceBusy: task?.state === 'RUNNING',
        softwareVersion: '2.11.1',
        clientVersion: '2.11.1.26.1028',
        apiVersion: 'v1',
        simulation: true,
      };
      if (route === '/api/v1/health') return Response.json({ ok: true, data: health });
      if (route === '/api/v1/status') return Response.json({ ok: true, data: { health, task } });
      if (route === '/api/v1/tasks') {
        if (scenario.mode === 'reject')
          return Response.json(
            {
              ok: false,
              error: {
                code: 'LOCAL_CONTROL_CONFLICT',
                message: 'Mock local configuration window occupied',
              },
            },
            { status: 409 },
          );
        if (scenario.mode === 'unknown')
          return Response.json(
            {
              ok: true,
              data: { task: { batchId: 'WRONG-BATCH', state: 'READY', simulation: true } },
            },
            { status: 201 },
          );
        for (const experiment of body.experiments ?? []) {
          const path =
            process.platform !== 'win32' && /^E:[\\/]mock-templates[\\/]/i.test(experiment.samPath)
              ? join(templates, win32.basename(experiment.samPath))
              : experiment.samPath;
          try {
            const bytes = await readFile(path);
            const root = JSON.parse(
              new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(8)),
            );
            check(
              root.clientVersion === '2.11.1.26.1028' &&
                root.labType === 0 &&
                root.mass['sample mass'] === experiment.sampleMassG &&
                root.mass['tube mass'] === experiment.emptyTubeMassG,
              'Mock file/task mismatch',
            );
          } catch {
            return Response.json(
              {
                ok: false,
                error: {
                  code: 'MOCK_TEMPLATE_INVALID',
                  message: 'Mock template validation failed',
                },
              },
              { status: 422 },
            );
          }
        }
        task = {
          batchId: body.batchId,
          state: 'READY',
          analysisStarted: false,
          simulation: true,
          experiments: body.experiments.map((experiment: any) => ({
            experimentId: experiment.experimentId,
            analysisPort: experiment.analysisPort,
            state: 'READY',
          })),
        };
        return Response.json({ ok: true, data: { task } }, { status: 201 });
      }
      if (route === `/api/v1/tasks/${task?.batchId}/start`) {
        if (scenario.mode === 'unknown-start')
          return Response.json(
            {
              ok: true,
              data: {
                task: {
                  batchId: 'WRONG-START-BATCH',
                  state: 'STARTING',
                  simulation: true,
                },
              },
            },
            { status: 202 },
          );
        task = {
          ...task,
          state: 'STARTING',
          analysisStarted: false,
          experiments: task.experiments.map((experiment: any) => ({
            ...experiment,
            state: 'STARTING',
          })),
        };
        return Response.json({ ok: true, data: { task } }, { status: 202 });
      }
      return Response.json(
        { ok: false, error: { code: 'UNEXPECTED_ROUTE', message: route } },
        { status: 404 },
      );
    },
  });
  const config = {
    ...baseConfig,
    dataDir: join(directory, 'data'),
    skillRoots: [join(repository, 'examples/skills')],
    ...(stagedRoot
      ? { builtinSkills: false, skillRoots: [stagedRoot, join(repository, 'examples/skills')] }
      : {}),
    scriptEnv: {
      ...baseConfig.scriptEnv,
      CLIMBER_SERVICE_URL: `${vendor.url.origin}/api/v1`,
      SAM_OUTPUT_DIR: templates,
      AUTO_AGENT_SIMULATION_DIR: join(directory, 'simulation'),
    },
  };
  const configFile = join(directory, 'config.json');
  await writeFile(configFile, JSON.stringify(config, null, 2));
  const child = spawn(process.execPath, ['run', 'dev', '--config', configFile, '--json'], {
    cwd: repository,
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '',
    stderr = '',
    stderrLine = '',
    closed = false;
  let waiting:
    | {
        resolve: (value: { reply: string; error?: string }) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    let end: number;
    while ((end = stdout.indexOf('\n')) >= 0) {
      const line = stdout.slice(0, end);
      stdout = stdout.slice(end + 1);
      try {
        const message = JSON.parse(line);
        if (message.role === 'assistant' && waiting) {
          const current = waiting;
          waiting = undefined;
          current.resolve({ reply: message.content });
        }
      } catch {
        /* Retain public JSON messages only. */
      }
    }
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
    stderrLine += chunk;
    let end: number;
    while ((end = stderrLine.indexOf('\n')) >= 0) {
      const line = stderrLine.slice(0, end);
      stderrLine = stderrLine.slice(end + 1);
      if (
        line.startsWith('[error]') &&
        waiting &&
        !/^\[error\] (?:OUTCOME_UNKNOWN:|Use \/review)/.test(line)
      ) {
        const current = waiting;
        waiting = undefined;
        let reply = line;
        try {
          reply = inspectDatabase(join(config.dataDir, 'storage.sqlite')).message?.content ?? line;
        } catch {
          /* Startup failures have no audit. */
        }
        current.resolve({ error: redact(line), reply: redact(reply) });
      }
    }
  });
  child.once('error', (error) => waiting?.reject(error));
  const exited = new Promise<void>((resolve) =>
    child.once('close', () => {
      closed = true;
      waiting?.reject(new Error('dev exited before replying'));
      resolve();
    }),
  );
  const turns: Turn[] = [];
  let failure: string | undefined;
  try {
    for (const [index, prompt] of scenario.prompts(context).entries()) {
      const before = requests.length;
      const started = performance.now();
      const response = await new Promise<{ reply: string; error?: string }>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting = undefined;
          reject(new Error('Live response deadline exceeded; no automatic replay'));
        }, 180000);
        waiting = {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
        child.stdin.write(prompt + '\n');
      });
      const audit = inspectDatabase(join(config.dataDir, 'storage.sqlite'));
      const durationMs = Math.round(performance.now() - started);
      let log: any[] = [];
      try {
        log = (await readFile(join(config.dataDir, 'logs/agent.jsonl'), 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
      } catch {
        /* Report missing logs through zero counts. */
      }
      const priorRun = turns.length ? (turns.at(-1) as any).runId : undefined;
      const sameRun = priorRun === audit.run?.id;
      const modelResults = log.filter(
        (entry) => entry.runId === audit.run?.id && entry.event === 'model.completed',
      );
      const modelSteps = log.filter(
        (entry) => entry.runId === audit.run?.id && entry.event === 'model.started',
      ).length;
      const turn: Turn & { runId?: string } = {
        prompt,
        ...response,
        files: await files(templates),
        requests: structuredClone(requests.slice(before)),
        tools: sameRun ? [] : audit.calls,
        steps: sameRun ? 0 : modelSteps,
        runId: audit.run?.id,
        durationMs,
        tokens: sameRun
          ? 0
          : modelResults.length && modelResults.length === modelSteps
            ? modelResults.reduce(
                (sum, entry) =>
                  sum + (typeof entry.totalTokens === 'number' ? entry.totalTokens : 0),
                0,
              )
            : null,
      };
      turns.push(turn);
      let rendered = '';
      const markdown = new TerminalMarkdown((text) => (rendered += text), false, 100);
      for (const char of turn.reply) markdown.append(char);
      markdown.finish();
      await writeFile(join(directory, `reply-${index + 1}.txt`), rendered);
      await writeFile(join(directory, `turn-${index + 1}.json`), JSON.stringify(turn, null, 2));
      if (turn.error && !scenario.id.startsWith('unknown')) throw new Error(turn.error);
    }
    const commands: Record<string, string[]> = {
      'scripts/sam.js': ['profiles', 'inspect', 'compare', 'create', 'modify', 'save-as'],
      'scripts/climber.js': ['health', 'status', 'register', 'start'],
      'scripts/automation.js': ['list', 'status', 'submit-run', 'run', 'results', 'export-report'],
    };
    for (const turn of turns)
      for (const tool of turn.tools) {
        if (tool.name === 'execute_script' && commands[tool.path])
          check(
            commands[tool.path]!.includes(tool.operation),
            `Invented/invalid script command: ${tool.path} ${tool.operation}`,
          );
      }
    scenario.validate(turns, context);
  } catch (error) {
    failure = redact(error instanceof Error ? error.message : String(error));
  } finally {
    if (!closed) {
      child.stdin.end('/exit\n');
      await Promise.race([exited, Bun.sleep(20000)]);
      if (!closed) {
        child.kill();
        await Promise.race([exited, Bun.sleep(5000)]);
      }
    }
    vendor.stop(true);
    await writeFile(join(directory, 'dev-stderr.log'), redact(stderr));
  }
  const result = {
    id: scenario.id,
    label: scenario.label,
    passed: !failure,
    failure,
    turns,
    directory,
    model: baseConfig.model,
    configuration,
    skillBodySha256: manifest.skillBodySha256,
    deviceBackend: 'local-mock-only',
    requests,
  };
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify({
      id: result.id,
      label: result.label,
      passed: result.passed,
      failure,
      turns: turns.map((turn) => ({
        steps: turn.steps,
        durationMs: turn.durationMs,
        tokens: turn.tokens,
        tools: turn.tools.map((tool) => `${tool.name}:${tool.operation ?? tool.path ?? ''}`),
        reply: turn.reply.slice(0, 1500),
        error: turn.error,
      })),
      directory,
    }),
  );
  return result;
}

const requested = args.values.cases?.split(',');
let evaluationScenarios = scenarios;
if (args.values['eval-set']) {
  if (requested) throw new Error('Use either --eval-set or --cases');
  const dataset = JSON.parse(await readFile(resolve(args.values['eval-set']), 'utf8'));
  if (!Array.isArray(dataset.evals)) throw new Error('eval-set requires evals[]');
  if (
    !dataset.evals.length ||
    dataset.evals.length > 20 ||
    new Set(dataset.evals.map((entry: any) => entry.id)).size !== dataset.evals.length
  )
    throw new Error('eval-set requires 1..20 unique eval identifiers');
  evaluationScenarios = dataset.evals.map((entry: any) => {
    const scenario = scenarios.find((candidate) => candidate.id === entry.scenario);
    if (
      !scenario ||
      ['edits', 'unknown', 'unknown-start'].includes(scenario.id) ||
      typeof entry.prompt !== 'string' ||
      /[\r\n]/.test(entry.prompt) ||
      !Number.isInteger(entry.id)
    )
      throw new Error('Holdout entry needs an integer id, a single-turn scenario and a prompt');
    return {
      ...scenario,
      id: `holdout-${entry.id}`,
      label: entry.name ?? scenario.label,
      prompts: () => [entry.prompt],
    };
  });
  await writeFile(join(output, 'evals.json'), JSON.stringify(dataset, null, 2));
}
if (requested?.some((id) => !scenarios.some((scenario) => scenario.id === id)))
  throw new Error('Unknown case identifier');
const selected = evaluationScenarios.filter(
  (scenario) => !requested || requested.includes(scenario.id),
);
const results = [];
for (let iteration = 1; iteration <= repeat; iteration++)
  for (const scenario of selected) {
    results.push(
      await runScenario(
        repeat > 1 ? { ...scenario, id: `${scenario.id}-run-${iteration}` } : scenario,
      ),
    );
    await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2));
  }
const summary = {
  output,
  scenarios: results.length,
  passed: results.filter((result) => result.passed).length,
  failed: results
    .filter((result) => !result.passed)
    .map((result) => ({ id: result.id, failure: result.failure })),
  model: baseConfig.model,
  configuration,
  repeat,
  physicalEquipmentRequests: 0,
  validationScope:
    'Live model replies with tool/file/state invariants; technical prose also requires human review.',
};
await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
if (summary.failed.length) process.exitCode = 1;
