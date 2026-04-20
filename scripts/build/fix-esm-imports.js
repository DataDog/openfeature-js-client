const glob = require('glob')
const { printLog, runMain } = require('../lib/executionUtils')
const { modifyFile } = require('../lib/filesUtils')

/**
 * Rewrite deep /cjs/ subpath imports to /esm/ in the ESM build output.
 *
 * Some @datadog/* packages (e.g. browser-core) do not expose internal helpers
 * via their package root, so callers must use deep subpath imports like
 * `@datadog/browser-core/cjs/domain/configuration`. When TypeScript compiles
 * those imports into the ESM output the specifier is preserved verbatim,
 * causing bundlers to pull in CJS modules inside an ESM graph.
 *
 * Usage: node fix-esm-imports.js <build-directory>
 */

runMain(async () => {
  const buildDirectory = process.argv[2]

  for (const path of glob.sync('**/*.js', {
    cwd: buildDirectory,
    absolute: true,
  })) {
    if (await modifyFile(path, rewriteCjsSubpaths)) {
      printLog(`Rewrote CJS subpath imports in ${path}`)
    }
  }
})

function rewriteCjsSubpaths(content) {
  return content.replaceAll(/@datadog\/([^/'"]+)\/cjs\//g, '@datadog/$1/esm/')
}
