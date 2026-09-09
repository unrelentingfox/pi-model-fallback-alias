# Contributing

1. Use Node 22.19 or newer.
2. Run `npm ci`.
3. Run `npm run hooks:install` once per clone to enable the tracked Git hooks.
4. Run `npm run check` before opening a pull request.
5. Keep model examples provider-neutral and never commit credentials or runtime state.

## Commit messages

Use [Release Please Conventional Commits](https://github.com/googleapis/release-please#how-should-i-write-my-commits):

```text
type(scope)!: description
```

The scope and `!` are optional. Use `feat` for a minor release, `fix` for a
patch release, and `!` or a `BREAKING CHANGE:` footer for a major release.
Other Conventional Commit types are valid but do not normally trigger a
release. Prefer a squash merge so the final commit produces one clear
changelog entry.

The tracked `commit-msg` hook rejects non-conforming subjects. Run
`npm run hooks:install` once per clone to enable it.

Follow [RELEASING.md](RELEASING.md); merging the Release Please pull request
creates the GitHub release and publishes it to npm with provenance.
