const assert = require('node:assert/strict')
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { main, isBundleReportPath, hasBundleRelevantChanges } = require('../comment-entrypoint-bundle-sizes')

for (const filename of [
  'packages/browser/src/index.ts',
  'packages/browser/package.json',
  'packages/core/src/configuration/generated/ufc_pb.ts',
  'packages/core/tsconfig.esm.json',
  'test-app/src/provider.ts',
  'test-app/vite.config.ts',
  'scripts/build/replace-build-env.js',
  'scripts/lib/buildEnv.js',
  'scripts/webpack-runner.js',
  'scripts/test-package-install.sh',
  'scripts/report-entrypoint-bundle-sizes.js',
  'scripts/comment-entrypoint-bundle-sizes.js',
  'package.json',
  'yarn.lock',
  'lerna.json',
  'tsconfig.json',
  'tsconfig.base.json',
  'webpack.base.js',
  '.yarnrc.yml',
  '.yarn/releases/yarn-4.10.3.cjs',
  '.yarn/patches/dependency.patch',
  '.npmrc',
  '.github/workflows/ci.yaml',
]) {
  test(`includes bundle-relevant path ${filename}`, () => {
    assert.equal(isBundleReportPath(filename), true)
  })
}

for (const filename of [
  undefined,
  'README.md',
  'CONTRIBUTING.md',
  'packages/browser/README.md',
  'packages/core/CHANGELOG.MD',
  'test-app/README.markdown',
  'scripts/lib/README.md',
  'packages/node-server/src/index.ts',
  'packages/node-server/package.json',
  'packages/browser-tools/index.js',
  'scripts/test-node-package-install.sh',
  '.github/workflows/licenses.yaml',
  'tools/tsconfig.json',
  'webpack-tools/index.js',
]) {
  test(`excludes unrelated or Markdown path ${filename}`, () => {
    assert.equal(isBundleReportPath(filename), false)
  })
}

const pullRequestPath = '/repos/DataDog/openfeature-js-client/pulls/401'
const docsPage = Array.from({ length: 100 }, (_, index) => ({ filename: `docs/page-${index}.md` }))

test('checks all PR files across pages, not only the latest commit', async () => {
  const calls = []
  const request = async (route) => {
    calls.push(route)
    return calls.length === 1 ? docsPage : [{ filename: 'packages/core/src/index.ts', status: 'modified' }]
  }
  assert.equal(await hasBundleRelevantChanges(request, pullRequestPath), true)
  assert.deepEqual(calls, [
    `${pullRequestPath}/files?per_page=100&page=1`,
    `${pullRequestPath}/files?per_page=100&page=2`,
  ])
})

test('skips a paginated PR with no bundle-relevant files', async () => {
  let calls = 0
  const request = async () => (++calls === 1 ? docsPage : [{ filename: 'packages/node-server/src/index.ts' }])
  assert.equal(await hasBundleRelevantChanges(request, pullRequestPath), false)
  assert.equal(calls, 2)
})

for (const file of [
  { filename: 'packages/core/src/removed.ts', status: 'removed' },
  { filename: 'packages/browser/src/new.ts', previous_filename: 'other/old.ts', status: 'renamed' },
  { filename: 'other/moved.ts', previous_filename: 'packages/browser/src/old.ts', status: 'renamed' },
]) {
  test(`includes ${file.status} file ${file.filename}`, async () => {
    assert.equal(await hasBundleRelevantChanges(async () => [file], pullRequestPath), true)
  })
}

test('skips Markdown-only renames within relevant directories', async () => {
  const file = {
    filename: 'packages/core/README.md',
    previous_filename: 'packages/browser/README.md',
    status: 'renamed',
  }
  assert.equal(await hasBundleRelevantChanges(async () => [file], pullRequestPath), false)
})

test('publishes conservatively when GitHub truncates the PR file list', async (t) => {
  t.mock.method(console, 'log', () => {})
  let calls = 0
  const request = async () => {
    calls++
    return docsPage
  }
  assert.equal(await hasBundleRelevantChanges(request, pullRequestPath), true)
  assert.equal(calls, 30)
})

for (const scenario of ['skip', 'create', 'update']) {
  test(`${scenario} PR comment using the path filter`, async (t) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'flagging-bundle-comment-'))
    const reportPath = path.join(directory, 'report.md')
    const eventPath = path.join(directory, 'event.json')
    writeFileSync(reportPath, 'Bundle report fixture')
    writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 401 } }))
    const environment = {
      GITHUB_TOKEN: 'test-token',
      GITHUB_REPOSITORY: 'DataDog/openfeature-js-client',
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_API_URL: 'https://api.github.test',
    }
    const previousEnvironment = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]))
    const previousArgv = process.argv
    t.after(() => {
      process.argv = previousArgv
      for (const [key, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(directory, { recursive: true, force: true })
    })
    Object.assign(process.env, environment)
    process.argv = [process.execPath, 'comment-entrypoint-bundle-sizes.js', reportPath]
    t.mock.method(console, 'log', () => {})

    const calls = []
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      const route = new URL(url).pathname + new URL(url).search
      calls.push({ route, method: options.method, body: options.body })
      let data
      if (calls.length === 1) {
        assert.equal(route, `${pullRequestPath}/files?per_page=100&page=1`)
        data = [{ filename: scenario === 'skip' ? 'packages/browser/README.md' : 'packages/browser/src/index.ts' }]
      } else if (calls.length === 2) {
        assert.equal(route, '/repos/DataDog/openfeature-js-client/issues/401/comments?per_page=100')
        data = scenario === 'update' ? [{ id: 42, body: '<!-- datadog-openfeature-entrypoint-bundle-sizes -->' }] : []
      } else {
        data = { id: 42 }
      }
      return { ok: true, status: 200, json: async () => data }
    })

    await main()
    assert.equal(calls.length, scenario === 'skip' ? 1 : 3)
    assert.equal(calls[0].method, 'GET')
    if (scenario !== 'skip') {
      assert.equal(calls[1].method, 'GET')
      assert.equal(calls[2].method, scenario === 'create' ? 'POST' : 'PATCH')
      assert.equal(
        calls[2].route,
        scenario === 'create'
          ? '/repos/DataDog/openfeature-js-client/issues/401/comments'
          : '/repos/DataDog/openfeature-js-client/issues/comments/42'
      )
      assert.match(JSON.parse(calls[2].body).body, /Bundle report fixture/)
    }
  })
}
