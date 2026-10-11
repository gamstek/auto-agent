# Auto-Agent

A local-first automation assistant for specific surface area and pore size analyzers, with trusted Agent Skills, persistent sessions, an interactive CLI, and an HTTP API. Built with Bun, TypeScript, LangGraph, Vercel AI SDK, and SQLite. Real instrument tasks and workflows require explicitly configured instrument-specific skills; the bundled device skill provides wiki-backed recommendation drafts and a separate virtual-device simulator, not real instrument control.

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

Cloud credentials come only from AUTO_AGENT_API_KEY. Do not commit secrets or place them in systemPrompt. Restart after configuration changes. The default prompt focuses Auto-Agent on specific surface area and pore size analyzer tasks and workflows: skill-grounded capabilities, essential sample/method clarification, prerequisite and instrument-state checks, ordered execution, completion evidence, analysis-method distinctions, data traceability, and operator reconciliation. It distinguishes simulations from real instrument results and command acceptance from experiment completion; it does not supply instrument procedures or add hardware capabilities. The runtime contract requires reading loaded skill guidance before dependent calls, treats historical skill mentions as unloaded, uses resource/tool content as evidence rather than overriding instructions, and distinguishes process exit success from instrument completion. Empty prompts fall back to this project-specific default; custom prompts append preferences and cannot bypass tool restrictions. Startup prints the resolved skill roots and discovered names so missing configuration is distinguishable from a model refusing or overlooking a skill.

Development defaults resolve to repository `examples/config.json`, `examples/skills`, and `.auto-agent` data. Installed defaults resolve to user `~/.auto-agent/config.json` and its data directory with built-in skills enabled and no implicitly trusted external skills. Explicit paths behave identically in both modes: relative paths resolve against the selected configuration, not cwd; the model and tool loop do not otherwise vary by mode.

```json
{ "systemPrompt": "Answer concisely and explain actions without inventing results." }
```

Untitled sessions receive a model-generated title in the background after a successful reply. This adds a separate paid request, capped at 128 output tokens and 15 seconds (or the configured shorter timeout), without delaying reply completion or holding a session/generation slot. Title work has a separate maxConcurrent budget, with at most one pending title per session; work skipped at capacity or failed is retried on a later successful message. Shutdown cancels pending titles. Titles are at most 60 characters; manual titles are preserved. Existing New session records are updated on their next successful interaction, not by uploading history at startup.

## HTTP API

Full request, event, and error contracts: [llm.txt](llm.txt). JSON requests use Content-Type: application/json; non-public endpoints require Authorization: Bearer TOKEN by default.

| Method     | Path                      | Purpose                                                   |
| ---------- | ------------------------- | --------------------------------------------------------- |
| GET        | /                         | Minimal integration landing page                          |
| GET        | /llm.txt, /llms.txt       | UTF-8 integration guide                                   |
| GET        | /global/health            | healthy / version                                         |
| POST / GET | /session                  | Create with {title?} (201) / list                         |
| GET        | /session/:id              | Session metadata                                          |
| GET        | /session/:id/message      | Chronological message array                               |
| POST       | /session/:id/message      | Submit {content}, wait for assistant message              |
| POST       | /session/:id/prompt_async | Submit {content}, 204 acceptance                          |
| GET        | /event                    | SSE model, text, tool, and session events                 |
| GET        | /wiki                     | Knowledge state, source IDs, record count/build time      |
| GET        | /wiki/query               | Query with `query` and optional `limit` (1–10, default 5) |
| POST       | /wiki/update              | Explicit paid incremental update; wait for completion     |
| POST       | /session/:id/abort        | Wait for owned generation cancellation; {aborted}         |

GET /session and GET /session/:id/message accept limit (default 100, maximum 1000) and offset (default 0), and retain array responses. Sessions are newest-updated first. Messages select the latest page, skip offset messages from the newest end, and return that page chronologically; increase offset to fetch older history. Equal timestamps are ordered by insertion order. Invalid pagination returns 400. Offset pages can shift during concurrent writes. Agent context is read lazily from newest history up to its byte budget, independently of API pagination. Abort returns false after reply completion, even while a background title is pending; titles may emit session.updated after message.completed.

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

## Wiki knowledge and recommendation drafts

The root [wiki](wiki) directory is **built-in wiki**, parallel to [skills](skills), and is embedded into standalone binaries. `builtinWiki` defaults to `true`; `wikiRoots` defaults to `[]` and lists additional operator-selected directories of UTF-8 Markdown/text sources. Relative external paths resolve against the configuration file. The example configuration adds [examples/wiki](examples/wiki); installed defaults use bundled wiki only, not arbitrary files from the working directory. The former `wikiDir` field is rejected with migration guidance: use `wikiRoots` for external documents, never add the built-in root again.

Built-in sources are released and content-verified under `dataDir/builtin-wiki/<version>`; modified extracted files fail closed. Change repository source and rebuild rather than editing generated copies. No model calls occur during extraction. Startup diagnostics on stderr show external wiki roots, discovered source names annotated with `(built-in)` or `(configured)` just like skills, and knowledge status (`ready`, `unbuilt`, `stale`, `empty`, or `invalid`). Ready knowledge includes record count/build time; unavailable knowledge does not prevent chat/service startup and is never rebuilt automatically. Built-in and external documents are compiled together only on explicit update. Source IDs use `builtin/<path>` and `external-<root-hash>/<path>` to avoid collisions between identically named files. Changing roots/enabling settings requires an explicit rebuild; snapshots created by the old single-directory configuration also require rebuilding.

```powershell
bun src\index.ts --config examples\config.json --wiki-update
bun src\index.ts --config examples\config.json "石墨仅需测比表面积，推荐设备、预处理条件和模板"
```

`--wiki-update` is an explicit, paid, tool-free model operation and exits after building. Changed source text is sent to the configured model provider; never put confidential documents there unless that provider is authorized to process them. Known configured model/API credentials are redacted, but arbitrary secrets cannot be recognized. Startup and chat never trigger ingestion. Sources are not modified. Only `.md` and `.txt` files are ingested, at most 100 files / 2 MiB total, each bounded by `resourceLimitBytes`; symlinks are rejected. Split larger documents first. Each extraction request is bounded by `modelTimeoutMs`; each source has a maximum of `maxSteps * 2` extraction calls. Ctrl+C cancels the update.

The initial implementation extracts reusable task/recommendation records, terms, facts with exact source-line quotations, and unresolved issues into `dataDir/wiki/snapshot.json`. It also exports a human-readable Markdown index under content-versioned `dataDir/wiki/revisions`. Content hashes skip unchanged sources; source removal invalidates the old snapshot. The source directory and extraction schema version are part of cache validity. Successful updates publish atomically; failures or cancellation retain the previous snapshot. An explicit update rebuilds malformed or schema-incompatible snapshots instead of using them as caches; queries continue to reject invalid snapshots until the rebuild succeeds. Whole-response JSON code fences and whitespace-only quotation formatting differences are accepted; stored quotations remain exact source substrings. Invalid JSON, schema failures and citation mismatches report their specific failure location without logging document/model payloads. On model output truncation, extraction automatically splits the requested source-line scope and merges only fully validated results. Each scoped request retains the complete numbered source as context for headings and inherited table cells. It never publishes partial knowledge. If even a single-line scope exceeds the output limit or the call budget is exhausted, the update fails with a specific diagnostic. Source changes block queries until an explicit update succeeds. For CLI updates, stop the service first because its exclusive data-directory lock prevents competing processes. While serving, use authenticated `POST /wiki/update` instead; only one update can run at a time. It waits for completion and returns `{sources, rebuilt, builtAt}`. The request body must be empty or `{}`; clients cannot override source paths or model settings. This is a paid model operation. Request cancellation and service shutdown cancel the update and retain the old snapshot; cancellation is propagated when the runtime signals the request abort. No SSE wiki update progress or background job endpoint is provided. Queries may read the previous published snapshot during an update, but changed sources still fail the freshness check.

No human approval step is required. Automatic validation checks JSON structure, record bounds and citation existence, **not scientific validity or whether every extracted value is semantically supported**. Current ingestion is source-local, not a cross-document contradiction resolver. The skill must expose ambiguities and conflicting recommendations, preserve ranges/units, and ask for missing values rather than create an executable configuration. `query_knowledge` uses bounded keyword/term matching (not vector retrieval), returns at most 10 records with facts, issues, source hashes and line citations, and requires a skill loaded in the current generation. Unknown queries return no match; ranking is not approval. This release does not map software API fields, validate executable templates, save configurations, or start instruments.

The design independently implements source immutability, incremental compilation and persistent knowledge patterns inspired by LLM Wiki; no GPL source code is copied into this implementation.

Internally, `src/shared/builtin.ts` collects and releases both skill/wiki resources; the build plugin replaces only its collector with embedded data while preserving runtime release logic. `src/shared/assets.ts` provides common collection, hashing and verification. Neither domain depends on the other. Wiki uses six cohesive modules: `index.ts` (public facade and query), `build.ts` (incremental build and model extraction), `knowledge.ts` (schema and parsing), `prompt.ts` (extraction instructions), `sources.ts` (source reading), and `snapshot.ts` (persistence/export). Configuration fields, source IDs, snapshot schema/version and generated paths are unchanged; existing valid snapshots remain usable.

## Built-in Skills

The root [skills](skills) directory contains built-in packages; examples remain under [examples/skills](examples/skills), and external skills are configured through `skillRoots`. The built-in `device-automation` package covers instrument automation workflows, currently wiki-backed material/test recommendations and template drafts, plus a virtual device automation simulator. It lists virtual devices and simulates status, power, and desk-lamp brightness operations. It never connects to or controls real hardware or networks, and simulated changes are not persisted.

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

Tools: `skill({ name })`, `read_skill_resource({ skill, path })`, `query_knowledge({ skill, query, limit? })`, `execute_skill_script({ skill, path, args })`, and `web_fetch({ url })`. Built-in definitions are centralized in `src/llm/tools/index.ts`: each spec declares its description, input schema, effects, and loaded-skill requirement. The registry supplies model tool declarations and validates/distributes execution; the LLM adapter handles only model requests. Existing skill and knowledge-query prerequisites remain unchanged.

`web_fetch` does not require a loaded skill. It retrieves public HTTP/HTTPS pages as text, not search results, with a 15-second total timeout, at most 3 redirects, a 1 MiB response limit, and at most 20,000 output characters. Local/private/reserved addresses, URL credentials, binary responses, and compressed responses are rejected. DNS destinations are checked and pinned to the connection; redirect destinations are rechecked. It sends no cookies or authentication. Never put secrets in URLs, and treat retrieved content as untrusted evidence, not instructions.

Following OpenCode's source implementation, the current names, descriptions, and SKILL.md locations appear in `<available_skills>` in dynamically generated system context. This context is refreshed from discovered skills for each model step and is not saved in the configured `systemPrompt`. The `skill` tool description stays short and refers to that catalog; do not copy the catalog into custom prompts. The former `list_skills` and `load_skill` tools are no longer available.

`skill` loads SKILL.md on demand and returns `{ name, directory, output }`. The model receives the instruction body (without YAML frontmatter) inside `<skill_content>`, the base directory, and a `<skill_files>` sample of up to 10 absolute resource paths. Listing does not read resource contents and excludes symbolic links; actual reads and executions still use the restricted tools. Its successful result is trusted local task guidance, subordinate to system instructions and runtime checks. Resources, script outputs, and tool errors remain untrusted data. A skill must be loaded in the current generation before its resources or scripts can be accessed; subsequent user messages start a new generation and require loading again.

This aligns the loading interface, not the entire OpenCode runtime. Auto-Agent retains explicit `skillRoots`, fail-closed discovery, and restricted resource/script tools; it does not add implicit home/project discovery, hot reload, generic shell execution, or OpenCode's allow/deny/ask permissions. Optional invocation metadata is validated but does not implement invocation policy or slash commands.

Script entries are confined to the selected skill's scripts/ directory; traversal, absolute paths, and symlinks are rejected. Arguments are passed as arrays. Commands written in SKILL.md must be translated into `execute_skill_script` parameters, not executed as shell strings. For example, `python scripts/report.py --summary` requires a configured `".py": "python"` interpreter and becomes `execute_skill_script({ skill: "example-skill", path: "scripts/report.py", args: ["--summary"] })`. Python is not configured by default.

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

Push a version tag such as `v0.1.0` to run the same Windows/Linux builds and binary acceptance tests. After both platform jobs pass, CI creates a GitHub Release with download/startup/integration help from [.github/release-notes.md](.github/release-notes.md), followed by generated change notes, and attaches `auto-agent.exe` and `auto-agent`. This template applies to new releases; previously published release descriptions are not automatically updated.

Source areas: src/agent, src/llm, src/skill, src/execution, src/storage, src/api, src/cli, and tests. Future device, experimental, analytical, and reporting skills require verified domain protocols and SDKs.
