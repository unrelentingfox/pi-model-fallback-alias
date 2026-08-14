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
  which are flattened into concrete targets when the map loads
- **Safe mid-stream semantics**: start/thinking events are buffered until
  real output is forwarded, so a failed thinking-only attempt is discarded
  and retried; once text or tool output flows, failover stops (Pi's stream
  consumer cannot reset after that point)
- **Failure cooldowns**: failed targets back off starting at 30 seconds,
  doubling to a 30-minute cap; a successful stream commit resets the count.
  Cooled targets are skipped while alternatives remain, retried before
  exhaustion, and attempted immediately if the whole chain is cooling
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
  unknown nested alias or cycle rejects the whole map: no aliases register,
  and the reason is logged and warned. Fix the map before any alias works
  again.
- Edit the map, then `/reload` or restart Pi.

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

## Troubleshooting

- **Footer target or cooldown looks stale** — the short label is the current
  concrete target for the session's alias model; cooldowns follow after ` · `.
  Wait for the next 30-second refresh, inspect the transcript warning, or clear
  cooldown state with `/reset-model-cooldown`.
- **Debug log** — `logs/pi-model-alias-debug.jsonl` inside this directory
  records loads, open attempts, failovers, cooldown changes, and UI errors
  (1 MiB rotation, previous file kept as `.old`).
- **Cooldown state** — `logs/cooldown-state.json`; entries expire on their
  own and stale entries are pruned after an hour.

## Development

Requires Node 22.18 or later because Node type stripping runs both the tests and the `.mjs` report CLI.

```bash
node --test __tests__/*.test.ts
bash scripts/typecheck.sh
```

`typecheck.sh` finds the installed Pi runtime and its Node type definitions. It
writes a temporary local override, so `tsconfig.json` stays portable.

Module layout: `index.ts` (composition root), `alias-config.ts` (map
loading), `alias-model.ts` (model factory + metadata), `alias-stream.ts`
(fallback stream orchestration), `fallback.ts` (chain policy + cooldown
registry), `cooldown-store.ts` (shared file-backed store), `transcript.ts`
(entries + renderers), `session-status.ts` / `status.ts` (footer),
`debug-log.ts` (JSONL logging).

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
cooldown (30 seconds to 30 minutes), and the next request can skip that target.

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
`.old` rotations and skips malformed lines. The table shows timeout count, rate,
and kind; the role summary warns when timers fire too often or do not fire in
200 attempts. Suggestions remain role-level heuristics from your own traffic;
low-confidence targets need more samples.
