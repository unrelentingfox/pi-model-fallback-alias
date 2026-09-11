# Changelog

## [0.1.2](https://github.com/unrelentingfox/pi-model-fallback-alias/compare/v0.1.1...v0.1.2) (2026-09-11)


### Bug Fixes

* clear non-alias model status ([#19](https://github.com/unrelentingfox/pi-model-fallback-alias/issues/19)) ([01780f9](https://github.com/unrelentingfox/pi-model-fallback-alias/commit/01780f911e27c3ecdb185c8fa39eb831b6ac5680))
* retry missing npm releases ([bfde318](https://github.com/unrelentingfox/pi-model-fallback-alias/commit/bfde318a31f8e426ad08d31f1a94497dd62f9c0a))

## [0.1.1](https://github.com/unrelentingfox/pi-model-fallback-alias/compare/v0.1.0...v0.1.1) (2026-09-09)


### Bug Fixes

* refresh selected model status ([81b9efc](https://github.com/unrelentingfox/pi-model-fallback-alias/commit/81b9efcf4011715935fc262431ab9f56df53e046))

## 0.1.0

Initial public release.

- Register stable `alias/*` models backed by configurable target chains.
- Fail over before output commits and share target cooldowns across processes.
- Support nested aliases, latency timeouts, status output, and latency reports.
- Store runtime state outside the installed package directory.
