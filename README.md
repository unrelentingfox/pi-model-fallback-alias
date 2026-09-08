# Pi Model Fallback Aliases

A [Pi](https://github.com/earendil-works/pi) extension that exposes stable
`alias/*` role models backed by configurable provider/model chains. It adds
pre-output failover, shared cooldowns, latency controls, footer status, and
durable transcript warnings without owning target-provider credentials.

## Install

Requires Node 22.19 or newer and is tested against Pi 0.84.4.

```bash
pi install npm:pi-model-fallback-alias@0.1.0
```

Run `/reload` in a live session after installation or configuration changes.

## Configuration

Aliases live in `<agent-dir>/model-alias.json`, normally
`~/.pi/agent/model-alias.json`. Set `PI_MODEL_ALIAS_MAP` to use another file.

```json
{
  "$defaults": {
    "timeouts": { "firstEventMs": 30000, "stallMs": 60000 },
    "cooldown": { "baseMs": 300000, "capMs": 3600000, "resetSuccesses": 3 }
  },
  "coder": [
    "provider-a/model-primary",
    "alias/fallback"
  ],
  "fallback": [
    "provider-b/model-secondary",
    "provider-c/model-tertiary"
  ]
}
```

Each key registers `alias/<key>` as a Pi model. A value can be a model string,
an ordered array, or an object with `targets`, `timeouts`, and `cooldown`.
Nested aliases are flattened at load time. Cycles, missing aliases, and nesting
deeper than four levels skip only the invalid reference and produce a warning.
Duplicate concrete targets keep their first position.

Use an alias anywhere Pi accepts a model reference:

```json
{
  "defaultProvider": "alias",
  "defaultModel": "coder"
}
```

## Behavior

- Failover advances on resolution, authentication, connection, and HTTP errors
  until output commits. It never swaps providers after text or tool output is
  visible.
- Start and thinking events are buffered before commit, so a failed attempt
  cannot leave partial protocol state behind.
- Failed concrete targets enter an exponential cooldown. State is shared by
  aliases and Pi processes. Cooled targets are skipped while alternatives
  remain and retried before final exhaustion.
- Per-role latency limits can cover time to first event, event stalls, and the
  total pre-commit interval. A timeout is active only while another target
  remains.
- The alias model mirrors the selected target's context window, output limit,
  and cost. Assistant messages preserve the logical alias identity while
  `responseModel` records the concrete model.
- `/reset-model-cooldown` clears shared cooldown state.
- `/alias-latency-report [role]` renders attempt statistics in the transcript.

## State and logs

Runtime state is outside the installed package. The default directory is:

```text
<agent-dir>/state/pi-model-fallback-alias/
```

Set `PI_MODEL_ALIAS_STATE_DIR` to an absolute or relative path to override it.
The directory contains:

- `cooldown-state.json`, atomically replaced and reloaded by modification time.
- `pi-model-alias-debug.jsonl`, a rotating troubleshooting and latency log.

The active log rotates after 1 MiB and retained archives expire after seven
days. Configure positive integer overrides with
`PI_MODEL_ALIAS_LOG_MAX_BYTES` and `PI_MODEL_ALIAS_LOG_RETENTION_DAYS`.

Logs contain alias roles, target references, durations, status codes, and
allowlisted request or trace identifiers. They do not record authorization
headers, cookies, request payloads, response bodies, alias configuration, or
provider credentials. Review logs before sharing them because model names and
request identifiers can still be operationally sensitive.

## Authentication and security

The extension's `alias` provider returns a fixed non-secret API-key value only
to mark aliases available to Pi's registry. Streaming discards that value and
resolves the selected target through Pi's provider registry.

When forwarding request options, target authentication replaces caller
authentication. The extension removes caller `authorization`, `x-api-key`,
`api-key`, `x-goog-api-key`, and `anthropic-*` headers. Other caller headers
only fill gaps left by target authentication. This prevents credentials from
one provider from crossing a failover boundary.

Pi extensions run with the Pi process's permissions. Review the source and
configuration before installation. See [SECURITY.md](SECURITY.md) for private
reporting.

## Troubleshooting

- **Alias is missing:** verify the map path and JSON, then run `/reload`.
- **Restored session cannot find an alias:** restore the role, select a current
  model, or start a new session.
- **Footer looks stale:** wait for the 30-second refresh, inspect transcript
  warnings, or run `/reset-model-cooldown`.
- **Policy edit is temporarily invalid:** existing aliases use their last valid
  policy and warn once per distinct failure. Replace configuration atomically
  to keep concurrent processes aligned.
- **Investigating provider failures:** correlate an allowlisted request or trace
  identifier with the record timestamp and provider/model. No credential or
  response body is written to the log.

## Development

```bash
npm ci
npm test
npm run typecheck
npm run check:pack
```

Tests use pinned Pi 0.84.4 development packages. Runtime Pi packages remain
optional wildcard peer dependencies because Pi supplies them when loading the
extension. Continuous integration tests Node 22.19 and Node 24.

Releases use semantic versioning. The first npm publication is manual; later
GitHub releases trigger an OpenID Connect (OIDC) trusted publish with
provenance. Follow [RELEASING.md](RELEASING.md) and update
[CHANGELOG.md](CHANGELOG.md).

Repository: https://github.com/unrelentingfox/pi-model-fallback-alias

## License

MIT. See [LICENSE](LICENSE).
