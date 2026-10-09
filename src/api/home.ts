import integrationGuide from '../../llm.txt' with { type: 'text' };
export const llmText = integrationGuide;
export function home(noToken: boolean): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Auto-Agent</title><style>
:root{color-scheme:light dark;--bg:#fafafa;--fg:#242424;--muted:#737373;--line:#e5e5e5}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:620px;margin:14vh auto;padding:24px}h1{font-size:32px;font-weight:600;letter-spacing:-1px;margin:0 0 8px}p{color:var(--muted);margin:0 0 28px}nav{display:flex;gap:24px;margin-bottom:40px;flex-wrap:wrap}a{color:inherit;text-underline-offset:4px}section{border-top:1px solid var(--line);padding-top:24px}h2{font-size:14px;font-weight:600;margin:0 0 12px}pre{font:13px/1.7 ui-monospace,Consolas,monospace;overflow:auto;margin:0;padding:0 0 24px}footer{font-size:12px;color:var(--muted);margin-top:24px}@media(prefers-color-scheme:dark){:root{--bg:#191919;--fg:#e5e5e5;--muted:#a3a3a3;--line:#333}}@media(max-width:600px){main{margin:8vh auto;padding:24px}}
</style></head><body><main><h1>Auto-Agent</h1><p>A local-first AI agent with trusted skills.</p><nav><a href="/llm.txt">Integration guide</a><a href="/llm.txt" download="llm.txt">Download llm.txt</a><a href="/global/health">Health</a></nav><section><h2>Quick start</h2><p>Run this JavaScript with Node.js 22+ or Bun. ${noToken ? 'This local service does not require a token.' : 'Set AUTO_AGENT_TOKEN to the token used by this service.'} A cloud model must be configured on the server.</p><pre>const base = 'http://127.0.0.1:4096';
const headers = {
  'Content-Type': 'application/json',
  ${noToken ? '// This local service has authentication disabled.' : "Authorization: 'Bearer ' + process.env.AUTO_AGENT_TOKEN,"}
};

// 1. Create a session.
const created = await fetch(base + '/session', {
  method: 'POST', headers, body: '{}',
});
if (!created.ok) throw new Error(await created.text());
const session = await created.json();

// 2. Send a message and wait for the reply.
const response = await fetch(
  base + '/session/' + session.id + '/message',
  {
    method: 'POST', headers,
    body: JSON.stringify({ content: 'Hello' }),
  },
);
if (!response.ok) throw new Error(await response.text());
const reply = await response.json();
console.log(reply.content);

// Reuse session.id for subsequent messages.</pre><p>For streaming, subscribe to /event before submitting to /session/{id}/prompt_async. See the integration guide for event handling and cancellation.</p></section><footer>${noToken ? 'Authentication disabled. Local access only.' : 'API requests require a Bearer token.'} Documentation is public.</footer></main></body></html>`;
}
