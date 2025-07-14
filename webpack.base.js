const path = require('path')
const webpack = require('webpack')
const TsconfigPathsPlugin = require('tsconfig-paths-webpack-plugin')
const TerserPlugin = require('terser-webpack-plugin')
const { buildEnvKeys, getBuildEnvValue } = require('./scripts/lib/buildEnv')

const tsconfigPath = path.join(__dirname, 'tsconfig.webpack.json')

module.exports = ({
  entry,
  mode,
  filename,
  types,
  keepBuildEnvVariables,
  plugins,
}) => ({
  entry,
  mode,
  output: {
    filename,
    chunkFilename:
      mode === 'development'
        ? `chunks/[name]-${filename}`
        : `chunks/[name]-[contenthash]-${filename}`,
    path: path.resolve('./bundle'),
  },
  target: ['web', 'es2018'],
  devtool: false,
  module: {
    rules: [
      {
        test: /\.(ts|tsx|js)$/,
        loader: 'ts-loader',
        exclude: /node_modules/,
        options: {
          configFile: tsconfigPath,
          onlyCompileBundledFiles: true,
          compilerOptions: {
            module: 'es2020',
            allowJs: true,
            types: types || [],
          },
        },
      },
    ],
  },
  resolve: {
    extensions: ['.ts', '.js', '.tsx'],
    plugins: [new TsconfigPathsPlugin({ configFile: tsconfigPath })],
  },
  optimization: {
    chunkIds: 'named',
    minimizer: [
      new TerserPlugin({
        extractComments: false,
        terserOptions: {
          ecma: 2018,
          module: true,
          compress: {
            passes: 4,
            unsafe: true,
            unsafe_methods: true,
          },
        },
      }),
    ],
  },
  plugins: [
    // Removed SourceMapDevToolPlugin for quick fix
    createDefinePlugin({ keepBuildEnvVariables }),
    ...(plugins || []),
  ],
})

function createDefinePlugin({ keepBuildEnvVariables } = {}) {
  return new webpack.DefinePlugin(
    Object.fromEntries(
      buildEnvKeys
        .filter((key) => !keepBuildEnvVariables?.includes(key))
        .map((key) => [
          `__BUILD_ENV__${key}__`,
          webpack.DefinePlugin.runtimeValue(() =>
            JSON.stringify(getBuildEnvValue(key)),
          ),
        ]),
    ),
  )
}

module.exports.createDefinePlugin = createDefinePlugin
