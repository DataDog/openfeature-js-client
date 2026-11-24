const assert = require('node:assert/strict')
const fs = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const webpack = require('webpack')
const webpackBase = require('../../webpack.base')

test('CDN bundles transpile lossless-json to the declared ES2018 target', async (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'webpack-base-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const config = webpackBase({
    mode: 'production',
    entry: require.resolve('lossless-json'),
    filename: 'lossless-json.js',
  })
  config.output = { ...config.output, path: root, library: { type: 'commonjs2' } }
  await new Promise((resolve, reject) => {
    const compiler = webpack(config)
    compiler.run((error, stats) => {
      compiler.close((closeError) => {
        if (error || closeError) return reject(error || closeError)
        if (stats.hasErrors()) return reject(new Error(stats.toString()))
        resolve()
      })
    })
  })
  const bundle = path.join(root, 'lossless-json.js')
  webpack.javascript.JavascriptParser._parse(fs.readFileSync(bundle, 'utf8'), {
    ecmaVersion: 2018,
    sourceType: 'script',
  })
  const api = require(bundle)
  assert.equal(api.stringify(api.parse('{"value":1e999}')), '{"value":1e999}')
})
