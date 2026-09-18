import fs from 'fs'
import path from 'path'
import ts from 'typescript'

type Entrypoint = {
  name: string
  file: string
}

type RuntimeImport = {
  from: string
  specifier: string
}

const coreSourceRoot = path.resolve(process.cwd(), 'src')
const browserSourceRoot = path.resolve(process.cwd(), '../browser/src')

const defaultEntrypoints: Entrypoint[] = [
  {
    name: '@datadog/flagging-core',
    file: path.join(coreSourceRoot, 'index.ts'),
  },
  {
    name: '@datadog/openfeature-browser',
    file: path.join(browserSourceRoot, 'index.ts'),
  },
]

const forbiddenSourcePaths = new Map([
  [path.join(coreSourceRoot, 'configuration/generated'), 'generated protobuf definitions'],
  [path.join(coreSourceRoot, 'configuration/protobuf-text-encoding.ts'), 'protobuf text-encoding setup'],
  [path.join(coreSourceRoot, 'configuration/rules-wire.ts'), 'rules-based wire parser'],
  [path.join(coreSourceRoot, 'configuration/ufc-protobuf.ts'), 'protobuf configuration codec'],
  [path.join(coreSourceRoot, 'configuration/wire.ts'), 'rules-capable wire parser'],
  [path.join(coreSourceRoot, 'rules-based-configuration-wire.ts'), 'core rules-based entrypoint'],
  [path.join(browserSourceRoot, 'rules-based.ts'), 'browser rules-based entrypoint'],
])

describe('default entrypoint boundaries', () => {
  it.each(defaultEntrypoints)('keeps protobuf parsing out of $name', ({ file }) => {
    const graph = collectRuntimeImportGraph(file)
    const violations = [
      ...graph.externalImports
        .filter((runtimeImport) => runtimeImport.specifier.startsWith('@bufbuild/protobuf'))
        .map(
          ({ from, specifier }) =>
            `${relativePath(from)} imports ${specifier}, which is only allowed behind /rules-based`
        ),
      ...graph.visitedFiles.flatMap((visitedFile) => {
        const forbiddenPath = findForbiddenSourcePath(visitedFile)
        return forbiddenPath
          ? [`${relativePath(visitedFile)} is ${forbiddenSourcePaths.get(forbiddenPath)} and must stay out of defaults`]
          : []
      }),
    ]

    expect(violations).toEqual([])
  })
})

function collectRuntimeImportGraph(entrypoint: string): {
  externalImports: RuntimeImport[]
  visitedFiles: string[]
} {
  const pending = [entrypoint]
  const visitedFiles = new Set<string>()
  const externalImports: RuntimeImport[] = []

  while (pending.length > 0) {
    const file = pending.pop()!
    if (visitedFiles.has(file)) continue
    visitedFiles.add(file)

    for (const specifier of collectRuntimeImportSpecifiers(file)) {
      const resolvedFile = resolveSourceFile(file, specifier)
      if (resolvedFile) {
        pending.push(resolvedFile)
      } else {
        externalImports.push({ from: file, specifier })
      }
    }
  }

  return {
    externalImports,
    visitedFiles: [...visitedFiles],
  }
}

function collectRuntimeImportSpecifiers(file: string): string[] {
  const sourceFile = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const specifiers: string[] = []

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && importsRuntimeValue(node)) {
      specifiers.push(node.moduleSpecifier.text)
    } else if (ts.isExportDeclaration(node) && exportsRuntimeValue(node)) {
      const { moduleSpecifier } = node
      if (moduleSpecifier && ts.isStringLiteral(moduleSpecifier)) {
        specifiers.push(moduleSpecifier.text)
      }
    } else if (ts.isCallExpression(node)) {
      const [argument] = node.arguments
      if (
        argument &&
        ts.isStringLiteral(argument) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      ) {
        specifiers.push(argument.text)
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)

  return specifiers
}

function importsRuntimeValue(node: ts.ImportDeclaration): boolean {
  const { importClause } = node
  if (!importClause) return true
  if (importClause.isTypeOnly) return false
  if (importClause.name) return true
  if (!importClause.namedBindings) return false
  if (ts.isNamespaceImport(importClause.namedBindings)) return true
  return importClause.namedBindings.elements.some((specifier) => !specifier.isTypeOnly)
}

function exportsRuntimeValue(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return false
  if (!node.exportClause) return true
  if (ts.isNamespaceExport(node.exportClause)) return true
  return node.exportClause.elements.some((specifier) => !specifier.isTypeOnly)
}

function resolveSourceFile(fromFile: string, specifier: string): string | undefined {
  if (specifier === '@datadog/flagging-core') {
    return path.join(coreSourceRoot, 'index.ts')
  }
  if (specifier === '@datadog/flagging-core/rules-based') {
    return path.join(coreSourceRoot, 'rules-based-configuration-wire.ts')
  }
  if (specifier === '@datadog/openfeature-browser') {
    return path.join(browserSourceRoot, 'index.ts')
  }
  if (specifier === '@datadog/openfeature-browser/rules-based') {
    return path.join(browserSourceRoot, 'rules-based.ts')
  }
  if (!specifier.startsWith('.')) return undefined

  const basePath = path.resolve(path.dirname(fromFile), specifier)
  return [basePath, `${basePath}.ts`, path.join(basePath, 'index.ts')].find(isFile)
}

function findForbiddenSourcePath(file: string): string | undefined {
  return [...forbiddenSourcePaths.keys()].find(
    (forbiddenPath) => file === forbiddenPath || file.startsWith(`${forbiddenPath}${path.sep}`)
  )
}

function relativePath(file: string): string {
  return path.relative(path.resolve(process.cwd(), '../..'), file)
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}
