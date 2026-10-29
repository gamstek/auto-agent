# Auto-Agent

A local-first automation assistant for specific surface area and pore size analyzers, with trusted Agent Skills, persistent sessions, an interactive CLI, and an HTTP API. Built with Bun, TypeScript, LangGraph, Vercel AI SDK, and SQLite. The bundled device skill provides a formal analyzer workflow with wiki-backed recommendation drafts and persistent local instrument-interface simulation. Real instrument control requires an explicitly configured, documented integration; the bundled simulation script never connects to hardware or a network.

> Device control, experimental workflows, analytics, and reports are future skill integrations, not built-in features. This is not a complete OpenCode or OpenAI-compatible server.

## Requirements

- Bun **1.4.2**, installed as a system runtime (CI uses `oven-sh/setup-bun`); do not install the npm `bun` package in this project because its shim shadows the runtime in package scripts. Native SQLite requires Bun; Node.js cannot run the application directly.
- JavaScript skills retain their normal Node.js requirement. Auto-Agent prefers installed Node.js and automatically uses its embedded runtime when the bare `node`/`node.exe` command is unavailable; standalone users need not install it. Source runs still require Bun.
- Windows PowerShell and native process snapshots on Windows for owned-process tracking. Native signatures are emitted in memory without invoking a C# compiler or writing compiler temporary files per execution. The tracker uses .NET APIs with PowerShell module autoload disabled, avoiding cmdlet discovery in its sanitized environment.
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

| Field            | Type     | Default                                     | Meaning                                                                                                                         |
| ---------------- | -------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `dataDir`        | string   | `~/.auto-agent` (`.` in the generated file) | Persistent SQLite/session/checkpoint data and process ownership. Use separate directories for simultaneously running instances. |
| `skillRoots`     | string[] | `[]`                                        | Additional explicitly trusted skill roots. Skill scripts can execute locally; only add trusted directories.                     |
| `builtinSkills`  | boolean  | `true`                                      | Load bundled skills in addition to external roots. Set `false` to use only configured roots.                                    |
| `wikiRoots`      | string[] | `[]`                                        | Additional wiki source roots used to build knowledge; independent of `skillRoots`.                                              |
| `wikiIndexRoots` | string[] | `[]`                                        | Wiki source files for native-format local indexing via explicit `--wiki-index`; no model extraction.                            |
| `builtinWiki`    | boolean  | `true`                                      | Include bundled wiki sources alongside configured roots. Set `false` to exclude them.                                           |

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

| Field          | Type             | Default                      | Meaning / validation                                                                                                                                                                                                             |
| -------------- | ---------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`        | string           | `deepseek-flash`             | Provider model identifier; choose one available at `baseURL`.                                                                                                                                                                    |
| `baseURL`      | string (URL)     | `https://api.deepseek.com`   | OpenAI-compatible provider endpoint; must be a valid URL.                                                                                                                                                                        |
| `systemPrompt` | string           | `""` (current built-in role) | Up to 16000 characters. Non-empty text replaces the default role prompt; tool guidance is still appended, and skill guidance and host facts are injected independently. Empty/whitespace-only text follows the built-in default. |
| `apiKey`       | Environment only | Unset                        | Set `AUTO_AGENT_API_KEY`. An `apiKey` field in JSON is ignored, not used as a fallback.                                                                                                                                          |

Only `AUTO_AGENT_API_KEY` and `AUTO_AGENT_TOKEN` override their corresponding loaded values. Other fields use JSON values or schema defaults; there is no general environment-variable mapping. Missing model credentials produce a startup warning; a usable provider/model/key is required for paid model requests. Do not commit credentials or place them in `systemPrompt` or `scriptEnv`.

### Budgets, timeouts, and limits

All fields below require positive integers; `maxSteps` additionally cannot exceed `100`. Timeouts are in **milliseconds**, byte limits in **bytes**, and token budgets in **tokens**.

| Field                | Default   | Meaning                                                                                                                                                     |
| -------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxSteps`           | `12`      | Maximum model/tool-loop steps for a generation (`1`–`100`).                                                                                                 |
| `maxInputTokens`     | `1000000` | Maximum input (prompt) tokens supported by the model. Optional when `contextWindow` is set; derived as `contextWindow - maxOutputTokens`.                   |
| `maxOutputTokens`    | `16000`   | Maximum output tokens supported by the model; passed as the output cap to AI SDK.                                                                           |
| `contextWindow`      | unset     | Optional combined model input/output capacity. Must accommodate `maxInputTokens + maxOutputTokens`; not inferred from the SDK.                              |
| `modelTimeoutMs`     | `60000`   | Model request timeout. Title requests use the shorter of this and 15000 ms.                                                                                 |
| `scriptTimeoutMs`    | `30000`   | Skill script execution timeout.                                                                                                                             |
| `outputLimitBytes`   | `65536`   | Combined stdout/stderr limit for one script execution.                                                                                                      |
| `resourceLimitBytes` | `65536`   | Skill resource read limit, individual wiki source limit, and complete serialized wiki query-response limit (including metadata and warnings).               |
| `requestLimitBytes`  | `65536`   | HTTP request-body limit and submitted user-message content limit (UTF-8 bytes).                                                                             |
| `maxConcurrent`      | `4`       | Concurrent generation capacity and script execution budget. Background titles have a separate budget of this size. Only one generation may run per session. |

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
  "maxInputTokens": 1000000,
  "maxOutputTokens": 16000,
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

`maxInputTokens` and `maxOutputTokens` describe the maximum input/output capacities supported by the configured model, not measured consumption or cumulative run budgets. Set these values according to the provider's model specification. When `contextWindow` is supplied without `maxInputTokens`, input capacity is derived as `contextWindow - maxOutputTokens`; inconsistent or nonpositive capacities are rejected. If neither input capacity nor context window is set, the application retains its 1,000,000-token input default. AI SDK 7 reports actual `usage.inputTokens`, `usage.outputTokens` and `usage.totalTokens` after each request; input includes repeated instructions/history and output includes provider-reported reasoning tokens. Missing/invalid usage stops dependent tools; estimates never substitute for reported usage. Cumulative run usage is displayed for observation (including summary calls), not enforced as an additional limit. The SDK does not expose a universal model context-window length or automatically compress chat history: select input/output limits compatible with the provider's model window.

Before chat requests, Auto-Agent estimates input using UTF-8 bytes/3 (not an exact provider tokenizer). At 90% of `maxInputTokens`, it makes explicit tool-free model calls to summarize older history; summary calls are paid, subject to the same input/output limits, bounded in count, and cancellable. System rules, loaded skill instructions/resources, current requests, recent evidence and complete tool-call/result groups remain protected. Historical summaries are marked as untrusted data, not new instructions, and can be summarized again later. If essential context or a complete historical group cannot fit, summary generation fails, or the resulting summary cannot fit, execution stops instead of silently truncating evidence or running dependent tools. Checkpoints retain audit history. CLI/events distinguish estimated input from SDK-reported input/output/total usage. Replace legacy `maxTokens`/`maxContextTokens` settings with the two new settings and restart; legacy settings are rejected rather than silently ignored.

Cloud credentials come only from AUTO_AGENT_API_KEY. Restart after configuration changes. Prompt responsibilities and injection order are documented in [docs/prompts.md](docs/prompts.md). Each chat step uses one selected role plus tool guidance, refreshed host facts, and skill guidance with the current catalog; each module owns its prompt, and tool descriptions/schemas are supplied separately. The default role distinguishes preset automation workflows from direct instrument control, preserves source-grounded recommendations and reports concise verified outcomes. Skills own concrete procedures and reference contracts own fields/units. New generated configurations store systemPrompt as an empty string to follow built-in role updates; an explicit custom role replaces the default without removing runtime checks. Existing configuration text is preserved; set systemPrompt to an empty string to adopt the current built-in role.

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

Events include session.status, model.started/completed/failed, message.part.delta, message.reasoning.delta, tool.started/completed/failed, session.title.started/failed, session.updated, message.completed, and session.error. See [llm.txt](llm.txt) for fields. Events omit raw script output and full arguments.

模型请求使用官方 `@ai-sdk/openai-compatible` 适配器，其将 Chat Completions 的 `reasoning_content` 字段（如 DeepSeek）转换为 SDK 标准 reasoning 增量。模型返回的 reasoning 内容通过 `message.reasoning.delta` 独立流式展示。终端普通聊天模式用 stderr 上的 `think >` 区域逐片输出思考，无需等待换行，并过滤跨分片的终端控制序列；回答正文仍输出到 stdout。`--json` 保持消息 JSON 输出，不展示 reasoning。两条流分别进行凭据脱敏，取消后停止发送。

Reasoning 作为独立的 SDK 协议内容保留在工具调用上下文和检查点中，完成回答的 reasoning 另存于 SQLite 私有元数据，后续对话及重启恢复时随对应 assistant 消息回传，以满足 DeepSeek thinking 工具调用合同。它计入上下文及历史读取预算，但不混入回答正文，也不出现在公开消息历史、同步最终回复或 `--json` 中。压缩保留的工具调用/结果组包含原 reasoning；合成的历史摘要使用标记为不可信数据的 user 消息，不冒充缺失 reasoning 的模型输出。是否有内容取决于模型及服务商实际返回，本功能不会额外开启服务商的 thinking 模式。

No event replay exists. Each client has a 64-frame queue; subscriber capacity is maxConcurrent * 8. Disconnecting SSE does not cancel generation. Read history after reconnecting; **do not blindly resubmit ambiguous side-effecting tasks**. A synchronous response contains only the final reply. Client applications must render raw Markdown safely, not as trusted HTML.

There is no /v1/chat/completions, business /runs, /devices, or /skills endpoint, third-party browser CORS configuration, or OpenAPI service.

## Wiki knowledge and recommendation drafts

The root [wiki](wiki) directory is **built-in wiki**, parallel to [skills](skills), and is embedded into standalone binaries. `builtinWiki` defaults to `true`; `wikiRoots` defaults to `[]` and lists additional operator-selected directories of UTF-8 Markdown/text sources. Relative external paths resolve against the configuration file. The example and installed configurations use bundled wiki only, not arbitrary files from the working directory. The former `wikiDir` field is rejected with migration guidance: use `wikiRoots` for external documents, never add the built-in root again.

Built-in sources and their validated analyzed knowledge are embedded together. With bundled wiki alone, a new installation is immediately ready and can query recommendations without --wiki-update or a model call. Text resources are content-verified under dataDir/builtin-wiki/<version>. Edit [wiki/sources](wiki/sources) and update [wiki/knowledge/recommendations.json](wiki/knowledge/recommendations.json) before builds, which reject stale analysis. Human directory documentation and binary indexes are not ingested as knowledge sources. Existing builtin/<path> recommendation IDs remain stable despite the physical directory reorganization. Explicit model updates combine configured wikiRoots with bundled recommendations; startup/chat never perform paid ingestion.

```powershell
bun src\index.ts --config examples\config.json --wiki-update
bun src\index.ts --config examples\config.json "石墨仅需测比表面积，推荐设备、预处理条件和模板"
```

`--wiki-update` is an explicit, potentially paid, tool-free model operation and exits after building. Unchanged bundled analysis is reused without a request; changed or external source text is sent to the configured model provider. Never put confidential documents there unless that provider is authorized to process them. Known configured model/API credentials are redacted, but arbitrary secrets cannot be recognized. Startup and chat never trigger ingestion. Sources are not modified. Only `.md` and `.txt` files are ingested, at most 100 files / 2 MiB total, each bounded by `resourceLimitBytes`; symlinks are rejected. Split larger documents first. Each extraction request is bounded by `modelTimeoutMs` (default 60,000 ms); a timeout reports `wiki_timeout` (HTTP 504), the source and configured duration, and preserves the previous snapshot. For slow knowledge extraction, increase `modelTimeoutMs` in the selected configuration (for example, to `180000`) or split the source, then explicitly retry `--wiki-update`; timed-out requests are not retried automatically. Each source has a maximum of `maxSteps * 2` extraction calls. Ctrl+C cancels the update.

The compiled recommendation snapshot is [wiki/knowledge/recommendations.json](wiki/knowledge/recommendations.json). Explicit updates publish validated source-cited records atomically to dataDir/wiki/snapshot.json and export a human-readable revision. Hashes skip unchanged sources; changed/removed sources invalidate queries until a successful explicit update. Failures/cancellation retain the previous snapshot. Extraction accepts complete JSON fences and formatting-only quote differences, validates exact line citations and duplicate identities, and splits truncated output into bounded source-line scopes without publishing partial knowledge. Complete tool-free summary/extraction requests remain bounded by input/output limits. Stop the service before CLI updates, or use authenticated POST /wiki/update with an empty body or {} while serving. It waits for {sources, rebuilt, builtAt}; concurrent updates are rejected, and cancellation/shutdown preserve the previous snapshot. No progress SSE or automatic ingestion is provided.

No human approval step is required. Automatic validation checks JSON structure, record bounds and citation existence, **not scientific validity or whether every extracted value is semantically supported**. Current ingestion is source-local, not a cross-document contradiction resolver. The skill must expose ambiguities and conflicting recommendations, preserve ranges/units, and ask for missing values rather than create an executable configuration. `wiki` uses prepared keyword retrieval over record titles, terms, fact labels/values, and source filenames (not vector retrieval), returns at most 10 records with facts, issues, source hashes and line citations, and requires a skill loaded in the current generation. Unmatched queries return `no_match` with `indexedRecords` and, when the response budget permits, `availableTerms` and a refinement hint; matches too large to return use `output_limit`, not `no_match`. The entire serialized response must fit `resourceLimitBytes`, including metadata and the evidence warning. Optional terms/hints may be shortened or omitted; an impossible metadata budget raises `wiki_output_limit` (HTTP 400) rather than returning an oversized successful response. Error responses are not wiki query-result payloads. Responses declare `mode: "keyword"` and `matchedRecords`; `truncated` indicates either a result-count or byte limit, including omitted diagnostics. Each result adds `match` with hit fields/tokens, phrase/filename indicators, and a bounded preview with existing source-line references. Ranking and match indicators are not approval. This release does not map software API fields, validate executable templates, save configurations, or start instruments.

The design independently implements source immutability, incremental compilation and persistent knowledge patterns inspired by LLM Wiki; no GPL source code is copied into this implementation.

Keyword retrieval adapts the reference project's normalization, Chinese token expansion, title/filename/phrase weighting, bounded phrase-frequency bonuses, and anchored previews to compiled recommendation records. Query tokens are prepared once with NFKC/case/whitespace normalization, Latin word and numeric-unit boundaries, and Chinese words/bigrams/characters. Only function words are excluded; domain terms such as `材料`, `推荐`, `条件`, and `测试` remain searchable. Chinese character hits have low weight and cannot alone admit a longer query. Exact filename, title phrases, and exact aliases outrank ordinary content hits; phrase occurrence bonuses saturate to prevent repeated text flooding. Equal scores sort by source then title. At most 256 unique tokens are used (`queryTruncated` reports this limit), hit metadata is bounded, and previews retain original text (up to 220 code points plus ellipses). Source issues and citation quotations are not indexed as unrelated recommendation evidence; original facts and citations remain unchanged. No embedding configuration, vector calls, graph retrieval, or new model requests are introduced.

Internally, `src/shared/builtin.ts` collects and releases skill/wiki resources; the build plugin replaces only its collector while preserving runtime release logic. `src/shared/assets.ts` provides common collection, hashing and verification. Wiki's `index.ts` is the facade for recommendation queries, source search and evidence reads. `search.ts`, `build.ts`, `knowledge.ts`, `prompt.ts`, `sources.ts` and `snapshot.ts` retain the existing recommendation compilation path; `file-index/` adds bounded native-format parsing and SQLite/FTS5 source indexing. Existing recommendation source IDs and snapshot schema remain unchanged, while file indexing uses its own Wiki metadata tables and revision.

### 历史模板案例 SQLite

已提取的历史模板保存在 `wiki/indexes/library.sqlite`，共178条SAM配置参考，含结构化参数、JSON字段引用、原始文件相对路径/哈希、产品版本和FTS5索引；没有聊天数据、模型凭据、原始SAM二进制或PDF/报告/曲线。目录职责见 [wiki/README.md](wiki/README.md)。

Wiki统一提供推荐知识和历史模板参考。`builtinWiki=true`且未配置外部wikiIndexRoots时，直接只读加载内置SQLite，无需原件或首次建库；数据库单独嵌入可执行程序，按内容哈希发布到dataDir/builtin-wiki-index/<version>/library.sqlite，修改后的副本拒绝加载。sourceVerified=false和record.origin明确表示原始模板没有重新核验。历史完成案例只作参数参考，不直接作为新建模板启动。

`wikiRoots`用于显式模型编译的MD/TXT推荐知识；`wikiIndexRoots`用于显式本地解析SAM/SMP模板，默认 `[]`，相对路径从所选配置文件所在目录解析：

```json
{
  "wikiIndexRoots": ["../template-library"]
}
```

显式建立或增量更新索引：

```powershell
bun src/index.ts --config examples/config.json --wiki-index
# 已安装的可执行程序：
.\auto-agent.exe --config config.json --wiki-index
```

该操作读取本地文件，无模型请求、不需要模型 API Key、不修改原件。与模型编译的 `--wiki-update` 分开运行；已有服务运行时使用认证后的 `POST /wiki/index/update`，不要另起实例占用同一 dataDir。更新原子发布到 SQLite，取消、根目录不可用或源文件读取中变化保留旧索引。未变化且已成功解析的文件复用结果，删除文件会从新快照移除。

本期只扫描SAM/SMP，复用 `scripts/lib/sam.js`，不启动子进程或设备；其他文件跳过。其他厂家SMP明确标为unsupported。最多5000个模板、单文件32 MiB、提取快照64 MiB；符号链接跳过，读取受配置根目录约束。材料目录仅为线索，产品可来自文件状态家族，不冒充已验收的型号或科学条件。

模型在当前轮加载技能后，使用同一个wiki工具：action=query（默认）查询编译推荐，action=search按query/filters/limit筛选历史模板，action=read按id/query/maxEvidence读取参数和字段引用。条件共同生效，未知值不满足；支持材料线索、产品家族、气体、方法、压力模式、版本和温度。搜索按来源哈希去重，默认3条、最多10条。外部本地索引读取会核对原件哈希；内置只读快照不声称原件当前仍有效。完整响应受resourceLimitBytes约束，证据条数可明确减少，配置不默默裁剪。

本期不实现PDF、报告关联或结果推理；没有来源的配置原因保持未知。详情见 [Wiki检索契约](skills/device-automation/references/wiki.md)。

| 方法 | 路由                                         | 用途                                       |
| ---- | -------------------------------------------- | ------------------------------------------ |
| GET  | `/wiki/index`                                | 根目录配置、文件索引状态及数量，不扫描原件 |
| POST | `/wiki/index/update`                         | 正文为 `{}`，显式本地索引，等待完成        |
| GET  | `/wiki/search?query=...&filters=...&limit=3` | filters为URL编码的JSON对象                 |
| GET  | `/wiki/source/{id}?query=...`                | 按索引ID核验并读取配置和定位证据           |

这些接口使用与会话接口相同的鉴权。客户端及模型不能传入任意文件路径、目录或解析器命令。启动和聊天不会自动索引；搜索不读取原件，读取仅核验被选择的源文件。

## Built-in Skills

内置 `device-automation` 技能包含两条独立入口：

| 入口       | 作用                                                                         | 契约与实现                                                                                                 |
| ---------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 自动化流程 | 根据材料、样品及测试需求匹配已有模板，交给自动化控制系统运行预设的一系列流程 | [automation.md](skills/device-automation/references/automation.md)；`scripts/automation.js` 为开发模拟实现 |
| 单仪器控制 | 直接查询或操作指定仪器，当前接入 Climber                                     | [climber.md](skills/device-automation/references/climber.md)；`scripts/climber.js` 直连厂家 HTTP API       |

技能先识别任务类型，再加载对应契约。自动化流程内的步骤与仪器调度由控制系统负责，Agent 不同时直接启动其中的仪器。单独操作 Climber 无需提交流程；状态和结果查询无需先匹配模板。支持根据需求选择、新建、修改或另存为模板，保留产品、版本、单位、适用条件及引用；完整配置与文件路径来自资料或用户确认。

### Climber 真实设备接入

使用 [SAM 模板接口](skills/device-automation/references/sam.md)及 `scripts/sam.js` 检查、对比、新建、修改和另存为模板。`inspect/compare` 支持 g5/g12/s60pro，返回文件哈希、状态、来源、单位及差异。`profiles` 查询随技能发布的 G5/G12 N2 完整配置和来源；`create` 接受 product 与 settings，按 BET/介孔/微孔方法组织完整配置并生成真实 SAM，无需用户提供基准文件或完整 JSON。也支持直接提供完整 template。未指定输出位置时使用 SAM_OUTPUT_DIR 或用户主目录的 Auto-Agent/templates；缺少称量或样品名可先保存待填模板，补齐本次信息后再提交执行。新建使用独立身份及新建状态；`modify/save-as` 校验来源哈希、保留未改字段，新建和另存为不覆盖已有目标。生成文件可通过厂家可读的绝对 `.SAM` 路径交给现有 Climber 启动接口。静态检查不代表设备验收通过；内置完整配置与 Wiki 历史摘要分别维护，原案例及默认程序不等于任意材料的科学批准。

`scripts/climber.js` 直接调用厂家 Climber PC 软件的 18080 HTTP API，控制已验收的左侧1–3口。登记使用 batchId、experiments、样品名、原管号、空管/净样质量及厂家白名单内的绝对 SAM 路径；脚本将原管号按 `n % 72 or 72` 转换后发给厂家并返回映射。Agent 确认运行授权与参数，查询厂家 health/status，明确登记成功后再单独启动同一批次，并跟踪实际状态。

程序首次启动自动生成的 `config.json` 已包含以下 `scriptEnv` 连接设置；使用自定义配置时可自行加入或修改（默认地址适用于同机部署）：

```json
{
  "scriptEnv": {
    "CLIMBER_SERVICE_URL": "http://127.0.0.1:18080/api/v1",
    "CLIMBER_TIMEOUT_MS": "5000"
  }
}
```

重启应用后生效。地址必须指向厂家 HTTP API 并包含 `/api/v1`，不再连接 Python 子服务。已有配置保留原值，需要将旧连接地址手动改为上面的厂家地址。应用启动不会主动访问设备，执行技能命令时才调用。脚本使用 Node.js 22 或应用兼容的内嵌运行时。厂家部署若要求鉴权，需先对齐其合同与凭据注入方式；凭据不得放入 URL 或 `scriptEnv`。

调用参数：`health` 与 `status` 为只读查询；`register <JSON>` 接受 `{batchId,experiments}` 并 POST `/api/v1/tasks`；`start <JSON>` 只接受 `{batchId}` 并以 `{}` 正文 POST `/api/v1/tasks/{batchId}/start`。没有旧命令别名或子服务封套。所有写请求均不自动重试；超时、无效回执或批次不符返回 `OUTCOME_UNKNOWN`，保留 batchId 和阶段，停止依赖步骤并只读对账。

厂家登记回执使用 `ok/data.task`；启动按文档实测 HTTP 202 的 `ok/data` 任务对象校验；status 使用 `ok/data.health` 和 `data.task`。READY 不代表分析开始，启动受理不等于实际 RUNNING；结果文件仅按厂家实际返回的同批证据报告。通过本地 HTTP mock 验证接口合同，真实现场连通性与设备动作仍需在实际部署中核对。

### 自动化流程与模拟脚本

自动化设备是运行既定流程的系统。接口为 `list`、`status <deviceId>`、`submit-run <JSON>`、`run <runId>`、`results <runId>`、`export-report <runId>`。提交仅包含 `{deviceId, templateFile}`，设备在部署配置的目录中查找已有流程模板。AI 不读取或配置模板目录，不提交单仪器字段，不编辑流程；当前没有模板管理或流程暂停/继续/取消接口。报告能力属于流程后端，不代表 Climber 支持报告生成。

`scripts/automation.js` 当前仅模拟自动化流程。设备以 `kind=preset-workflow` 标识，所有成功响应含 `backend=simulation`，合成结果和报告保留来源说明，不是真实测量。模拟器仅记录模板文件名，不验证文件存在或读取流程内容。运行按模拟时长完成，无后台进程；默认 1,000 ms，可通过 `scriptEnv.AUTO_AGENT_SIMULATION_DURATION_MS` 设置为 1–600,000 ms。

模拟数据默认写入 `<user-home>/.auto-agent/simulated-automation`，也可通过 `scriptEnv.AUTO_AGENT_SIMULATION_DIR` 指定技能目录外的绝对路径。状态包含 `kind=preset-workflow` 和 `runs`，仅接受当前结构；没有历史状态读取、迁移、旧字段或命令别名。只读查询不写状态；写操作独占加锁并原子发布，损坏状态和已有锁不自动重置，已有报告不被静默覆盖。模拟数据与真实实验数据分别管理，写入效果未知时不自动重试。

### 技能资源加载

The root [skills](skills) directory contains built-in packages; examples remain under [examples/skills](examples/skills), and external skills are configured through `skillRoots`. `builtinSkills` defaults to `true`. Source runs read every UTF-8 file under the root `skills` directory, relative to the source module rather than the launch directory. The `build:windows` and `build:linux` commands embed the same resources into standalone executables. Both modes release a content-versioned copy under `dataDir/builtin-skills/<version>` before discovery. No `skillRoots` configuration is needed for `device-automation`. Auto-Agent keeps `.js: "node"`, uses installed Node.js when available, and falls back to its embedded runtime only when that bare command is missing. Explicit `.js: "builtin"` is also available; errors from a launched script are never retried using another runtime. Built-ins use the same metadata/path validation, execution limits, audit, and cancellation as configured skills.

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

`src/agent/builtins.ts` supplies refreshed built-in facts before each chat-model request: current local date, UTC timestamp, time zone, process working directory, nearest ancestor Git project marker/root, operating system, platform, architecture and runtime version. Directory discovery recognizes `.git` directories and worktree marker files without executing Git; inaccessible markers are reported as unknown. These describe the agent host, not an instrument or script working directory, and grant no filesystem permissions. The snapshot is escaped, redacted, included in the context budget and replaced on every request rather than appended to conversation history. Custom role prompts retain the same tool guidance, skill guidance and built-in facts. Credentials and arbitrary environment variables are not enumerated.

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
