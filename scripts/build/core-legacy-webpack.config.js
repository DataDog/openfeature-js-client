const fs = require('node:fs')
const path = require('node:path')
const webpack = require('webpack')
const { getCoreEntrypoints } = require('../lib/coreEntrypoints')

// Every public JS subpath gets its own self-contained legacy bundles. There is no
// second registry to update when an engineer adds an export to package.json.
module.exports = ({ packageRoot = path.resolve(__dirname, '../../packages/core') } = {}) => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
  return getCoreEntrypoints(packageJson).flatMap((entry) =>
    ['cjs', 'esm'].map((format) => ({
      name: `core-legacy-${entry.name}-${format}`,
      mode: 'production',
      entry: path.resolve(packageRoot, entry.import),
      target: ['web', 'es2015'],
      devtool: 'source-map',
      // These unminified library artifacts are not application entrypoint-size budgets.
      performance: { hints: false },
      experiments: { outputModule: format === 'esm' },
      output: {
        path: path.join(packageRoot, 'bundle/legacy', format),
        filename: `${entry.name}.js`,
        library: { type: format === 'esm' ? 'module' : 'commonjs2' },
        module: format === 'esm',
        environment: { bigIntLiteral: false },
      },
      // Resolve dependencies now rather than leaving imports for the legacy consumer.
      externals: [],
      optimization: {
        // Application bundlers minify; distributed artifacts retain dependency notices.
        minimize: false,
        runtimeChunk: false,
        splitChunks: false,
      },
      plugins: [
        new webpack.optimize.LimitChunkCountPlugin({ maxChunks: 1 }),
        ...(format === 'esm' ? [esmPackageTypePlugin] : []),
      ],
    }))
  )
}

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
