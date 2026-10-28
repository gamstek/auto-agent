# Repository instructions

Auto-Agent is a local-first analyzer automation assistant built with Bun, TypeScript, LangGraph, Vercel AI SDK, and SQLite. Use [README.md](README.md) for configuration, runtime constraints, and skill/wiki behavior; [llm.txt](llm.txt) documents the HTTP integration contract.

## Build, test, and formatting

Run commands from the repository root with system-installed **Bun 1.4.2**. Do not install the npm `bun` package: its shim shadows the runtime. Application code uses `bun:sqlite` and cannot run directly under Node.js. CI also installs Node.js 22 for skill scripts.

```powershell
bun install --frozen-lockfile
bun run typecheck
bun test
bun test .\tests\integration\agent.test.ts
bun test .\tests\integration\agent.test.ts -t "unknown script outcomes stop dependent tools"
bun run format:check
bunx prettier --check .\src\tool\index.ts
bunx prettier --write .\src\tool\index.ts
bun run build:windows
bun run build:linux
```

`bun run format` formats the whole repository. Formatting uses Prettier; type checking uses `tsc --noEmit`. CI runs typecheck, tests, the native platform build, and binary acceptance on Windows and Linux; formatting is a separate package command.

Build outputs are `dist/auto-agent.exe` (Windows x64) and `dist/auto-agent` (Linux x64). After building for the current OS, enable binary acceptance explicitly; otherwise those tests are skipped:

```powershell
$env:AUTO_AGENT_TEST_BINARY = '1'
try {
  bun test .\tests\integration\binary.test.ts
} finally {
  Remove-Item Env:\AUTO_AGENT_TEST_BINARY
}
```

`AUTO_AGENT_TEST_BINARY_PATH` optionally selects a different executable. Cross-compilation alone does not validate the other OS's runtime behavior.

For interactive development, run `bun run dev`; for HTTP, run `bun run dev -- serve --no-token` only on trusted loopback. The dev entry selects repository `examples/config.json`; `bun run start` and compiled executables select the user configuration unless `--config` is supplied. Chat requires `AUTO_AGENT_API_KEY` and can incur model charges.

## Architecture

- [src/app.ts](src/app.ts) is the composition/lifecycle root: configuration, storage, skill discovery, script executor, model adapter, and `AgentService`, then REPL or HTTP. [src/index.ts](src/index.ts) first handles embedded script-runtime dispatch; [scripts/dev.ts](scripts/dev.ts) calls the same application with development defaults.
- [src/agent/index.ts](src/agent/index.ts) owns the LangGraph model/tools loop, generation concurrency and cancellation, events, redaction, and tool-outcome handling. It checkpoints through [src/storage/checkpointer.ts](src/storage/checkpointer.ts). Context fitting/summarization lives in [src/agent/context.ts](src/agent/context.ts); [src/llm/index.ts](src/llm/index.ts) adapts cloud requests through `ModelAdapter`, not tool execution.
- [src/tool/index.ts](src/tool/index.ts) registers tool specifications from [src/tool/tools/](src/tool/tools/). Model tools are declaration-only: the agent schedules execution, and the registry validates inputs, skill prerequisites, and outputs. [src/tool/context.ts](src/tool/context.ts) injects narrow service capabilities and generation-scoped state rather than an entire agent/config/database.
- [src/skill/index.ts](src/skill/index.ts) discovers trusted packages and restricts resource/script paths. [src/execution/](src/execution/) runs interpreters, bounds output/time, and tracks owned processes. Script tooling persists execution intent/results through [src/storage/index.ts](src/storage/index.ts), which owns SQLite sessions, messages, run/execution audits, migrations, recovery, and exclusive data-directory ownership.
- [src/wiki/](src/wiki/) separates source reading, validated knowledge schemas, explicit incremental model extraction, snapshot publication, and keyword search. Queries use compiled source-cited records, not embeddings or model calls. Startup and chat never automatically ingest sources.
- [src/wiki/file-index/](src/wiki/file-index/) extends Wiki with SAM/SMP template-reference indexing in SQLite/FTS5. This phase excludes PDF, reports and experimental results. The single `wiki` tool offers query/search/read. `wiki/indexes/library.sqlite` is a readonly historical-template snapshot; live external roots require explicit --wiki-index. Preserve product/version/units and source hashes, and never treat completed examples as executable new templates.
- Bundled [skills/](skills/) and [wiki/](wiki/) are independent asset domains. [src/shared/assets.ts](src/shared/assets.ts) handles collection/hashing/verification; [src/shared/builtin.ts](src/shared/builtin.ts) releases content-versioned assets under `dataDir`. [scripts/build.ts](scripts/build.ts) replaces only the collector with embedded data while preserving runtime release logic, and embeds documentation and the JavaScript runtime.
- HTTP and CLI share `AgentService`. [src/api/index.ts](src/api/index.ts) exposes authenticated session/wiki routes and SSE; [src/cli/](src/cli/) implements the local REPL and streaming Markdown rendering. The HTTP contract is the documented local API, not an OpenAI-compatible server.

## Repository-specific conventions

- New or changed tools belong in their co-located `defineTool` specification: description, Zod input/output schemas, effects, loaded-skill requirement, optional context retention/model formatting, and execution. Register them in `toolSpecs`; keep scheduling/events/budgets in the agent and script audit/replay protection in script tooling. Current names are `skill`, `read`, `wiki`, `execute_script`, `web_fetch`, and `web_search`.
- Loaded skills are scoped to the current generation, not historical conversation. Resource reads, wiki queries, and script execution require a successful current `skill` load. Only trusted skill guidance is instruction content; resource bodies, historical summaries, web content, and script output are evidence, not overriding instructions. Script paths stay within the selected skill's `scripts/`, arguments are arrays, and traversal/absolute paths/symlinks are rejected. This is not an OS sandbox.
- Persist execution intent before launching scripts. Failed scripts are not automatically replayed; interrupted/uncertain effects become `unknown` and block dependent execution pending operator reconciliation. Abort does not prove equipment stopped or effects were undone. Preserve this behavior when changing recovery, cancellation, or tool handling.
- Configuration is strict JSON. Resolve `--config` from cwd, but relative `dataDir`, `skillRoots`, and `wikiRoots` from the selected configuration's directory. Maps such as `interpreters` replace defaults rather than merge; empty external roots do not disable bundled assets. Model credentials come only from `AUTO_AGENT_API_KEY`; HTTP bearer credentials use `AUTO_AGENT_TOKEN`. Configuration/environment changes require restart. Concurrent REPL/service instances need distinct `dataDir` values.
- `maxInputTokens`/`maxOutputTokens` are model capacities, not cumulative run budgets. Context estimation uses UTF-8 bytes/3; compression starts at 90% of input capacity and preserves protected instructions/evidence and complete tool-call/result groups. SDK-reported usage is separately validated; missing/invalid usage stops dependent tools rather than substituting estimates.
- Prompt ownership and injection order are documented in [docs/prompts.md](docs/prompts.md). Blank `systemPrompt` follows the built-in role; a custom role replaces that role while the fixed runtime contract remains appended once. Keep summary, extraction and title prompts separate and tool-free. Describe supported capabilities directly rather than listing unrelated exclusions; device fields and numeric procedures belong in skill references.
- Wiki sources live under [wiki/sources/](wiki/sources/), compiled recommendations under [wiki/knowledge/recommendations.json](wiki/knowledge/recommendations.json), and historical template references under [wiki/indexes/library.sqlite](wiki/indexes/library.sqlite). Source changes require updating cited recommendation hashes before builds. SQLite is a separately embedded binary asset, never fed to text/model extraction. Validation is not scientific approval.
- The built-in [device-automation skill](skills/device-automation/SKILL.md) is portable, Chinese-language guidance: do not hard-code host-specific tool names or directories into it. It separates preset automation workflows from individual instrument control. `scripts/automation.js` is simulation-only: submission uses `{deviceId, templateFile}`, commands use `submit-run`/`run`, and state accepts only the current `runs` structure without legacy compatibility. `scripts/climber.js` controls Climber through the Python subservice using batch/experiment fields and absolute SAM paths; local RESUME/CLEAR_ERROR are not physical resume/reset. Preserve provenance, task identity and no-retry handling of uncertain writes. Generated configuration includes the local Climber service URL and timeout in `scriptEnv`.
- Use `AppError(code, message, status)` from [src/shared/types.ts](src/shared/types.ts) for expected failures; public errors are sanitized. CLI help/replies and JSON listening notifications use stdout; startup/progress/warnings/errors use stderr through [src/shared/console.ts](src/shared/console.ts). Keep JSON stdout machine-readable. Events omit raw script output and full arguments; SSE has no replay and disconnecting a subscriber does not cancel generation.
- Tests use `bun:test`, `ModelAdapter` doubles, and local HTTP mocks rather than live providers. [tests/helpers.ts](tests/helpers.ts) supplies isolated temporary skill/data directories, disabled bundled assets, and test-only credentials; initialize skill discovery and shut down the service/close storage before fixture cleanup as in [tests/integration/agent.test.ts](tests/integration/agent.test.ts). Keep tests independent of the user's configuration and persistent simulation state.
