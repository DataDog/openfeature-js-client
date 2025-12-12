# Changelog

> **Legend**
>
> See [Gitmoji](https://gitmoji.dev/) for a guide on the emojis used.

---

## v0.3.0

**Internal Changes:**

- chore:add dependabot ([#97](https://github.com/DataDog/openfeature-js-client/pull/97))
- [EX-1234] Add flagevaluation tracking event emission. ([#94](https://github.com/DataDog/openfeature-js-client/pull/94)) [BROWSER] [NODE-SERVER]
- drop support for RUM custom actions exposure logging ([#95](https://github.com/DataDog/openfeature-js-client/pull/95)) [BROWSER]
- chore: validate license name, script python requirements ([#93](https://github.com/DataDog/openfeature-js-client/pull/93))
- docs: update contributing with guide to install dd-license-attribution ([#96](https://github.com/DataDog/openfeature-js-client/pull/96))
- Update copyright notice to 2025-present ([#92](https://github.com/DataDog/openfeature-js-client/pull/92)) [BROWSER] [NODE-SERVER]
- remove preview tag from docs ([#91](https://github.com/DataDog/openfeature-js-client/pull/91))
- chore: validate version consistency in CI ([#90](https://github.com/DataDog/openfeature-js-client/pull/90))
- chore(deps-dev): bump glob from 11.0.3 to 11.1.0 ([#88](https://github.com/DataDog/openfeature-js-client/pull/88))
- chore: CI check to validate licenses are up to date ([#89](https://github.com/DataDog/openfeature-js-client/pull/89))
- chore: upgrade to latest version of openfeature sdk ([#87](https://github.com/DataDog/openfeature-js-client/pull/87)) [NODE-SERVER]

## v0.2.0

**Internal Changes:**

- chore(deps): bump axios from 1.10.0 to 1.13.2 ([#85](https://github.com/DataDog/openfeature-js-client/pull/85))
- Add application.id, view.url, and service properties to browser exposure events. ([#78](https://github.com/DataDog/openfeature-js-client/pull/78)) [BROWSER] [NODE-SERVER]

## v0.1.0

## v0.1.0-preview.16

**Internal Changes:**

- feat: initialization timeout in node OF provider ([#79](https://github.com/DataDog/openfeature-js-client/pull/79)) [NODE-SERVER]
- fix: run prettier and add it to CI ([#80](https://github.com/DataDog/openfeature-js-client/pull/80)) [BROWSER] [NODE-SERVER]

## v0.1.0-preview.15

- Internal updates

## v0.1.0-preview.14

- Internal updates

## v0.1.0-preview.13

- Internal updates

## v0.1.0-preview.12

**Internal Changes:**

- point README to @preview
- fix: install core tarball into browser when testing pack ([#67](https://github.com/DataDog/openfeature-js-client/pull/67))
- fix: remove 'src' reference, add testing ([#65](https://github.com/DataDog/openfeature-js-client/pull/65)) [BROWSER] [NODE-SERVER]

## v0.1.0-preview.11

**Internal Changes:**

- FFL-1239 Remap actual variationType to expected values ([#63](https://github.com/DataDog/openfeature-js-client/pull/63)) [BROWSER]

## v0.1.0-preview.10

**Internal Changes:**

- fix: allow for experimentation to clear exposure cache
- feat: in-memory exposure caching for server SDK
- fix: initialization errors not surfacing in browser sdk
- feat: deduplication of exposure logging in browser SDK
- chore(deps): bump form-data from 4.0.3 to 4.0.4

## v0.1.0-preview.9

**Internal Changes:**

- fix: remove @openfeature/web-sdk dependency in core sdk

## v0.1.0-preview.8

**Internal Changes:**

- fix: support Node 18 in Node SDK
- chore: fix linting and formatting issues

## v0.1.0-preview.7

**Internal Changes:**

- fix: non-exported core functionality
- fix: issues with status not emitting correctly in node sdk
- fix: include spark-md5 in the correct package
- fix: hooks availability in node sdk

## v0.1.0-preview.6

**Internal Changes:**

- feat: exposure logging in node sdk

## v0.1.0-preview.5

**Internal Changes:**

- feat: OpenFeature support for NodeJS, internal package support only
- chore: fix editor errors in jest test files

## v0.1.0-preview.4

**Internal Changes:**

- fix: export FlaggingInitConfiguration ([#36](https://github.com/DataDog/openfeature-js-client/pull/36)) [BROWSER]
- chore: remove env name param from request and add sdk details ([#34](https://github.com/DataDog/openfeature-js-client/pull/34)) [BROWSER]

## v0.1.0-preview.3

**Internal Changes:**

- Match RELEASE_TAG on preview to tag correctly. ([#31](https://github.com/DataDog/openfeature-js-client/pull/31))

## v0.1.0-alpha.15

**Internal Changes:**

- fix: browser-core dep ([#28](https://github.com/DataDog/openfeature-js-client/pull/28)) [BROWSER]

## v0.1.0-alpha.14

**Internal Changes:**

- add files to browser/core package.json to (hopefully) pack esm directory for import in shopist ([#26](https://github.com/DataDog/openfeature-js-client/pull/26)) [BROWSER]
- Add support for publishing preview releases. ([#25](https://github.com/DataDog/openfeature-js-client/pull/25))
- bump docs for alpha 13; required & optional init ([#24](https://github.com/DataDog/openfeature-js-client/pull/24))

## v0.1.0-alpha.13

**Internal Changes:**

- [FFL-888] feat: use fastly endpoints ([#22](https://github.com/DataDog/openfeature-js-client/pull/22)) [BROWSER]
- [FFL-887] Make application ID an optional param ([#21](https://github.com/DataDog/openfeature-js-client/pull/21)) [BROWSER]

## v0.1.0-alpha.12

**Internal Changes:**

- fix: preserve proxy protocol, add app key and api key to config ([#17](https://github.com/DataDog/openfeature-js-client/pull/17)) [BROWSER]

## v0.1.0-alpha.11

**Internal Changes:**

- docs: add lightweight documentation to README.md ([#14](https://github.com/DataDog/openfeature-js-client/pull/14))
- [FFL-450] Add exposures logging to EVP track ([#10](https://github.com/DataDog/openfeature-js-client/pull/10)) [BROWSER]

## v0.1.0-alpha.9

**Internal Changes:**

- drop extra changelog entry
- add subject attributes to exposure log [BROWSER]
- Revert "refactor: remove deprecated logging" [BROWSER]
- refactor: remove deprecated logging [BROWSER]
- feat: update timestamps to use unix format [BROWSER]
- test: add tests for exposures [BROWSER]
- chore: use jsdom test environment [BROWSER]
- [FFL-450] Add exposures logging to EVP track [BROWSER]
- chore: run format:fix ([#12](https://github.com/DataDog/openfeature-js-client/pull/12)) [BROWSER]
- fix: better package to directory mapping ([#11](https://github.com/DataDog/openfeature-js-client/pull/11))
- feat: Lerna multi package build setup similar to browser-sdk ([#9](https://github.com/DataDog/openfeature-js-client/pull/9)) [BROWSER]

## v0.1.0-alpha.8

**Public Changes:**

- ✨ Initial OpenFeature JS client implementation [CORE] [BROWSER]

**Internal Changes:**

- 👷 Set up monorepo structure with Lerna [CORE] [BROWSER]
- 🔧 Configure build system with TypeScript and Webpack [CORE] [BROWSER]
- ✅ Add initial test setup [CORE] [BROWSER]
