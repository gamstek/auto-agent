import { expect, test } from 'bun:test';
import { fixture } from '../helpers';
import { Store } from '../../src/storage';
import { Skills } from '../../src/skill';
import { AgentService } from '../../src/agent';
import { ScriptExecutor } from '../../src/execution';
import { CloudModel } from '../../src/llm';

test('reasoning survives a real SDK tool round trip and session restart without entering public messages', async () => {
  const f = await fixture();
  const requests: any[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = await request.json();
      requests.push(body);
      const step = requests.length;
      // Match the provider requirement, not just the UI event contract.
      const previous = body.messages.filter((message: any) => message.role === 'assistant');
      if (previous.some((message: any) => !message.reasoning_content))
        return Response.json({ error: { message: 'Missing reasoning_content' } }, { status: 400 });
      const base = {
        id: `mock-${step}`,
        object: 'chat.completion.chunk',
        created: 0,
        model: 'mock',
      };
      const delta =
        step === 1
          ? {
              role: 'assistant',
              reasoning_content: 'Inspect available skill.',
              tool_calls: [
                {
                  index: 0,
                  id: 'load',
                  type: 'function',
                  function: { name: 'skill', arguments: '{"name":"hello-world"}' },
                },
              ],
            }
          : {
              role: 'assistant',
              reasoning_content: step === 2 ? 'Explain the skill.' : 'Answer the follow-up.',
              content: step === 2 ? 'First answer' : 'Second answer',
            };
      const chunk = { ...base, choices: [{ index: 0, delta, finish_reason: null }] };
      const end = {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: step === 1 ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      };
      return new Response(
        `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    },
  });
  const config = { ...f.config, baseURL: `${server.url.origin}/v1` };
  let store = new Store(config.dataDir);
  const skills = new Skills(config);
  await skills.discover();
  const createService = () =>
    new AgentService(
      config,
      store,
      skills,
      new ScriptExecutor(config, skills),
      new CloudModel(config),
    );
  let service = createService();
  try {
    const session = store.createSession('Reasoning regression');
    const first = await service.submit(session.id, 'Load the skill');
    expect(first.content).toBe('First answer');
    expect(first).not.toHaveProperty('reasoning');
    const toolAssistant = requests[1].messages.find((message: any) => message.role === 'assistant');
    expect(toolAssistant).toMatchObject({
      reasoning_content: 'Inspect available skill.',
      tool_calls: [{ id: 'load' }],
    });
    expect(JSON.stringify(store.messages(session.id))).not.toContain('Explain the skill.');
    expect(store.contextMessages(session.id, 4096).at(-1)?.reasoning).toBe('Explain the skill.');
    // The reasoning bytes count towards the bounded history read.
    expect(store.contextMessages(session.id, Buffer.byteLength(first.content))).toEqual([]);

    await service.shutdown();
    store.close();
    store = new Store(config.dataDir);
    service = createService();
    const second = await service.submit(session.id, 'Follow up');
    expect(second.content).toBe('Second answer');
    expect(requests).toHaveLength(3);
    expect(requests[2].messages.find((message: any) => message.role === 'assistant')).toMatchObject(
      { content: 'First answer', reasoning_content: 'Explain the skill.' },
    );
    expect(JSON.stringify(store.messages(session.id))).not.toContain('Answer the follow-up.');
  } finally {
    await service.shutdown();
    store.close();
    server.stop(true);
    await f.cleanup();
  }
});
