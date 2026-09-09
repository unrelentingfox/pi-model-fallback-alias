# Releasing

## Initial publication

Version `0.1.0` was published manually before automated releases were enabled.
The Release Please manifest and bootstrap commit preserve it as the release
baseline.

## Automated releases

Every push to `main` runs Release Please. It opens or updates a release pull
request from [Conventional Commits](https://github.com/googleapis/release-please#how-should-i-write-my-commits).
Use `feat` for a minor release, `fix` for a patch release, and `!` or a
`BREAKING CHANGE:` footer for a major release. Merging that pull request
creates the matching GitHub release. The workflow publishes the current
missing from npm, so rerunning it after a registry failure is safe. Versions
already present on npm are skipped. After a registry failure, rerun the failed
Release workflow or push another commit to `main`; the `detect-publish` job will
retry the missing version.

The `npm` GitHub environment must remain enabled, and npm trusted publishing
must authorize:

- Repository: `unrelentingfox/pi-model-fallback-alias`
- Workflow: `release.yml`
- Environment: `npm`

Confirm each release in the GitHub Actions Release run and on npm.
