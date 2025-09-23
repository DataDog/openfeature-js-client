# Changelog

> **Legend**
>
> See [Gitmoji](https://gitmoji.dev/) for a guide on the emojis used.

---

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
