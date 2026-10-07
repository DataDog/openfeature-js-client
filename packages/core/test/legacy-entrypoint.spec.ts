import fs from 'fs'
import path from 'path'

const { getCoreEntrypoints, synchronizeCoreEntrypoints } = require('../../../scripts/lib/coreEntrypoints')
const packageRoot = process.cwd()
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
const entries = getCoreEntrypoints(packageJson) as Array<{
  subpath: string
  name: string
  types: string
}>

describe('public entrypoint packaging', () => {
  it('keeps all generated metadata synchronized with exports', () => {
    expect(() => synchronizeCoreEntrypoints(packageRoot, { check: true })).not.toThrow()
  })

  it.each(entries)('publishes modern and legacy declarations and bundles for $subpath', (entry) => {
    const entrypointRoot = path.join(packageRoot, entry.name)
    const manifest = JSON.parse(fs.readFileSync(path.join(entrypointRoot, 'package.json'), 'utf8'))
    expect(packageJson.files).toContain(`${entry.name.split('/')[0]}/`)
    expect(packageJson.files).toContain('bundle/')
    expect(packageJson.typesVersions['*'][entry.name]).toEqual([entry.types.slice(2)])
    expect(path.resolve(entrypointRoot, manifest.types)).toBe(path.resolve(packageRoot, entry.types))
    for (const [field, format] of [
      ['main', 'cjs'],
      ['module', 'esm'],
    ]) {
      const relativePath = `bundle/legacy/${format}/${entry.name}.js`
      expect(path.resolve(entrypointRoot, manifest[field])).toBe(path.join(packageRoot, relativePath))
      if (packageJson.sideEffects !== true) expect(packageJson.sideEffects).toContain(`./${relativePath}`)
    }
  })

  it('keeps the default entrypoint separate from compatibility bundles', () => {
    expect(packageJson.main).toBe('cjs/index.js')
    expect(packageJson.module).toBe('esm/index.js')
    expect(packageJson.types).toBe('cjs/index.d.ts')
    expect(packageJson.exports['.']).toEqual({
      types: './cjs/index.d.ts',
      import: './esm/index.js',
      require: './cjs/index.js',
      default: './esm/index.js',
    })
  })
})
