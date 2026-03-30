# Changelog

> **Legend**
>
> See [Gitmoji](https://gitmoji.dev/) for a guide on the emojis used.

---

## v1.1.1

**Internal Changes:**

- 👷 chore(deps)(deps): Bump picomatch from 2.3.1 to 2.3.2 ([#229](https://github.com/DataDog/openfeature-js-client/pull/229))
- 👷 chore(deps)(deps): Bump tar from 7.5.7 to 7.5.11 ([#226](https://github.com/DataDog/openfeature-js-client/pull/226))
- 👷 chore(deps-dev)(deps-dev): Bump the dev-dependencies group with 6 updates ([#214](https://github.com/DataDog/openfeature-js-client/pull/214))
- 👷 chore(deps-dev)(deps-dev): Bump jsdom from 28.1.0 to 29.0.1 ([#217](https://github.com/DataDog/openfeature-js-client/pull/217)) [BROWSER]
- 👷 chore(deps-dev)(deps-dev): Bump the dev-dependencies group across 1 directory with 14 updates ([#203](https://github.com/DataDog/openfeature-js-client/pull/203)) [BROWSER] [NODE-SERVER]
- 👷 chore(deps)(deps): Bump tmp from 0.2.3 to 0.2.5 ([#174](https://github.com/DataDog/openfeature-js-client/pull/174))
- fix: allow null targeting key for static and rule-only flags ([#232](https://github.com/DataDog/openfeature-js-client/pull/232)) [NODE-SERVER]
- re-enable dependabot with 14-day cooldown ([#220](https://github.com/DataDog/openfeature-js-client/pull/220))
- chore: disable automated dependency updater config [incident-51602] ([#219](https://github.com/DataDog/openfeature-js-client/pull/219))
- Pin GitHub Actions ([#212](https://github.com/DataDog/openfeature-js-client/pull/212))
- fix: handle concurrent onContextChange calls ([#213](https://github.com/DataDog/openfeature-js-client/pull/213)) [BROWSER] [NODE-SERVER]
- DEPENDENCY UPGRADE: jsdom (major → 28.1.0) [packages/browser] ([#202](https://github.com/DataDog/openfeature-js-client/pull/202)) [BROWSER]
- DEPENDENCY UPGRADE: minor upgrades — 6 packages (minor: 2 · patch: 4) [packages/node-server] ([#211](https://github.com/DataDog/openfeature-js-client/pull/211))
- DEPENDENCY UPGRADE: minor upgrades — 6 packages (minor: 2 · patch: 4) [packages/node-server] ([#198](https://github.com/DataDog/openfeature-js-client/pull/198)) [BROWSER] [NODE-SERVER]
- DEPENDENCY UPGRADE: minor upgrades — 4 packages (minor: 2 · patch: 2) [packages/core] ([#210](https://github.com/DataDog/openfeature-js-client/pull/210)) [BROWSER] [NODE-SERVER]
- Executing automated changes ([#209](https://github.com/DataDog/openfeature-js-client/pull/209))
- Executing automated changes ([#208](https://github.com/DataDog/openfeature-js-client/pull/208))
- Executing automated changes ([#201](https://github.com/DataDog/openfeature-js-client/pull/201))
- Executing automated changes ([#200](https://github.com/DataDog/openfeature-js-client/pull/200))
- Executing automated changes ([#199](https://github.com/DataDog/openfeature-js-client/pull/199)) [NODE-SERVER]
- fix: licenses must be run on an attached branch ([#207](https://github.com/DataDog/openfeature-js-client/pull/207))
- chore: ensure license generation can be run locally ([#206](https://github.com/DataDog/openfeature-js-client/pull/206))
- test: polyfill fetch in jsdom environment ([#205](https://github.com/DataDog/openfeature-js-client/pull/205)) [BROWSER]
- Return FLAG_NOT_FOUND error for non-existent flags ([#204](https://github.com/DataDog/openfeature-js-client/pull/204)) [NODE-SERVER]
- Publish all packages in single step, skip already-published versions ([#196](https://github.com/DataDog/openfeature-js-client/pull/196))
- Switch to Node 24 and add --provenance for OIDC trusted publishing ([#195](https://github.com/DataDog/openfeature-js-client/pull/195))
- Remove registry-url from setup-node to fix OIDC publishing ([#194](https://github.com/DataDog/openfeature-js-client/pull/194))
- Bump node to 22.x across all workflows for npm OIDC support ([#192](https://github.com/DataDog/openfeature-js-client/pull/192))
- Migrate NPM publishing from token auth to OIDC trusted publishing ([#191](https://github.com/DataDog/openfeature-js-client/pull/191))
- Release v1.1.0 ([#189](https://github.com/DataDog/openfeature-js-client/pull/189)) [BROWSER] [NODE-SERVER]

## v1.1.0

**Behavior Changes:**

- Add IndexedDB persistence for browser flag configurations ([#186](https://github.com/DataDog/openfeature-js-client/pull/186)) [BROWSER]
- Enable RUM feature flag tracking by default if RUM is available ([#176](https://github.com/DataDog/openfeature-js-client/pull/176)) [BROWSER]

**Internal Changes:**

- 👷 chore(deps-dev)(deps-dev): Bump lerna from 8.2.3 to 9.0.3 ([#173](https://github.com/DataDog/openfeature-js-client/pull/173))
- 👷 chore(deps)(deps): Bump lodash from 4.17.21 to 4.17.23 ([#169](https://github.com/DataDog/openfeature-js-client/pull/169))
- 👷 ci(deps)(deps): Bump the github-actions group with 4 updates ([#168](https://github.com/DataDog/openfeature-js-client/pull/168))
- 👷 chore(deps)(deps): Bump js-yaml from 3.14.1 to 3.14.2 ([#170](https://github.com/DataDog/openfeature-js-client/pull/170))
- Fix license validation CI and improve developer docs ([#187](https://github.com/DataDog/openfeature-js-client/pull/187))
- Executing automated changes ([#182](https://github.com/DataDog/openfeature-js-client/pull/182)) [NODE-SERVER]
- Executing automated changes ([#181](https://github.com/DataDog/openfeature-js-client/pull/181)) [BROWSER]
- VULN UPGRADE: minor upgrades — 8 packages (minor: 4 · patch: 4) ([#180](https://github.com/DataDog/openfeature-js-client/pull/180)) [BROWSER]
- Executing automated changes ([#177](https://github.com/DataDog/openfeature-js-client/pull/177))
- Release v1.0.0 - GA ([#166](https://github.com/DataDog/openfeature-js-client/pull/166)) [BROWSER] [NODE-SERVER]
- Simplify Dependabot config with grouping and auto-merge ([#167](https://github.com/DataDog/openfeature-js-client/pull/167))

## v1.0.0

**Behavior Changes:**

- Default enableExposureLogging to true ([#152](https://github.com/DataDog/openfeature-js-client/pull/152)) [BROWSER]

## v0.3.3

**Internal Changes:**

- fix: sdk metadata param names to match backend expectation

## v0.3.2

**Internal Changes:**

- 👷 ci(deps): bump actions/setup-go from 6.0.0 to 6.1.0 ([#105](https://github.com/DataDog/openfeature-js-client/pull/105))
- 👷 ci(deps): bump actions/setup-python from 6.0.0 to 6.1.0 ([#107](https://github.com/DataDog/openfeature-js-client/pull/107))
- 👷 ci(deps): bump actions/setup-node from 4.4.0 to 6.1.0 ([#104](https://github.com/DataDog/openfeature-js-client/pull/104))
- fix(core): resolve peer dependency errors for dd-trace-js users ([#150](https://github.com/DataDog/openfeature-js-client/pull/150)) [BROWSER] [NODE-SERVER]
- bug: allow empty string as valid targeting key in evaluation (FFL-1730) ([#142](https://github.com/DataDog/openfeature-js-client/pull/142)) [NODE-SERVER]
- fix(core): include empty string targeting keys in flag evaluation events ([#141](https://github.com/DataDog/openfeature-js-client/pull/141)) [BROWSER] [NODE-SERVER]

## v0.3.1

**Internal Changes:**

- 👷 chore(deps-dev): bump prettier from 3.6.2 to 3.7.4 ([#124](https://github.com/DataDog/openfeature-js-client/pull/124))
- 👷 chore(deps-dev): bump ts-jest from 29.4.0 to 29.4.6 ([#122](https://github.com/DataDog/openfeature-js-client/pull/122))
- fix(browser): prevent exposure cache from being cleared on page load ([#136](https://github.com/DataDog/openfeature-js-client/pull/136)) [BROWSER]
- chore: don't group package updates ([#103](https://github.com/DataDog/openfeature-js-client/pull/103))

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
