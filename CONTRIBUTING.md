# Contributing

1. Use Node 22.19 or newer.
2. Run `npm ci`.
3. Run `npm run hooks:install` once per clone to enable the tracked Git hooks.
   This replaces any existing `core.hooksPath` for the clone.
4. Run `npm run check` before opening a pull request.
5. Keep model examples provider-neutral and never commit credentials or runtime state.

## Commit messages

Use [Release Please Conventional Commits](https://github.com/googleapis/release-please#how-should-i-write-my-commits):

```text
type(scope)!: description
```

The scope and `!` are optional. Use `feat` for a minor release, `fix` for a
patch release, and `deps` for a dependency release. Mark a breaking change
with `!` in the PR title for a major release. Squash is the only enabled merge
strategy, and GitHub discards the squash commit body, so branch commit footers
do not reach Release Please.

The optional local `commit-msg` hook keeps branch history consistent. Run
`npm run hooks:install` once per clone to enable it; `--no-verify` bypasses it.
The PR-title check is the release-format gate because GitHub uses the PR title
as the final squash commit subject. Repository rules must require this check.

Follow [RELEASING.md](RELEASING.md); merging the Release Please pull request
creates the GitHub release and publishes it to npm with provenance.
