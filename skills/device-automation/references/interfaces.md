# Instrument interfaces — persistent simulation backend

The current implementation is **local simulation only**. It never connects to hardware, external software, or the network. JSON response envelopes use interface-style fields and omit a per-response `simulated` flag; the backend and persisted artifacts explicitly retain simulation provenance. Generated data must never be represented as real sample measurements.

The schemas below are the simulation contract, not a certified vendor API. A future real adapter must document and validate the actual software contract rather than assuming these fields or capabilities are compatible.

## Invocation and persistence

Call `execute_skill_script` with `skill: "device-automation"`, `path: "scripts/instrument.js"`, and an argument array. Node.js and a configured `.js` interpreter are required. JSON payloads are single arguments, never shell strings. Inspect exit status and JSON; errors use `{ "error": { "code": "...", "message": "..." } }` with a nonzero exit code.

The default data directory is `<user-home>/.auto-agent/simulated-instruments`. An operator may set an absolute `AUTO_AGENT_SIMULATION_DIR` through configuration `scriptEnv`. Keep it separate from real instrument data and outside skill installation/version directories. `simulation-state.json` stores templates, measurements, and backend provenance; reports remain under this directory. Changing the directory selects a different simulation environment, not a real instrument.

State persists across calls and restarts. Mutations use exclusive locking and atomic publication. Read-only queries do not create or update state, even when elapsed time changes an observed measurement state. A busy lock or corrupt state is an error; do not delete files or replay an uncertain operation automatically. There is no reset command. Configured limits reject oversized payloads/state.

## Commands

- `["list"]` → `{devices}`; `["status", "<deviceId>"]` → `{device}`.
- `["validate-template", "<template JSON>"]` → `{valid, errors}`.
- `["save-template", "<template JSON>"]` / `["get-template", "<templateId>"]` → `{template}`; `["list-templates"]` → `{templates}`. Template saving is create-only.
- `["submit-measurement", "<submission JSON>"]` / `["measurement", "<measurementId>"]` → `{measurement}`.
- `["control-measurement", "<measurementId>", "<action>"]` → `{measurement}`. Action is exactly `pause`, `resume`, or `cancel`.
- `["results", "<measurementId>"]` → `{result}` after completion.
- `["export-report", "<measurementId>"]` → `{report}` with its verified local path.

Use IDs from responses rather than fabricating them. Device IDs are `sim-analyzer-1` and `sim-analyzer-2`, representing fixture analyzers, not physical connections. Inspect their supported methods and gases before choosing one.

## Template and submission schemas

A new template has exactly these fields:

- `name`: nonempty string.
- `deviceId`: discovered device ID.
- `method`: `BET`, `BJH`, or `DFT`, supported by the selected fixture.
- `gas`: `N2` or `CO2`, supported by the selected fixture.
- `temperatureK`: positive finite number in kelvin.
- `preprocessing`: exactly `{ "temperatureC": <finite number >= 0>, "durationHours": <positive finite number> }`.
- `sampleMassG`: positive finite number in grams.

No unknown fields, string ranges, implicit defaults, or vendor-specific fields are accepted. Structural validation checks shape, finite values, and fixture capabilities only. It does not certify scientific validity, method applicability, calibration, operating safety, or real hardware limits. Resolve missing values/ranges with the user before forming an executable payload. Template saving is create-only; retain its returned ID and verify by reading it back.

Measurement submission has exactly `{ "deviceId": "...", "templateId": "...", "sampleId": "..." }`. The template must belong to the device; the sample identifier must be nonempty. Only one active measurement is allowed per fixture. Submission snapshots the saved template for result provenance.

## Measurement lifecycle and results

Tasks start running and reach completion according to elapsed simulation time; no process remains running in the background. The default fixture duration is 1,000 milliseconds. Operators/tests can configure `AUTO_AGENT_SIMULATION_DURATION_MS` in `scriptEnv` to an integer between 1 and 600,000 milliseconds. This timing is not a physical experiment duration.

`pause` applies only to running tasks, `resume` only to paused tasks, and `cancel` only to active tasks. Paused time does not count toward completion. Completed/cancelled tasks are terminal. Read-only inspection computes the current state without writing files; cancellation is not evidence of stopping hardware.

Results are available only after observed completion and are deterministic synthetic fixtures tied to the sample, device, and saved template, with units and fixture provenance. They are not calculated scientific properties of the supplied sample. Report export stays within the simulation data directory and preserves backend provenance; arbitrary output paths and overwrites are not supported. Verify the returned artifact before claiming export success.

## Future real adapter boundary

Before adding a real adapter, document supported software versions, explicit connection/authentication configuration, field mappings/units, limits, prerequisites/interlocks, authorization, errors, operation identifiers, idempotency/retry rules, cancellation/timeout semantics, and evidence of completion. Keep credentials outside skill resources. Do not enable real networking or translate simulator acceptance into hardware approval.

Read-only queries must not trigger writes. Saving, submission, control, and report creation require authorized scope. Preserve provenance, distinguish unknown effects from failures, and stop dependent operations for operator reconciliation rather than automatically retrying uncertain mutations.
