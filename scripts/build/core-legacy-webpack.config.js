const path = require('node:path')
const webpack = require('webpack')

const packageRoot = path.resolve(__dirname, '../../packages/core')

// Only legacy directory resolution uses these bundles. Keep the root entrypoint and
// modern exports modular, so precomputed-only consumers do not acquire protobuf.
module.exports = () =>
  ['cjs', 'esm'].map((format) => ({
    name: `core-legacy-${format}`,
    mode: 'production',
    // Run the encoding fallback before protobuf descriptors initialize, and make it
    // an explicit entry so tree-shaking cannot discard this side-effect-only setup.
    entry: [
      path.join(packageRoot, 'esm/configuration/protobuf-text-encoding.js'),
      path.join(packageRoot, 'esm/rules-based-configuration-wire.js'),
    ],
    target: ['web', 'es2015'],
    devtool: 'source-map',
    // These unminified library artifacts are not application entrypoint-size budgets.
    performance: { hints: false },
    experiments: { outputModule: format === 'esm' },
    output: {
      path: path.join(packageRoot, 'bundle/legacy', format),
      filename: 'rules-based.js',
      library: { type: format === 'esm' ? 'module' : 'commonjs2' },
      module: format === 'esm',
      environment: { bigIntLiteral: false },
    },
    // Bundle protobuf, including /wire and /codegenv2, rather than leaving external
    // imports which would still require package-exports support in the consumer.
    externals: [],
    optimization: {
      // Let the consuming application minify. Preserve dependency copyright/license
      // comments in the distributed JavaScript as well as the source maps.
      minimize: false,
      runtimeChunk: false,
      splitChunks: false,
    },
    plugins: [
      new webpack.optimize.LimitChunkCountPlugin({ maxChunks: 1 }),
      ...(format === 'esm' ? [esmPackageTypePlugin] : []),
    ],
  }))

const esmPackageTypePlugin = {
  apply(compiler) {
    compiler.hooks.thisCompilation.tap('CoreLegacyEsmPackageType', (compilation) => {
      compilation.hooks.processAssets.tap(
        {
          name: 'CoreLegacyEsmPackageType',
          stage: webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONS,
        },
        () => {
          compilation.emitAsset('package.json', new webpack.sources.RawSource('{"type":"module"}\n'))
        }
      )
    })
  },
}
