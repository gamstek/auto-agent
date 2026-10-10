# Auto-Agent

A local-first general AI agent with trusted Agent Skills, persistent sessions, an interactive CLI, and an HTTP API. Built with Bun, TypeScript, LangGraph, Vercel AI SDK, and SQLite.

> Device control, experimental workflows, analytics, and reports are future skill integrations, not built-in features. This is not a complete OpenCode or OpenAI-compatible server.

## Requirements

- Bun **1.4.2**, installed as a system runtime (CI uses `oven-sh/setup-bun`); do not install the npm `bun` package in this project because its shim shadows the runtime in package scripts. Native SQLite requires Bun; Node.js cannot run the application directly.
- Node.js on PATH for the example skill scripts (22+ recommended).
- PowerShell/CIM on Windows for owned-process tracking.
- Other skill languages require configured interpreters.

## Quick start

```powershell
bun install --frozen-lockfile
$env:AUTO_AGENT_API_KEY = 'your-cloud-model-key'
npm run dev -- --config .\examples\config.json
```

The default entry starts a local readline REPL without HTTP authentication. Enter a message to continue the same session. Use /exit or Ctrl+C while idle to exit; Ctrl+C during generation cancels the reply. Use --session ID to continue history and --json for assistant JSON output. Positional arguments other than serve become the first chat message; there are no one-shot run/session/abort commands or --url/--stream options.

Assistant Markdown supports headings, emphasis, lists, quotes, links, and code fences. Streaming is rendered by complete lines; tables remain plain text. NO_COLOR, TERM=dumb, and redirected output disable colors.

### HTTP service

```powershell
$env:AUTO_AGENT_TOKEN = [guid]::NewGuid().ToString('N')
$env:AUTO_AGENT_API_KEY = 'your-cloud-model-key'
npm run dev -- serve --config .\examples\config.json
```

Open **[http://127.0.0.1:4096/](http://127.0.0.1:4096/)** for quick integration links. [llm.txt](llm.txt) is the detailed guide for AI assistants and integration software, served at /llm.txt with /llms.txt as an alias. Documentation and health endpoints are public and contain no configuration, credentials, or session data.

HTTP requires a bearer token of at least 16 characters by default. Trusted local development can explicitly disable it:

```powershell
npm run dev -- serve --config .\examples\config.json --no-token
```

No-token mode is loopback-only. Do not expose it through proxies or forwarding. Remote authenticated binding requires allowRemote and appropriate network/TLS protection. REPL and HTTP cannot share the same data directory concurrently: stop the existing process or use a separate dataDir.

## Configuration

**Development vs installed usage:** `npm run dev` loads the repository's `examples/config.json` by default and displays `Mode: development`. An explicit `--config` overrides it. Paths are anchored to the project, even when launched from another working directory. `npm run start` and compiled executables use the user-directory configuration by default; the development entry never creates or edits that file. Model credentials remain environment variables; selecting the right configuration does not make an invalid API key valid.

Without `--config`, first launch of `start` or the installed executable creates `~/.auto-agent/config.json` and subsequent launches load it automatically. Existing files are never overwritten and credentials are never generated or saved. Startup prints the active configuration/model/data directory and warns if the cloud key is missing. Edit `model`/`baseURL`, set `AUTO_AGENT_API_KEY`, and restart before chatting. HTTP missing-token hints also explain `serve --no-token` for trusted loopback use.

Start with [examples/config.json](examples/config.json). Relative dataDir/skillRoots paths resolve against the configuration file, not the working directory. Without a configuration file, data defaults to the user's .auto-agent directory.

| Option                                 | Default / purpose                                                    |
| -------------------------------------- | -------------------------------------------------------------------- |
| dataDir                                | ~/.auto-agent; SQLite and process ownership                          |
| skillRoots                             | []; explicitly trusted skill roots                                   |
| host / port                            | 127.0.0.1 / 4096                                                     |
| allowRemote                            | false; remote binding only with authenticated HTTP                   |
| token                                  | HTTP bearer; AUTO_AGENT_TOKEN takes precedence                       |
| model / baseURL                        | deepseek-flash / `https://api.deepseek.com`                          |
| systemPrompt                           | Optional, up to 16000 characters; appended to platform instructions  |
| interpreters                           | Extension-to-executable map; .js=node, .sh=bash, .ps1=powershell.exe |
| scriptEnv                              | Validated skill-specific environment variables                       |
| maxSteps / maxTokens                   | 12 / 32000 reported tokens, excluding title requests                 |
| modelTimeoutMs / scriptTimeoutMs       | 60000 / 30000                                                        |
| outputLimitBytes                       | 65536, stdout/stderr combined                                        |
| resourceLimitBytes / requestLimitBytes | 65536 each                                                           |
| maxConcurrent                          | 4, session/script concurrency budget                                 |

Cloud credentials come only from AUTO_AGENT_API_KEY. Do not commit secrets or place them in systemPrompt. Restart after configuration changes. The default prompt identifies Auto-Agent and describes skill discovery, loading, resource access, script arguments, real tool outcomes, and operator reconciliation. Empty prompts fall back to this project-specific default; custom prompts append preferences and cannot bypass tool restrictions. Startup prints the resolved skill roots and discovered names so missing configuration is distinguishable from a model refusing or overlooking a skill.

Development defaults resolve to repository `examples/config.json`, `examples/skills`, and `.auto-agent` data. Installed defaults resolve to user `~/.auto-agent/config.json` and its data directory with built-in skills enabled and no implicitly trusted external skills. Explicit paths behave identically in both modes: relative paths resolve against the selected configuration, not cwd; the model and tool loop do not otherwise vary by mode.

```json
{ "systemPrompt": "Answer concisely and explain actions without inventing results." }
```

Untitled sessions receive a model-generated title after a successful reply. This adds a separate paid request, capped at 128 output tokens and 15 seconds (or the configured shorter timeout). Titles are at most 60 characters; manual titles are preserved. Failures do not fail the reply and are retried on a later message. Existing New session records are updated on their next successful interaction, not by uploading history at startup.

## HTTP API

Full request, event, and error contracts: [llm.txt](llm.txt). JSON requests use Content-Type: application/json; non-public endpoints require Authorization: Bearer TOKEN by default.

| Method     | Path                      | Purpose                                           |
| ---------- | ------------------------- | ------------------------------------------------- |
| GET        | /                         | Minimal integration landing page                  |
| GET        | /llm.txt, /llms.txt       | UTF-8 integration guide                           |
| GET        | /global/health            | healthy / version                                 |
| POST / GET | /session                  | Create with {title?} (201) / list                 |
| GET        | /session/:id              | Session metadata                                  |
| GET        | /session/:id/message      | Chronological message array                       |
| POST       | /session/:id/message      | Submit {content}, wait for assistant message      |
| POST       | /session/:id/prompt_async | Submit {content}, 204 acceptance                  |
| GET        | /event                    | SSE model, text, tool, and session events         |
| POST       | /session/:id/abort        | Wait for owned generation cancellation; {aborted} |

Session fields: id/title/createdAt/updatedAt. Message fields: id/sessionId/role/content/createdAt. Content is Markdown; timestamps are Unix milliseconds. Internal execution/checkpoint IDs are not exposed. Concurrent generation in the same session returns 409; exhausted capacity returns 429.

```javascript
const base = 'http://127.0.0.1:4096';
const headers = {
  Authorization: 'Bearer ' + process.env.AUTO_AGENT_TOKEN,
  'Content-Type': 'application/json',
};
const created = await fetch(base + '/session', { method: 'POST', headers, body: '{}' });
if (!created.ok) throw new Error('Create failed: ' + created.status);
const session = await created.json();
const response = await fetch(base + '/session/' + session.id + '/message', {
  method: 'POST',
  headers,
  body: JSON.stringify({ content: 'Explain available capabilities' }),
});
if (!response.ok) throw new Error('Agent failed: ' + response.status);
console.log((await response.json()).content);
```

### Streaming

Subscribe /event before submitting prompt_async. Correlate sessionId/messageId; toolCallId pairs tool lifecycle events. Use fetch streaming because native EventSource cannot attach bearer headers.

Events include session.status, model.started/completed/failed, message.part.delta, tool.started/completed/failed, session.title.started/failed, session.updated, message.completed, and session.error. See [llm.txt](llm.txt) for fields. Events omit raw script output and full arguments.

No event replay exists. Each client has a 64-frame queue; subscriber capacity is maxConcurrent * 8. Disconnecting SSE does not cancel generation. Read history after reconnecting; **do not blindly resubmit ambiguous side-effecting tasks**. A synchronous response contains only the final reply. Client applications must render raw Markdown safely, not as trusted HTML.

There is no /v1/chat/completions, business /runs, /devices, or /skills endpoint, third-party browser CORS configuration, or OpenAPI service.

## Built-in Skills

The root [skills](skills) directory contains built-in packages; examples remain under [examples/skills](examples/skills), and external skills are configured through `skillRoots`. The built-in `device-automation` package is a virtual device automation simulator. It lists virtual devices and simulates status, power, and desk-lamp brightness operations. It never connects to or controls real hardware or networks, and simulated changes are not persisted.

`builtinSkills` defaults to `true`. Source runs read every UTF-8 file under the root `skills` directory, relative to the source module rather than the launch directory. The `build:windows` and `build:linux` commands use a Bun build plugin to embed the same resources into standalone executables; no generated source files or `pre*` hooks are required. Both modes release a content-versioned copy under `dataDir/builtin-skills/<version>` before discovery. No `skillRoots` configuration is needed for `device-automation`; its script requires Node.js on PATH. Built-ins use the same metadata/path validation, execution limits, audit, and cancellation as configured skills.

Set `builtinSkills: false` to disable extraction/loading. Extracted built-in files are verified against embedded content; modifications fail closed instead of being overwritten or executed. A configured skill with the same name produces a duplicate-name diagnostic, never silently overriding the built-in. Do not edit generated copies: change the source package and rebuild, or supply a separately named configured skill.

## Skills and trust

Examples: [examples/skills](examples/skills). Each trusted root contains skill directories with SKILL.md; name must match the directory. YAML name/description are required; optional metadata does not grant extra privileges. Duplicate/invalid skills fail discovery. Full compatibility with the latest official specification has not been independently verified.

```text
skills/
  example-skill/
    SKILL.md
    scripts/
    references/
    assets/
```

Tools: list_skills, load_skill, read_skill_resource, execute_skill_script. Script entries are confined to the selected skill's scripts/ directory; traversal, absolute paths, and symlinks are rejected. Arguments are passed as arrays.

**Not an OS sandbox.** Trusted scripts retain host filesystem/network permissions and run without per-call approval. Necessary skill resources and tool output can enter cloud model context. SQLite persists session/checkpoint context; protect the data directory. Known configured credentials are redacted, but arbitrary secrets cannot be automatically detected.

Execution intent is persisted first. Failed scripts are not automatically retried. Interrupted scripts without results become unknown and require operator reconciliation; other interrupted generations fail rather than resume automatically. No public resume/unblock endpoint exists. Cleanup tracks owned processes/groups, not deliberately detached scripts. **Aborting the agent does not confirm equipment stopped or effects were undone.**

## CLI output

`--help` shows commands, options, and examples. Startup diagnostics and progress use stderr; messages use `[info]`, `[warn]`, and `[error]` levels, with yellow warnings and red errors only on color-capable terminals. Redirected output, `NO_COLOR`, and `TERM=dumb` disable automatic coloring. Replies and help use stdout; `--json` emits newline-delimited JSON for history and replies without diagnostic text. The HTTP service retains its JSON `listening` notification on stdout for integrations.

## Development and release

`src/app.ts` exports application startup without running it on import. `src/index.ts` is the shared source/standalone entrypoint and explicitly awaits startup; `scripts/dev.ts` calls the same application with development defaults. Builds keep ESM format and do not rely on `import.meta.main`.

```powershell
bun run format
bun run format:check
bun run typecheck
bun test
bun run build:windows
bun run build:linux
$env:AUTO_AGENT_TEST_BINARY = '1'
bun test .\tests\integration\binary.test.ts
```

Prettier enforces formatting. Outputs: dist/auto-agent.exe (Windows x64) and dist/auto-agent (Linux x64). Configuration, skills, and interpreters remain external; public documentation is embedded into the binary. Cross-compilation is not Linux runtime acceptance; platform CI validates native runs. Tests use model doubles/local HTTP mocks, never live cloud calls by default.

Push a version tag such as `v0.1.0` to run the same Windows/Linux builds and binary acceptance tests. After both platform jobs pass, CI creates a GitHub Release with generated notes and attaches `auto-agent.exe` and `auto-agent`.

Source areas: src/agent, src/llm, src/skills, src/execution, src/storage, src/api, src/cli, and tests. Future device, experimental, analytical, and reporting skills require verified domain protocols and SDKs.
