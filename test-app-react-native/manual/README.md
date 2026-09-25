# Manual React Native runtime check

This is a launchable Expo app, separate from the Node-executed Metro smoke fixture
in the parent directory. It evaluates a **locally packed** `@datadog/flagging-core`
on **Hermes** on an iOS/Android simulator, emulator, or physical device. It needs no
Datadog credentials or running backend.

## Prepare and launch

Prerequisites: the repository's Yarn dependencies installed, Node compatible with
Expo SDK 57 / React Native 0.86 (Node 24 works), and either:

- Xcode and an installed iOS simulator on macOS;
- Android Studio with a running Android emulator; or
- Expo Go compatible with SDK 57 on a physical phone (on the same network as Metro).

From the repository root:

```sh
yarn example:react-native
```

This builds the current local core source via `yarn pack` (including its `prepack`
hook), refreshes this tracked template and the smoke-test configurations in a
**reusable cache directory outside the workspace**, installs the new tarball with
npm, and type-checks the app. The same command handles both initial setup and every
subsequent rebuild; it does not fetch a published core version, publish anything,
or start Metro. The final output prints the exact commands:

```sh
cd /path/printed/by/the/setup/script
npm start
```

Press **i** for iOS, **a** for Android, or scan the QR code in Expo Go. You can also
use `npm run ios` or `npm run android`. No native build or CocoaPods install is
needed when using Expo Go. If Expo Go reports an SDK mismatch, use a compatible
Expo Go version from <https://expo.dev/go>; iOS physical devices may only support
the current store version, so use a simulator if necessary.

The template is not intended to be installed in place: a uniquely named core
tarball and its dependency entry, `configurations.js`, and `build-info.json` are
supplied by the setup script.
Dependencies are installed with lifecycle scripts disabled; evaluation itself is
offline. Initial dependency/Expo Go installation requires network access.

## What success looks like

The screen must show **Hermes**, **ALL CHECKS PASSED**, and **10/10**. It displays the
package version, source commit (including a dirty-tree indicator), packing time,
and tarball checksum prefix, plus results for:

- Public root and `/rules-based` imports and protobuf serialization round-trip.
- Boolean rule: `true`, variant `on`, reason `STATIC`.
- Integer rule: `42`, reason `STATIC`.
- Precomputed evaluation with a matching context, and `INVALID_CONTEXT` otherwise.
- Rules fallback for a mixed configuration.
- Root parser retaining its precomputed-only behavior.
- 1,000 repeated, checked evaluations with informational elapsed time.

Use **Run checks again** to repeat evaluations. The timing is not a benchmark or
performance gate, especially in development mode. The app uses the runtime's real
globals; it does not remove globals from React Native. The existing
`yarn test:react-native-install` separately covers missing `TextEncoder`,
`TextDecoder`, and `BigInt` in Node.

A browser/Node run cannot satisfy the native-Hermes check. Do not use web or an old
remote-JS-debugging mode that executes JavaScript in Chrome. React Native DevTools
that inspect the existing Hermes runtime are fine.

## Exercise the resolution modes

Stop Metro with Ctrl-C before each change, then fully reload the app. Each command
clears Metro's cache and sets both the displayed mode and resolver configuration:

| Command                    | Resolution                                              | Expected `/rules-based` path in Metro's terminal |
| -------------------------- | ------------------------------------------------------- | ------------------------------------------------ |
| `npm start`                | **Legacy CommonJS** (default; package exports disabled) | `bundle/legacy/cjs/rules-based.js`               |
| `npm run start:legacy-esm` | Legacy ESM (exports disabled, `module` preferred)       | `bundle/legacy/esm/rules-based.js`               |
| `npm run start:modern`     | Package exports enabled                                 | Metro-selected path; see note below              |

Run each mode on the platforms you care about. Metro logs the actual SDK files it
resolves; the app does not alias them. With the pinned Expo/Metro version, the
exports-enabled mode can still choose the physical `rules-based/package.json`
entrypoint and its legacy CJS bundle. **Enabling exports alone is not proof that the
modern parser was exercised**; use the logged paths as evidence. This app deliberately
does not force a different result with aliases.

A resolver/bundling failure may appear in Metro or Expo's error screen before the
result UI can load.

To also try an optimized JS bundle, append `--no-dev --minify`, for example:

```sh
npm start -- --no-dev --minify
```

This still uses Expo Go, not a standalone release build, and targets the pinned
modern RN version rather than every historical Hermes/Metro combination.

## Iterating on the SDK

1. Stop the app's Metro server with Ctrl-C.
2. Change core or example source in the repository.
3. Run `yarn example:react-native` again from the repository root.
4. Run `npm start` in the **same generated app directory** and reload the native app.

Each run rebuilds core, installs a uniquely named tarball, and updates the on-screen
build metadata. An unchanged package version cannot silently reuse an old artifact.
The command reuses `node_modules`, the npm lockfile and Expo state; superseded
managed tarballs are removed after a successful install and typecheck. `npm start`
clears Metro's cache. Fast Refresh alone does **not** rebuild or reinstall the SDK.

The generated app lives under
`${XDG_CACHE_HOME:-$HOME/.cache}/datadog/flagging-core-react-native/<checkout-hash>`.
The hash uses the checkout's real path: each checkout gets its own app, and symlink
aliases of a checkout share one. Keep this cache **outside the repository** so Metro
cannot resolve workspace packages instead of the installed tarball.

**Edit the tracked template, not the generated copy.** Its UI, checks, configuration,
README, and package manifest are refreshed from git's working tree on every run.
No generated app files, dependency lockfiles, or tarballs are committed to git.
Deleting the printed cache directory resets the app; the next command recreates it.
Earlier one-off `/tmp/flagging-core-react-native.*` apps are not migrated and may be
deleted once their Metro server is stopped.

Concurrent preparations of the same app are rejected. If an interrupted process
leaves `.prepare.lock` in the generated directory, first verify no preparation is
still running, then remove that lock and rerun the command.
