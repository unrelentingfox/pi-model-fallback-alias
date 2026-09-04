# Releasing

## First publication

This package does not yet exist on npm, so OpenID Connect (OIDC) trusted publishing cannot bootstrap it.

1. Log in with `npm login` and verify `npm whoami`.
2. Run all checks and inspect `npm pack --dry-run --json`.
3. Publish `0.1.0` once with `npm publish --access public` and two-factor authentication.
4. On npm, configure the trusted publisher for:
   - Repository: `unrelentingfox/pi-model-fallback-alias`
   - Workflow: `release.yml`
   - Environment: `npm`
5. Keep the GitHub `npm` environment enabled.

The manual first publication will not have GitHub provenance. Do not create the `v0.1.0` GitHub release until the npm publication succeeds.

## Later releases

1. Update `package.json`, the lockfile, and `CHANGELOG.md`.
2. Merge with CI passing.
3. Publish a GitHub release tagged `v<version>`.
4. Confirm the Release workflow publishes the matching npm version with provenance.
