# pi-model-alias

A [Pi](https://github.com/badlogic/pi-mono) extension that exposes stable
`alias/*` role models and delegates each request to a concrete
provider/model — with ordered fallback chains, shared failure cooldowns, a
live footer status, and durable transcript warnings.

Point your session, subagents, and tooling at a role like `alias/coder`
once; swap the underlying provider/model (or a whole fallback chain) in one
JSON file without touching anything else.

## Features

- **Role models**: each alias appears as a first-class `alias/<role>` model in
  `pi --list-models`, usable as the session default, in agent frontmatter, or
  anywhere a model reference is accepted
- **Fallback chains**: a role maps to one `provider/model` string or an
  ordered array; resolution, authentication, HTTP, and connection failures
  advance to the next target, and exhaustion reports every target and reason
- **Nested aliases**: fallback chains can include `alias/<role>` references,
  which are flattened into concrete targets when the map loads. Cycles,
  unknown nested aliases, and nesting deeper than 4 levels skip only the
  offending ref (warned in the transcript); the rest of the chain still works
- **Auth availability gate**: the `alias` provider returns a fixed,
  non-secret `apiKey` only to mark itself available for registry consumers.
  Streaming discards that value and resolves the selected target's real auth,
  so alias models work without depending on the active top-level model
- **Safe mid-stream semantics**: start/thinking events are buffered until
  real output is forwarded, so a failed thinking-only attempt is discarded
  and retried; once text or tool output flows, failover stops (Pi's stream
  consumer cannot reset after that point)
- **Failure cooldowns**: failed targets back off from a configurable base,
  doubling to a configurable cap (5 minutes to 60 minutes by default). Set
  `cooldown.resetSuccesses` to require more consecutive successes before a
  target's cooldown clears. Any failure — before or after
  the stream commits — resets that success streak back to zero, so only an
  uninterrupted run of successes clears the cooldown. Cooled targets are
  skipped while alternatives remain, retried before exhaustion, and attempted
  immediately if the whole chain is cooling
- **Cross-process cooldown store**: cooldown state is shared through
  `logs/cooldown-state.json` (atomic writes, mtime-based reload), so main
  sessions and subagent processes see each other's failures
- **Footer status**: a status-bar indicator always shows the current concrete
  target's short label for an alias session model, followed by every cooling
  target when present (refreshed every 30 s)
- **Transcript warnings**: failovers and cooldown resets append durable
  entries to the chat transcript (rendered, expandable, never sent to the
  LLM) instead of transient popups
- **Metadata mirroring**: context window, max output tokens, and cost mirror
  the selected concrete target so compaction thresholds stay accurate
- **Debug log**: rotating JSONL log of alias activity for troubleshooting

## Install

Copy this directory into your Pi extensions directory
(`~/.pi/agent/extensions/pi-model-alias/`). Pi loads `index.ts`
automatically; run `/reload` in a live session to pick it up.

## Configuration

Aliases live in `<agent-dir>/model-alias.json` (usually
`~/.pi/agent/model-alias.json`). Override the path with the
`PI_MODEL_ALIAS_MAP` environment variable, including for isolated tests.

```json
{
  "coder": [
    "provider-example/model-primary",
    "alias/fable-opus-fallback"
  ],
  "summarizer": "openrouter/deepseek/deepseek-chat-v3-0324:free",
  "fable-opus-fallback": [
    "fable/fable-5",
    "amazon-bedrock/model-primary",
    "amazon-bedrock/model-fallback"
  ]
}
```

- Keys are role names; each becomes the model `alias/<role>`.
- Values are one model reference or an ordered fallback array. Targets may be
  concrete `provider/model` references or nested `alias/<role>` references.
- Nested chains are flattened when the map loads. Duplicate concrete targets
  keep their first position, and cooldowns apply per concrete target. An
  unknown nested alias, a cycle, or nesting deeper than 4 levels
  (`MAX_ALIAS_DEPTH`) skips just that ref and keeps the rest of the chain;
  each skip is logged, warned on stderr in headless runs, and appended to
  the transcript as a user-visible entry (never sent to the LLM). A role
  whose refs are all skipped stays registered but fails with an exhaustion
  error when used.
- Edit the map, then `/reload` or restart Pi.

### Auth availability gate

Pi resolves provider auth per provider, so the alias provider cannot know
which alias role or concrete target a request will use. Its auth resolver
returns a fixed, non-secret API-key value that marks the provider as available
to registry consumers that require an `apiKey`. The gate does not depend on
the top-level model, active target, or concrete target credentials.

Streaming remains the authoritative authentication path. It resolves the
requested alias role, selects a concrete target, and gets that target's real
auth before opening the stream. Request assembly never forwards the gate:

- The caller-supplied `apiKey` is dropped.
- Target auth replaces caller `env` values.
- Credential headers (`authorization`, `x-api-key`, `api-key`,
  `x-goog-api-key`, `anthropic-*`) are stripped from caller headers.
- Remaining caller headers only fill gaps that target auth does not define.

This boundary supports env-only targets such as `AWS_PROFILE`-based Bedrock
without leaking a credential between providers after failover. It can also
make an alias appear available before its concrete target credentials are
proven. In that case, stream-time target resolution returns the precise auth
failure for the requested role.

> [!IMPORTANT]
> Consumers must call the alias provider's `stream()` or `streamSimple()` after
> auth lookup. The returned `apiKey` is only an availability gate; it is not a
> credential and must not be sent directly to an HTTP API or provider SDK. The
> alias stream discards the gate and resolves the selected target's real auth.

## Usage

```jsonc
// settings.json
{
  "defaultProvider": "alias",
  "defaultModel": "fable-opus-fallback"
}
```

```yaml
# agents/my-agent.md frontmatter
model: alias/coder
```

### Commands

- `/reset-model-cooldown` — clear all target cooldowns (every process sees
  the reset); appends a confirmation entry to the transcript.

### Response identity and usage

Forwarded assistant messages use the logical alias identity in `api`,
`provider`, and `model`. This keeps session restore and subagent model
verification on `alias/<role>`, even when a concrete target answered.
`responseModel` keeps the concrete target model ID; an existing value from the
target is preserved, otherwise the target event's original `model` is used.
The footer, debug log, latency records, and failover transcript entries retain
the provider-qualified concrete target reference.

`@tmustier/pi-usage-extension` 0.9.4 keeps totals and nested-agent
reconciliation correct because it reads the preserved `usage` data. New
attribution groups by alias role, so a concrete failover behind an alias does
not appear as a model switch. Historical sessions can show both concrete and
alias groups. Use alias status or logs for concrete attribution.

Concrete per-target usage grouping is a non-blocking upstream follow-up. It
needs provider-qualified target metadata and parser, aggregation, migration,
and malformed-data fallback support in the usage extension. This extension
keeps `responseModel` model-only and does not change that package.

## Troubleshooting

- **Footer target or cooldown looks stale** — the short label is the current
  concrete target for the session's alias model; cooldowns follow after ` · `.
  Wait for the next 30-second refresh, inspect the transcript warning, or clear
  cooldown state with `/reset-model-cooldown`.
- **Debug log** — `logs/pi-model-alias-debug.jsonl` inside this directory
  records loads, open attempts, failovers, cooldown changes, and UI errors.
  See [Debug log retention](#debug-log-retention) for rotation settings.
- **Cooldown state** — `logs/cooldown-state.json`; entries expire on their
  own and stale entries are pruned after an hour.
- **A restored session cannot find its alias** — add the removed role back to
  `model-alias.json`, select a current model, or start a new session. Persisted
  assistant messages intentionally retain the logical alias for session restore.

## Debug log retention

The active log rotates once it passes a size limit. Each rotation becomes a
timestamped archive such as
`pi-model-alias-debug.jsonl.2026-09-03T19-17-49-360Z.31522.1.jsonl`; the process
id and sequence keep concurrent sessions from claiming the same name. Archives
older than the retention window are deleted at startup and at each rotation
check. Readers and the latency report consume the active log, every retained
archive, and any legacy `.old` file; legacy `.old` files are not auto-deleted.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_MODEL_ALIAS_LOG_MAX_BYTES` | `1048576` | Size at which the active log rotates |
| `PI_MODEL_ALIAS_LOG_RETENTION_DAYS` | `7` | Age after which archives are deleted |

Both accept positive integers. An invalid value warns once and uses the
default.

### Correlating a provider failure with AWS

`attempt-latency` and `failover-warn` records carry the failing response's
`httpStatus`, plus `requestId`, `traceId`, and `diagnosticHeaders` when the
provider returns them. Only request and trace identifiers are recorded:
authorization headers, cookies, request payloads, and response bodies are never
logged. The same allowlisted fields also persist in failover session entries,
which follow session retention rather than debug-log retention.

To escalate a provider-side failure, take `requestId` (or `traceId`) with the
record's `ts`, the `targetRef` model, and that provider's region, then search
CloudWatch for the request id or give AWS Support the same tuple. For
`provider-example/model-family-*` targets the region is the endpoint's region,
`us-east-1`.

## Development

Requires Node 22.18 or later because Node type stripping runs both the tests and the `.mjs` report CLI.

```bash
npm test
npm run typecheck
```

The package uses pinned development dependencies for repeatable local tests
and type checks. `pi-resolve.mjs` keeps the standalone test command available
when needed.

Module layout: `index.ts` (composition root), `alias-config.ts` (map
loading), `alias-model.ts` (model factory + metadata), `alias-stream.ts`
(fallback stream orchestration), `fallback.ts` (chain policy + cooldown
registry), `cooldown-store.ts` (shared file-backed store), `transcript.ts`
(entries + renderers), `session-status.ts` / `status.ts` (footer),
`debug-log.ts` (JSONL logging), `scripts/pi-resolve.mjs` (standalone test
module resolution).

## Latency timeouts

Timeouts are optional. With no `$defaults` or role `timeouts`, streaming keeps
its prior behavior exactly. Configure defaults and role overrides as follows:

```json
{
  "$defaults": {
    "timeouts": { "firstEventMs": 30000, "stallMs": 60000 }
  },
  "coder": [
    "provider-example/model-fallback",
    "amazon-bedrock/model-fallback"
  ],
  "reviewer": {
    "targets": ["alias/coder", "provider-example/model-primary"],
    "timeouts": { "firstEventMs": 15000, "commitMs": 300000 }
  }
}
```

`firstEventMs` limits the time to the first provider event. `stallMs` limits
silence between events and resets on each event, including thinking events.
`commitMs` limits total pre-output time. All values are positive milliseconds;
there is no default `commitMs` limit.

Timeouts are active only if a fallback target remains. A one-target alias and
the final target in a chain are never aborted for latency. Timers stop when
text or tool output commits, so this extension never swaps providers after
partial output reaches Pi. A latency timeout records the normal shared
cooldown (`baseMs` to `capMs`, 5 minutes to 60 minutes by default), and the
next request can skip that target.

## Cooldown policy

`$defaults` and any object-form alias accept the same policy fields, so each
alias is the defaults plus its own overrides:

```json
{
  "$defaults": {
    "timeouts": { "firstEventMs": 30000, "stallMs": 60000 },
    "cooldown": { "baseMs": 300000, "capMs": 3600000, "resetSuccesses": 3 }
  },
  "coder": [
    "provider-example/model-fallback",
    "amazon-bedrock/model-fallback"
  ],
  "impatient": {
    "targets": ["alias/coder"],
    "timeouts": { "firstEventMs": 15000 },
    "cooldown": { "baseMs": 60000, "resetSuccesses": 1 }
  }
}
```

Resolution runs built-in defaults, then `$defaults`, then the requested
alias's overrides, merging `timeouts` and `cooldown` field by field. `coder`
above inherits the full default policy; `impatient` keeps the default 60
minute cap while overriding the first-event limit, base, and reset count.
String and array aliases stay valid and inherit the defaults.

Cooldowns grow from `baseMs`, doubling until they reach `capMs`. `baseMs` and
`capMs` are positive milliseconds and `resetSuccesses` is a positive integer.
Setting only a `capMs` below an inherited `baseMs` clamps that base down to the
cap, so lowering one cap cannot disable the extension; writing a `baseMs`
above a `capMs` in the same entry is rejected as a contradiction. The legacy
`$defaults.cooldownResetSuccesses` still works, but setting it alongside
`cooldown.resetSuccesses` is rejected rather than silently resolved.

The policy is the requested alias's own. Nested `alias/<role>` refs contribute
targets only, so one request runs under one policy no matter which alias
supplied a target.

### Shared state across aliases

Cooldown state stays keyed by concrete target and shared across aliases and
processes, so policy choices interact:

- A failure applies the requesting alias's growth curve, but never shortens a
  cooldown another alias already set. The longer window wins.
- A success applies the requesting alias's `resetSuccesses`, so an alias with
  `resetSuccesses: 1` can clear state that a stricter alias created.
- Any failure, before or after commit, resets the success streak to zero.

## Reloading policy

Because cooldown state is shared, every new stream re-reads the alias file and
resolves the current policy instead of trusting a startup snapshot. Policy
edits therefore apply to the next request in every running session.

Alias names and target chains are registered at startup and still need a
reload; only policy is live. In-flight streams keep the policy captured when
they started.

If the current file cannot be used — unreadable, malformed, caught
half-written, invalid, or missing that alias — the stream continues on the
last valid policy, adds one durable transcript warning per alias per distinct
failure in TUI mode (and writes the same warning to stderr in headless mode),
and records `alias-policy-stale`. Recovery of that alias logs `alias-policy-recovered`;
one healthy alias never clears another's degraded state. Availability is
preserved, at the cost that processes can sit on different cached generations
until the file parses again, so replace it atomically (write a temporary file,
then rename) to keep every session consistent.

Each `attempt-latency` record carries `configLoadMs`, the cost of that read,
parse, and resolve, plus `configDegraded` to show whether the attempt ran on
the current file or a cached policy. They report only a duration and a flag,
never config contents.

## Measuring latency

Every provider attempt writes an `attempt-latency` debug record, even when
latency timeouts are not configured. Records include time to first event, the
largest event gap, commit and total time, event count, outcome, and terminal
message token usage when Pi provides it.

Run the report from this extension directory:

```bash
node scripts/latency-report.mjs
```

In Pi, run `/alias-latency-report` for the same transcript report, or pass an alias role to filter it: `/alias-latency-report coder`.

Pass extra debug JSONL paths as arguments when needed. The report also reads
retained archives and any legacy `.old` rotation, oldest first, and skips
malformed lines. The table shows timeout count, rate,
and kind; the role summary warns when timers fire too often or do not fire in
200 attempts. Suggestions remain role-level heuristics from your own traffic;
low-confidence targets need more samples.
