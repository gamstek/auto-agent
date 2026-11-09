import { expect, test } from 'bun:test';
import type { MessageStreamEvent } from '@coraxjs/core/client';
import { configSchema } from 'auto-agent/config';
import { QuestionSuggestionService, type SuggestionContext } from '../../corax/lib/suggestions';

const questions = [
  '多孔碳材料进行吸附测试前需要确认哪些条件？',
  '如何核对碳材料测试模板的适用范围？',
  '如何比较不同样品的孔径分析方法？',
  '如何整理已有测试资料并保留原文来源？',
];
const recent = [{ id: 'wrun_01M6JWQZ0A0QH6MERWTZ96Z7TB', title: '多孔碳材料测试', updatedAt: 100 }];
const config = configSchema.parse({ model: 'local', climber: { enabled: false } });
async function* noHistory() {}
function message(text: string): MessageStreamEvent {
  return {
    type: 'message.received',
    data: { message: text, turnId: 'turn', sequence: 0 },
    meta: { id: 'event', at: new Date(0).toISOString() },
  };
}

test('recommendations use bounded recent user questions and actual configured capabilities', async () => {
  let observed!: SuggestionContext;
  const service = new QuestionSuggestionService(
    async (_config, context) => {
      observed = context;
      return JSON.stringify({ questions });
    },
    async function* () {
      yield message('earlier question');
      yield message('确认多孔碳材料测试方案');
      yield message('长问题'.repeat(1000));
    },
  );
  expect(await service.get(config, recent)).toMatchObject({ source: 'model', questions });
  expect(observed.recentSessions).toHaveLength(1);
  expect(observed.recentSessions[0]!.title).toBe('多孔碳材料测试');
  expect(observed.recentSessions[0]!.questions).toHaveLength(2);
  expect(observed.recentSessions[0]!.questions[0]).toBe('确认多孔碳材料测试方案');
  expect(Array.from(observed.recentSessions[0]!.questions[1]!)).toHaveLength(400);
  expect(observed.capabilities).toEqual({
    samProducts: ['Climber', 'SiCOPE'],
    climberControl: false,
    knowledgeSources: 0,
  });
});

test('single-flight and short-lived result caching avoid repeated model calls but follow usage and data changes', async () => {
  let count = 0;
  let now = 1000;
  let release!: (text: string) => void;
  const pending = new Promise<string>((resolve) => (release = resolve));
  const service = new QuestionSuggestionService(
    async () => {
      count++;
      return pending;
    },
    noHistory,
    () => now,
  );
  const first = service.get(config, recent);
  const joined = service.get(config, recent);
  await Bun.sleep(0);
  expect(count).toBe(1);
  release(JSON.stringify({ questions }));
  expect(await first).toEqual(await joined);
  await service.get(config, recent);
  expect(count).toBe(1);
  await service.get(config, [{ ...recent[0]!, updatedAt: 200 }]);
  expect(count).toBe(2);
  await service.get({ ...config, dataDir: 'another-user-data' }, recent);
  expect(count).toBe(3);
  now += 300001;
  await service.get(config, recent);
  expect(count).toBe(4);
});

test('unreadable history still permits topic-based recommendations without creating or replaying a conversation', async () => {
  let observed!: SuggestionContext;
  const service = new QuestionSuggestionService(
    async (_config, context) => {
      observed = context;
      return JSON.stringify({ questions });
    },
    async function* () {
      throw new Error('retired historical session');
    },
  );
  expect((await service.get(config, recent)).source).toBe('model');
  expect(observed.recentSessions).toEqual([{ title: '多孔碳材料测试', questions: [] }]);
});

test('invalid or incomplete model output falls back and is not automatically retried', async () => {
  for (const text of [
    'not JSON',
    JSON.stringify({ questions: [questions[0], questions[0], questions[1], questions[2]] }),
    JSON.stringify({ questions: ['<script>alert(1)</script>', ...questions.slice(1)] }),
    JSON.stringify({ questions: questions.slice(0, 3) }),
  ]) {
    let count = 0;
    const service = new QuestionSuggestionService(async () => {
      count++;
      return text;
    }, noHistory);
    const result = await service.get(config, recent);
    expect(result.source).toBe('default');
    expect(result.questions).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(text);
    await service.get(config, recent);
    expect(count).toBe(1);
  }
});

test('history inspection is bounded to eighty events per recent session', async () => {
  let reads = 0;
  let released = false;
  const service = new QuestionSuggestionService(
    async () => JSON.stringify({ questions }),
    async function* () {
      try {
        for (let index = 0; index < 1000; index++) {
          reads++;
          yield message(`question ${index}`);
        }
      } finally {
        released = true;
      }
    },
  );
  await service.get(config, recent);
  expect(reads).toBe(80);
  expect(released).toBe(true);
});

test('a stalled history-tail lookup does not hold recommendation generation past its history budget', async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => (release = resolve));
  let observed!: SuggestionContext;
  const service = new QuestionSuggestionService(
    async (_config, context) => {
      observed = context;
      return JSON.stringify({ questions });
    },
    async function* () {
      await waiting;
      yield message('late history must not enter the generated context');
    },
  );
  try {
    const result = await Promise.race([
      service.get(config, recent),
      Bun.sleep(3500).then(() => {
        throw new Error('history lookup delayed the recommendation');
      }),
    ]);
    expect(result.source).toBe('model');
    expect(observed.recentSessions[0]!.questions).toEqual([]);
  } finally {
    release();
  }
});

test('expired requests waiting for another context do not start late model calls', async () => {
  let release!: (value: string) => void;
  const waiting = new Promise<string>((resolve) => (release = resolve));
  let calls = 0;
  const service = new QuestionSuggestionService(async () => {
    calls++;
    return waiting;
  }, noHistory);
  const first = service.get(config, recent, AbortSignal.timeout(100));
  const changed = service.get(config, [{ ...recent[0]!, updatedAt: 200 }], AbortSignal.timeout(20));
  expect((await changed).source).toBe('default');
  expect(calls).toBe(1);
  release(JSON.stringify({ questions }));
  expect((await first).source).toBe('model');
  expect(calls).toBe(1);
});
