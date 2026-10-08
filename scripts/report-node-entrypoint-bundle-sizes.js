#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')
const { gzipSync } = require('node:zlib')
const webpack = require('webpack')

const scenarios = [
  { name: 'provider', label: 'Node provider only', expectProtobuf: false },
  { name: 'ssr', label: 'SSR helpers only (fetch client rules + serialize)', expectProtobuf: true },
  { name: 'provider-with-ssr', label: 'Node provider + SSR helpers', expectProtobuf: true },
]

function createWebpackConfigs(testAppDirectory) {
  // Separate compilations prevent cross-entrypoint used-export analysis from retaining extra code.
  return scenarios.map(({ name }) => ({
    name,
    mode: 'production',
    target: 'node18',
    context: testAppDirectory,
    entry: `./bundles/${name}.mjs`,
    output: {
      path: path.join(testAppDirectory, 'dist', 'bundles', name),
      filename: 'index.cjs',
      library: { type: 'commonjs2' },
      clean: true,
    },
    resolve: {
      // Resolve only installed tarballs, never the monorepo's workspace packages.
      modules: [path.join(testAppDirectory, 'node_modules')],
      conditionNames: ['module', 'import', 'node', 'default'],
      mainFields: ['module', 'main'],
    },
    optimization: { splitChunks: false, runtimeChunk: false },
    devtool: false,
  }))
}

function hasProtobufModules(modules) {
  return modules.some(
    (module) =>
      /node_modules\/@bufbuild\/protobuf\/|\/configuration\/generated\/ufc_pb\.js/.test(
        (module.name || '').replaceAll('\\', '/')
      ) || hasProtobufModules(module.modules || [])
  )
}

function measureBundles(distDirectory, builds) {
  return scenarios.map((scenario) => {
    const build = builds.find(({ name }) => name === scenario.name)
    if (!build) throw new Error(`Missing build statistics: ${scenario.name}`)
    const javascriptAssets = build.assets.filter(({ name }) => /\.(c|m)?js$/.test(name))
    if (javascriptAssets.length !== 1 || javascriptAssets[0].name !== 'index.cjs') {
      throw new Error(`Expected one standalone JavaScript bundle: ${scenario.name}`)
    }
    const content = fs.readFileSync(path.join(distDirectory, scenario.name, 'index.cjs'))
    if (content.length === 0) throw new Error(`Empty bundle: ${scenario.name}`)
    const hasProtobuf = hasProtobufModules(build.modules)
    if (hasProtobuf !== scenario.expectProtobuf) {
      throw new Error(
        `Unexpected Protobuf modules in ${scenario.name}: expected ${scenario.expectProtobuf}, got ${hasProtobuf}`
      )
    }
    return { ...scenario, rawBytes: content.length, gzipBytes: gzipSync(content).length, hasProtobuf }
  })
}

function formatBytes(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`
}

function renderMarkdown(measurements) {
  const provider = measurements.find(({ name }) => name === 'provider')
  const combined = measurements.find(({ name }) => name === 'provider-with-ssr')
  return [
    '### OpenFeature Node Server Bundle Sizes',
    '',
    'Independent Webpack production builds of the installed core and Node SDK tarballs, targeting Node 18 with ESM (`module` export condition). Node built-ins remain external. OpenFeature, dd-trace, and configuration fixtures are not bundled.',
    '',
    '| Scenario | Raw JS | Gzip JS | Protobuf Modules |',
    '| --- | ---: | ---: | --- |',
    ...measurements.map(
      ({ label, rawBytes, gzipBytes, hasProtobuf }) =>
        `| ${label} | ${formatBytes(rawBytes)} | ${formatBytes(gzipBytes)} | ${hasProtobuf ? 'yes' : 'no'} |`
    ),
    '',
    `Adding SSR helpers to the provider adds ${formatBytes(combined.rawBytes - provider.rawBytes)} raw / ${formatBytes(combined.gzipBytes - provider.gzipBytes)} gzip in this build. This includes fetching, parsing, and serialization, not just the decoder. SSR helpers fetch rules for the browser, not for configuring that provider (which uses its existing JSON API).`,
    '',
    'These are bundler sizes, not npm install sizes, unbundled Node require/import costs, payload sizes, or latency. Gzip compares compressed artifacts. The browser scenarios include OpenFeature and a different harness, so their sizes are not directly comparable.',
    '',
    'Dependency checks passed: no Protobuf runtime or generated schema modules in the provider-only bundle; present in both SSR bundles (checked using Webpack module statistics).',
  ].join('\n')
}

async function main() {
  const testAppDirectory = path.resolve(process.argv[2] || path.join(__dirname, '..', 'test-app-node'))
  const compiler = webpack(createWebpackConfigs(testAppDirectory))
  let stats
  try {
    stats = await new Promise((resolve, reject) => {
      compiler.run((error, stats) => {
        if (error) return reject(error)
        if (stats.hasErrors()) return reject(new Error(stats.toString({ all: false, errors: true })))
        resolve(stats)
      })
    })
  } finally {
    await new Promise((resolve, reject) => compiler.close((error) => (error ? reject(error) : resolve())))
  }

  const builds = stats.stats.map((build) => ({
    ...build.toJson({ all: false, assets: true, modules: true, nestedModules: true, orphanModules: false }),
    name: build.compilation.name,
  }))
  const report = renderMarkdown(measureBundles(path.join(testAppDirectory, 'dist', 'bundles'), builds))
  console.log(report)
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`)
  }
  if (process.env.ENTRYPOINT_BUNDLE_SIZE_REPORT_PATH) {
    const reportPath = path.resolve(process.env.ENTRYPOINT_BUNDLE_SIZE_REPORT_PATH)
    fs.mkdirSync(path.dirname(reportPath), { recursive: true })
    fs.writeFileSync(reportPath, `${report}\n`)
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}

module.exports = { createWebpackConfigs, hasProtobufModules, measureBundles, renderMarkdown }
