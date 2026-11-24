const ts = require('typescript')

module.exports = function transpileLegacyDependency(source) {
  const result = ts.transpileModule(source, {
    fileName: this.resourcePath,
    compilerOptions: {
      allowJs: true,
      target: ts.ScriptTarget.ES2015,
      module: ts.ModuleKind.ESNext,
      sourceMap: true,
    },
  })
  this.callback(null, result.outputText, JSON.parse(result.sourceMapText))
}
