const path = require('node:path')

const webpackBase = require('../../webpack.base')

module.exports = (_env, argv) => {
  const config = webpackBase({
    mode: argv.mode,
    // cdn/public-path.ts runs first and sets the chunk base URL from the SDK script URL.
    entry: [path.resolve(__dirname, 'cdn/public-path.ts'), path.resolve(__dirname, 'src/index.ts')],
    filename: 'datadog-openfeature-browser.js',
    types: ['chrome'],
  })
  // A fixed public path removes the webpack automatic public path, which throws when the page gives no script URL.
  config.output.publicPath = ''
  return config
}
