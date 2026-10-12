# Auto-Agent

A local-first automation assistant for specific surface area and pore size analyzers, with trusted Agent Skills, persistent sessions, an interactive CLI, and an HTTP API. Built with Bun, TypeScript, LangGraph, Vercel AI SDK, and SQLite. The bundled device skill provides a formal analyzer workflow with wiki-backed recommendation drafts and persistent local instrument-interface simulation. Real instrument control requires an explicitly configured, documented integration; the bundled simulation script never connects to hardware or a network.

> Device control, experimental workflows, analytics, and reports are future skill integrations, not built-in features. This is not a complete OpenCode or OpenAI-compatible server.

## Requirements

- Bun **1.4.2**, installed as a system runtime (CI uses `oven-sh/setup-bun`); do not install the npm `bun` package in this project because its shim shadows the runtime in package scripts. Native SQLite requires Bun; Node.js cannot run the application directly.
- JavaScript skills retain their normal Node.js requirement. Auto-Agent prefers installed Node.js and automatically uses its embedded runtime when the bare `node`/`node.exe` command is unavailable; standalone users need not install it. Source runs still require Bun.
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

### File format, selection, and paths

Start with [examples/config.json](examples/config.json). Configuration must be a **strict JSON object**: comments, trailing commas, and JSONC are not supported. Field comments in [src/config/index.ts](src/config/index.ts) describe the defaults but are not written into the generated JSON. Omitted fields receive the defaults below; explicitly supplied values must pass validation. Maps such as `interpreters` replace the default map rather than merge with it, so include every extension you intend to use. Unknown fields are ignored; the obsolete `wikiDir` field is explicitly rejected (use `wikiRoots`).

Configuration selection is:

1. An explicit `--config PATH`, resolved from the current working directory. The file must already exist and be readable; it is not created automatically.
2. For `npm run dev`, the repository's [examples/config.json](examples/config.json).
3. For `npm run start` or installed executables, `~/.auto-agent/config.json` (on Windows, `%USERPROFILE%\.auto-agent\config.json`), created once if missing.

`dataDir`, `skillRoots`, and `wikiRoots` resolve relative to the **selected configuration file's directory**, not the working directory. Absolute paths are retained. `~` inside a JSON path is not expanded to the home directory. Windows backslashes must be escaped in JSON, for example `"C:\\Users\\user\\agent-data"`. Duplicate resolved wiki roots are removed.

The generated default file uses `"dataDir": "."`, placing data beside the configuration in `~/.auto-agent`. If `dataDir` is omitted from a custom file, it defaults to the absolute user `~/.auto-agent` directory instead. The generated file includes common editable fields only; other defaults are applied when loading. Existing explicit settings are never migrated or overwritten. Restart the process after editing configuration or changing environment variables.

### Data, skills, and knowledge

| Field           | Type     | Default                                     | Meaning                                                                                                                         |
| --------------- | -------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `dataDir`       | string   | `~/.auto-agent` (`.` in the generated file) | Persistent SQLite/session/checkpoint data and process ownership. Use separate directories for simultaneously running instances. |
| `skillRoots`    | string[] | `[]`                                        | Additional explicitly trusted skill roots. Skill scripts can execute locally; only add trusted directories.                     |
| `builtinSkills` | boolean  | `true`                                      | Load bundled skills in addition to external roots. Set `false` to use only configured roots.                                    |
| `wikiRoots`     | string[] | `[]`                                        | Additional wiki source roots used to build knowledge; independent of `skillRoots`.                                              |
| `builtinWiki`   | boolean  | `true`                                      | Include bundled wiki sources alongside configured roots. Set `false` to exclude them.                                           |

Empty external root arrays do not disable built-in content. Startup prints resolved skill roots and discovered skill/wiki names. Configuring wiki sources does not itself perform a paid knowledge build; see [Wiki knowledge and recommendation drafts](#wiki-knowledge-and-recommendation-drafts).

### HTTP binding and authentication

| Field         | Type    | Default          | Meaning / validation                                                                      |
| ------------- | ------- | ---------------- | ----------------------------------------------------------------------------------------- |
| `host`        | string  | `127.0.0.1`      | HTTP listen address. Recognized loopback values are `127.0.0.1`, `localhost`, and `::1`.  |
| `port`        | integer | `4096`           | HTTP port, from `0` to `65535`; `0` requests an available port.                           |
| `allowRemote` | boolean | `false`          | Required for non-loopback HTTP binding; does not provide TLS or disable authentication.   |
| `token`       | string  | No saved default | HTTP bearer token of at least 16 characters. `AUTO_AGENT_TOKEN` overrides the file value. |

The local REPL does not require an HTTP token. For HTTP, use `AUTO_AGENT_TOKEN` rather than saving credentials in a file. An empty or short environment token overrides even a valid file token and fails validation. `serve --no-token` disables authentication only on loopback, even with `allowRemote: true`; `noToken` in JSON cannot enable it. `configPath` is also runtime metadata, not a configurable field. HTTP listen settings do not expose the REPL as a server.

### Web address access

`webAllowPrivateAddresses` is a boolean, **default `true`**. It applies to both `web_fetch` and `web_search`, including resolved DNS addresses, redirects and search-result links. It permits loopback/localhost, private IPv4/IPv6 and reserved addresses such as Mihomo/Clash Fake-IP `198.18.0.0/15`. Set it to `false` to restore public-internet-only access. Omitted fields use the default; existing explicit `false` values remain unchanged. Restart Auto-Agent after changing configuration.

**Risk:** enabling this permits the model to reach local services, internal networks and metadata endpoints through web tools, including redirects from external pages. Use only in trusted deployments; set `false` for untrusted users or prompts. The setting does not enable non-HTTP protocols, URL credentials, cookies or proxy credentials; DNS pinning, TLS validation, redirect counts, timeouts and response/output limits remain enforced. It is independent of inbound HTTP `allowRemote`.

### Model and prompt

| Field          | Type             | Default                               | Meaning / validation                                                                                                                                                             |
| -------------- | ---------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`        | string           | `deepseek-flash`                      | Provider model identifier; choose one available at `baseURL`.                                                                                                                    |
| `baseURL`      | string (URL)     | `https://api.deepseek.com`            | OpenAI-compatible provider endpoint; must be a valid URL.                                                                                                                        |
| `systemPrompt` | string           | Project-specific analyzer role prompt | Up to 16000 characters. Non-empty text replaces the default role prompt; the mandatory runtime contract is still appended. Empty/whitespace-only text falls back to the default. |
| `apiKey`       | Environment only | Unset                                 | Set `AUTO_AGENT_API_KEY`. An `apiKey` field in JSON is ignored, not used as a fallback.                                                                                          |

Only `AUTO_AGENT_API_KEY` and `AUTO_AGENT_TOKEN` override their corresponding loaded values. Other fields use JSON values or schema defaults; there is no general environment-variable mapping. Missing model credentials produce a startup warning; a usable provider/model/key is required for paid model requests. Do not commit credentials or place them in `systemPrompt` or `scriptEnv`.

### Budgets, timeouts, and limits

All fields below require positive integers; `maxSteps` additionally cannot exceed `100`. Timeouts are in **milliseconds**, byte limits in **bytes**, and token budgets in **tokens**.

| Field                | Default  | Meaning                                                                                                                                                                                                                               |
| -------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxSteps`           | `12`     | Maximum model/tool-loop steps for a generation (`1`–`100`).                                                                                                                                                                           |
| `maxTokens`          | `128000` | Cumulative reported model input + output token budget for one generation; excludes background title requests. Missing/invalid chat usage stops the generation before pending tools execute; it is never counted as zero or estimated. |
| `maxContextTokens`   | `16000`  | Estimated input budget for each model request, including tool definitions; not an output limit.                                                                                                                                       |
| `modelTimeoutMs`     | `60000`  | Model request timeout. Title requests use the shorter of this and 15000 ms.                                                                                                                                                           |
| `scriptTimeoutMs`    | `30000`  | Skill script execution timeout.                                                                                                                                                                                                       |
| `outputLimitBytes`   | `65536`  | Combined stdout/stderr limit for one script execution.                                                                                                                                                                                |
| `resourceLimitBytes` | `65536`  | Skill resource read limit, individual wiki source limit, and complete serialized wiki query-response limit (including metadata and warnings).                                                                                         |
| `requestLimitBytes`  | `65536`  | HTTP request-body limit and submitted user-message content limit (UTF-8 bytes).                                                                                                                                                       |
| `maxConcurrent`      | `4`      | Concurrent generation capacity and script execution budget. Background titles have a separate budget of this size. Only one generation may run per session.                                                                           |

### Script interpreters and environment

| Field          | Type                      | Default                                                      | Meaning                                                                                       |
| -------------- | ------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `interpreters` | object with string values | `{ ".js": "node", ".sh": "bash", ".ps1": "powershell.exe" }` | Script extension → executable name or path. This map replaces, rather than extends, defaults. |
| `scriptEnv`    | object with string values | `{}`                                                         | Extra environment entries for skill scripts, subject to execution-time validation.            |

Bare `node`/`node.exe` prefers installed Node.js and falls back to the embedded Bun runtime only if Node is unavailable. `builtin` explicitly selects the embedded runtime. Other executable names or paths remain external and must be installed; values are executable names/paths, not shell command lines with arguments. Interpreter paths are not resolved by the configuration loader relative to the JSON file; use absolute paths for custom executables. A missing extension is not executable, and script failures are never retried under another runtime.

Scripts inherit only `PATH`, `SystemRoot`, `TEMP`, `TMP`, and `TMPDIR` when available, plus validated `scriptEnv` entries—not the full parent environment. Entry names must be valid environment identifiers. Credential-like names, runtime/search-path controls (such as `PATH`, `NODE_OPTIONS`, and `BUN_OPTIONS`), NUL values, and values containing model or bearer credentials are rejected. Use `scriptEnv` for non-secret skill-specific settings, not credentials.

### Custom configuration example

This strict JSON example is a complete local setup without saved credentials. Save it as a custom configuration and pass its path with `--config`; its relative directories are anchored to that file.

```json
{
  "dataDir": "./data",
  "skillRoots": [],
  "builtinSkills": true,
  "wikiRoots": [],
  "builtinWiki": true,
  "host": "127.0.0.1",
  "port": 4096,
  "allowRemote": false,
  "model": "deepseek-flash",
  "baseURL": "https://api.deepseek.com",
  "systemPrompt": "",
  "maxSteps": 12,
  "maxTokens": 128000,
  "maxContextTokens": 16000,
  "modelTimeoutMs": 60000,
  "scriptTimeoutMs": 30000,
  "outputLimitBytes": 65536,
  "resourceLimitBytes": 65536,
  "requestLimitBytes": 65536,
  "maxConcurrent": 4,
  "interpreters": {
    ".js": "node",
    ".sh": "bash",
    ".ps1": "powershell.exe"
  },
  "scriptEnv": {}
}
```

### Token accounting and prompt behavior

`maxTokens` is a cumulative paid-use limit across a generation, not the model's context-window size: every request's reported input and output are counted, including repeated instructions. `maxContextTokens` separately estimates each request's input with UTF-8 bytes/3 (not a provider tokenizer). When needed, earlier conversation/tool-result groups are omitted together, while current requests, loaded skill instructions, referenced resources, latest cited knowledge, and newest results remain intact. Oversized essential context fails before a model request rather than truncating evidence. Checkpoints retain the full audit history. CLI progress shows per-step tokens and cumulative `run used/limit`; exceeding a limit never executes that turn's pending tools. Existing explicit limits are not migrated automatically; update configuration and restart.

Cloud credentials come only from AUTO_AGENT_API_KEY. Do not commit secrets or place them in systemPrompt. Restart after configuration changes. The default prompt focuses Auto-Agent on specific surface area and pore size analyzer tasks and workflows: skill-grounded capabilities, essential sample/method clarification, prerequisite and instrument-state checks, ordered execution, completion evidence, analysis-method distinctions, data traceability, and operator reconciliation. It distinguishes simulations from real instrument results and command acceptance from experiment completion; it does not supply instrument procedures or add hardware capabilities. The runtime contract requires reading loaded skill guidance before dependent calls, treats historical skill mentions as unloaded, uses resource/tool content as evidence rather than overriding instructions, and distinguishes process exit success from instrument completion. Empty prompts fall back to this project-specific default; non-empty custom prompts replace the role prompt but retain the appended runtime contract and cannot bypass tool restrictions. Startup prints the resolved skill roots and discovered names so missing configuration is distinguishable from a model refusing or overlooking a skill.

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

The initial implementation extracts reusable task/recommendation records, terms, facts with exact source-line quotations, and unresolved issues into `dataDir/wiki/snapshot.json`. It also exports a human-readable Markdown index under content-versioned `dataDir/wiki/revisions`. Content hashes skip unchanged sources; source removal invalidates the old snapshot. The source directory and extraction schema version are part of cache validity. Successful updates publish atomically; failures or cancellation retain the previous snapshot. An explicit update rebuilds malformed or schema-incompatible snapshots instead of using them as caches; queries continue to reject invalid snapshots until the rebuild succeeds. Whole-response JSON code fences and whitespace-only quotation formatting differences are accepted; stored quotations remain exact source substrings. Invalid JSON, schema failures and citation mismatches report their specific failure location without logging document/model payloads. On model output truncation, extraction automatically splits the requested source-line scope and merges only fully validated results. Each scoped request retains the complete numbered source as context for headings and inherited table cells; each returned record must have at least one non-whitespace source quotation within its requested range, while earlier inherited citations remain allowed. Duplicate record identities (same title, fact values and cited source lines, regardless of alias/issue differences or field order) are rejected, including during split merges and snapshot loading. Historical snapshots containing such duplicates require an explicit rebuild. It never publishes partial knowledge. If even a single-line scope exceeds the output limit or the call budget is exhausted, the update fails with a specific diagnostic. Source changes block queries until an explicit update succeeds. For CLI updates, stop the service first because its exclusive data-directory lock prevents competing processes. While serving, use authenticated `POST /wiki/update` instead; only one update can run at a time. It waits for completion and returns `{sources, rebuilt, builtAt}`. The request body must be empty or `{}`; clients cannot override source paths or model settings. This is a paid model operation. Request cancellation and service shutdown cancel the update and retain the old snapshot; cancellation is propagated when the runtime signals the request abort. No SSE wiki update progress or background job endpoint is provided. Queries may read the previous published snapshot during an update, but changed sources still fail the freshness check.

No human approval step is required. Automatic validation checks JSON structure, record bounds and citation existence, **not scientific validity or whether every extracted value is semantically supported**. Current ingestion is source-local, not a cross-document contradiction resolver. The skill must expose ambiguities and conflicting recommendations, preserve ranges/units, and ask for missing values rather than create an executable configuration. `wiki` uses prepared keyword retrieval over record titles, terms, fact labels/values, and source filenames (not vector retrieval), returns at most 10 records with facts, issues, source hashes and line citations, and requires a skill loaded in the current generation. Unmatched queries return `no_match` with `indexedRecords` and, when the response budget permits, `availableTerms` and a refinement hint; matches too large to return use `output_limit`, not `no_match`. The entire serialized response must fit `resourceLimitBytes`, including metadata and the evidence warning. Optional terms/hints may be shortened or omitted; an impossible metadata budget raises `wiki_output_limit` (HTTP 400) rather than returning an oversized successful response. Error responses are not wiki query-result payloads. Responses declare `mode: "keyword"` and `matchedRecords`; `truncated` indicates either a result-count or byte limit, including omitted diagnostics. Each result adds `match` with hit fields/tokens, phrase/filename indicators, and a bounded preview with existing source-line references. Ranking and match indicators are not approval. This release does not map software API fields, validate executable templates, save configurations, or start instruments.

The design independently implements source immutability, incremental compilation and persistent knowledge patterns inspired by LLM Wiki; no GPL source code is copied into this implementation.

Keyword retrieval adapts the reference project's normalization, Chinese token expansion, title/filename/phrase weighting, bounded phrase-frequency bonuses, and anchored previews to compiled recommendation records. Query tokens are prepared once with NFKC/case/whitespace normalization, Latin word and numeric-unit boundaries, and Chinese words/bigrams/characters. Only function words are excluded; domain terms such as `材料`, `推荐`, `条件`, and `测试` remain searchable. Chinese character hits have low weight and cannot alone admit a longer query. Exact filename, title phrases, and exact aliases outrank ordinary content hits; phrase occurrence bonuses saturate to prevent repeated text flooding. Equal scores sort by source then title. At most 256 unique tokens are used (`queryTruncated` reports this limit), hit metadata is bounded, and previews retain original text (up to 220 code points plus ellipses). Source issues and citation quotations are not indexed as unrelated recommendation evidence; original facts and citations remain unchanged. No embedding configuration, vector calls, graph retrieval, or new model requests are introduced.

Internally, `src/shared/builtin.ts` collects and releases both skill/wiki resources; the build plugin replaces only its collector with embedded data while preserving runtime release logic. `src/shared/assets.ts` provides common collection, hashing and verification. Neither domain depends on the other. Wiki uses seven cohesive modules: `index.ts` (public facade and query), `search.ts` (weighted lexical ranking), `build.ts` (incremental build and model extraction), `knowledge.ts` (schema and parsing), `prompt.ts` (extraction instructions), `sources.ts` (source reading), and `snapshot.ts` (persistence/export). Configuration fields, source IDs, snapshot schema/version and generated paths are unchanged; existing valid snapshots remain usable.

## Built-in Skills

The root [skills](skills) directory contains built-in packages; examples remain under [examples/skills](examples/skills), and external skills are configured through `skillRoots`. 内置 `device-automation` 技能采用中文说明，围绕“理解用户需求 → 根据知识来源匹配已有模板或生成新模板 → 下发自动化设备 → 运行任务 → 获取结果”组织比表面积与孔径分析流程。`references/interfaces.md` 描述通用设备接口契约：设备发现与状态查询、模板列出/读取/创建、测量提交与监控/控制、结果获取和报告导出。技能不假定 `wiki`、`read`、`execute_script` 等工具存在，也不绑定宿主专用目录；资料读取、检索和接口调用使用宿主实际提供的能力。不提供独立模板校验命令；保存和提交保留必要的接口输入约束。以下部署说明仅针对本项目随附的 `scripts/instrument.js` 当前实现，不是通用技能要求；接口契约本身不代表硬件已经连接。 The former desk-lamp/plug/thermostat demonstration and `scripts/device.js` have been removed.

The backend is explicitly simulation-only, although individual JSON responses omit a `simulated` flag to exercise interface-style schemas. IDs/models identify fixture instruments; generated results are not properties measured from a real sample. Templates/tasks persist under `<user-home>/.auto-agent/simulated-instruments` by default; operators can set an absolute `AUTO_AGENT_SIMULATION_DIR` through `scriptEnv`. State (`simulation-state.json`) and exported reports preserve backend provenance and stay separate from real experiment data and bundled skill directories. Tasks complete by elapsed simulation time (default 1,000 ms, configurable using `AUTO_AGENT_SIMULATION_DURATION_MS`, 1–600,000 ms), without background processes; reads do not modify state. Mutations are exclusively locked and atomically published; busy/corrupt state fails closed. No reset, arbitrary report path, or implicit overwrite is supported. Saving enforces interface fields and fixture capabilities, but does not provide a separate template-validation service or scientific/hardware approval. Saving/submission/control/export need authorized scope, and uncertain effects must not be retried automatically.

`builtinSkills` defaults to `true`. Source runs read every UTF-8 file under the root `skills` directory, relative to the source module rather than the launch directory. The `build:windows` and `build:linux` commands use a Bun build plugin to embed the same resources into standalone executables; no generated source files or `pre*` hooks are required. Both modes release a content-versioned copy under `dataDir/builtin-skills/<version>` before discovery. No `skillRoots` configuration is needed for `device-automation`; its interface script remains a standard Node.js skill script. Auto-Agent keeps `.js: "node"`, uses installed Node.js when available, and falls back to its embedded runtime only when that bare command is missing. No skill-specific execution branch or change to the skill's dependency declaration is required. Explicit `.js: "builtin"` remains available to operators; errors from a launched script are never retried using another runtime. Do not confuse the bundled simulation backend with a real instrument adapter. Built-ins use the same metadata/path validation, execution limits, audit, and cancellation as configured skills.

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

Tools: `skill({ name })`, `read({ skill, path })`, `wiki({ skill, query, limit? })`, `execute_script({ skill, path, args })`, `web_fetch({ url })`, and `web_search({ query, limit? })`. `src/tool/index.ts` registers definitions from `src/tool/tools/`: each tool co-locates its description, input schema, effects, loaded-skill requirement and execution function. `src/tool/context.ts` describes injected service capabilities, network policy and generation-scoped signal/loaded-skill/failed-script state. The registry supplies declaration-only model tools and validates/distributes execution; the SDK does not automatically execute them. Agent owns scheduling, budgets, events, output redaction, model messages and fatal-outcome handling, without a separate per-tool handler map. Script tooling owns execution audit and replay protection; unknown outcomes stop dependent tools and require operator reconciliation, and audit finalization is attempted only once. The LLM adapter handles only model requests. Skill/resource prerequisites remain enforced.

`src/agent/builtins.ts` supplies refreshed built-in facts before each chat-model request: current local date, UTC timestamp, time zone, process working directory, nearest ancestor Git project marker/root, operating system, platform, architecture and runtime version. Directory discovery recognizes `.git` directories and worktree marker files without executing Git; inaccessible markers are reported as unknown. These describe the agent host, not an instrument or script working directory, and grant no filesystem permissions. The snapshot is escaped, redacted, included in the context budget and replaced on every request rather than appended to conversation history. Custom role prompts retain the same runtime contract and built-in facts. Credentials and arbitrary environment variables are not enumerated.

`web_fetch` does not require a loaded skill. It retrieves HTTP/HTTPS pages as text, not search results, with a 15-second total timeout, at most 3 redirects, a 1 MiB response limit, and at most 20,000 output characters. Address access follows `webAllowPrivateAddresses` (default `true`); `false` rejects local/private/reserved destinations. URL credentials, binary responses, and compressed responses are always rejected. DNS destinations are checked and pinned to the connection; redirect destinations are rechecked. It sends no cookies or authentication. Never put secrets in URLs, and treat retrieved content as untrusted evidence, not instructions.

`web_search` uses OpenCode's Exa MCP approach: POST `tools/call` → `web_search_exa` at `https://mcp.exa.ai/mcp`, accepting JSON or SSE replies instead of scraping search-engine HTML. It does not require a loaded skill. Set the optional `EXA_API_KEY` environment variable on the service host before launching Auto-Agent to authenticate (as in OpenCode); the model's `AUTO_AGENT_API_KEY` is not reused. Without an Exa key it uses anonymous access; availability and quotas are not guaranteed. Exa may return a free-MCP quota message inside an HTTP-200 tool response, even without `isError`; this is reported as `WEB_SEARCH_RATE_LIMIT`, not a result-layout error. Wait for the quota to reset or configure an Exa key rather than repeatedly changing search terms. Queries contain 1–1,000 characters; `limit` is 1–10 (default 5). Results include titles, URLs and snippets, bounded to 16 KiB overall. Search retains DNS/address-policy/TLS checks with a 15-second deadline and 256 KiB response cap; POST redirects are rejected so queries are not forwarded to another host. Selected pages can then be read with `web_fetch`. Search snippets are unverified leads, not cited scientific recommendations or instructions. Never send private documents, secrets or sample identifiers. Authentication, quota, protocol and transport failures produce explicit errors, not fabricated empty results. Neither tool opens a local browser. Adapted MIT license text is bundled and available through `--licenses`.

Mihomo/Clash Fake-IP DNS may resolve public domains to reserved `198.18.0.0/15` addresses. With `webAllowPrivateAddresses: false`, both tools reject these destinations; `WEB_FORBIDDEN_ADDRESS` now explains the DNS issue, including through `web_search` (rather than hiding it as `WEB_SEARCH_FETCH`). Search distinguishes DNS (`WEB_SEARCH_DNS`), connection (`WEB_SEARCH_NETWORK`) and timeout (`WEB_SEARCH_TIMEOUT`) failures without exposing raw network diagnostics or claiming a provider outage. Configure the proxy client to return real public DNS addresses (for example `dns.enhanced-mode: redir-host`), apply/reload that configuration, and verify DNS resolution before retrying. Alternatively, `webAllowPrivateAddresses: true` (the default) permits Fake-IP and all other private/reserved destinations, with the risks described above. Allowing Fake-IP alone does not guarantee the proxy routes pinned connections successfully. Auto-Agent does not modify proxy configuration or forward proxy credentials.

Following OpenCode's source implementation, the current names, descriptions, and SKILL.md locations appear in `<available_skills>` in dynamically generated system context. This context is refreshed from discovered skills for each model step and is not saved in the configured `systemPrompt`. The `skill` tool description stays short and refers to that catalog; do not copy the catalog into custom prompts. The former `list_skills` and `load_skill` tools are no longer available.

`skill` loads SKILL.md on demand and returns `{ name, directory, output }`. The model receives the instruction body (without YAML frontmatter) inside `<skill_content>`, the base directory, and a `<skill_files>` sample of up to 10 absolute resource paths. Listing does not read resource contents and excludes symbolic links; actual reads and executions still use the restricted tools. Its successful result is trusted local task guidance, subordinate to system instructions and runtime checks. Resources, script outputs, and tool errors remain untrusted data. A skill must be loaded in the current generation before its resources or scripts can be accessed; subsequent user messages start a new generation and require loading again.

This aligns the loading interface, not the entire OpenCode runtime. Auto-Agent retains explicit `skillRoots`, fail-closed discovery, and restricted resource/script tools; it does not add implicit home/project discovery, hot reload, generic shell execution, or OpenCode's allow/deny/ask permissions. Optional invocation metadata is validated but does not implement invocation policy or slash commands.

Script entries are confined to the selected skill's scripts/ directory; traversal, absolute paths, and symlinks are rejected. Arguments are passed as arrays. Commands written in SKILL.md must be translated into `execute_script` parameters, not executed as shell strings. For example, `python scripts/report.py --summary` requires a configured `".py": "python"` interpreter and becomes `execute_script({ skill: "example-skill", path: "scripts/report.py", args: ["--summary"] })`. Python is not configured by default.

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

Prettier enforces formatting. Outputs: dist/auto-agent.exe (Windows x64) and dist/auto-agent (Linux x64). Configuration and optional external interpreters remain operator-managed; built-in skill/wiki assets, the JavaScript runtime, and public documentation are embedded in the binary. Cross-compilation is not Linux runtime acceptance; platform CI validates native runs. Tests use model doubles/local HTTP mocks, never live cloud calls by default.

Push a version tag such as `v0.1.0` to run the same Windows/Linux builds and binary acceptance tests. After both platform jobs pass, CI creates a GitHub Release with download/startup/integration help from [.github/release-notes.md](.github/release-notes.md), followed by generated change notes, and attaches `auto-agent.exe` and `auto-agent`. This template applies to new releases; previously published release descriptions are not automatically updated.

Source areas: src/agent, src/llm, src/skill, src/execution, src/storage, src/api, src/cli, and tests. Future device, experimental, analytical, and reporting skills require verified domain protocols and SDKs.
