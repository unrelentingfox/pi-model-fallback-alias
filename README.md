# pi-model-alias

A [Pi](https://github.com/badlogic/pi-mono) extension that exposes stable
`alias/*` role models and delegates each request to a concrete
provider/model — with ordered fallback chains, shared failure cooldowns, a
live footer status, and durable transcript warnings.

Point your session, subagents, and tooling at a role like `alias/coder-model`
once; swap the underlying provider/model (or a whole fallback chain) in one
JSON file without touching anything else.

## Features

- **Role models**: each alias appears as a first-class `alias/<role>` model in
  `pi --list-models`, usable as the session default, in agent frontmatter, or
  anywhere a model reference is accepted
- **Fallback chains**: a role maps to one `provider/model` string or an
  ordered array; resolution, authentication, HTTP, and connection failures
  advance to the next target, and exhaustion reports every target and reason
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
- **Footer status**: a status-bar indicator lists every target currently on
  cooldown (refreshed every 30 s), hidden when there is nothing to show
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
  "coder-model": "anthropic/claude-sonnet-4-5",
  "summarizer": "openrouter/deepseek/deepseek-chat-v3-0324:free",
  "fable-opus-fallback": [
    "fable/fable-5",
    "amazon-bedrock/model-primary",
    "amazon-bedrock/model-fallback"
  ]
}
```

- Keys are role names; each becomes the model `alias/<role>`.
- Values are one `provider/model` reference or an ordered fallback array.
- Targets must be concrete models; an alias may not target another alias.
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
model: alias/coder-model
```

### Commands

- `/reset-model-cooldown` — clear all target cooldowns (every process sees
  the reset); appends a confirmation entry to the transcript.

## Troubleshooting

- **Footer shows a cooling target** — the alias is serving from a fallback;
  expand the transcript warning for the failure reason, or clear state with
  `/reset-model-cooldown`.
- **Debug log** — `logs/pi-model-alias-debug.jsonl` inside this directory
  records loads, open attempts, failovers, cooldown changes, and UI errors
  (1 MiB rotation, previous file kept as `.old`).
- **Cooldown state** — `logs/cooldown-state.json`; entries expire on their
  own and stale entries are pruned after an hour.

## Development

```bash
node --test __tests__/*.test.ts
```

Module layout: `index.ts` (composition root), `alias-config.ts` (map
loading), `alias-model.ts` (model factory + metadata), `alias-stream.ts`
(fallback stream orchestration), `fallback.ts` (chain policy + cooldown
registry), `cooldown-store.ts` (shared file-backed store), `transcript.ts`
(entries + renderers), `session-status.ts` / `status.ts` (footer),
`debug-log.ts` (JSONL logging).
