import fs from 'fs'
import path from 'path'

const packageRoot = process.cwd()
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
const legacyEntrypointRoot = path.join(packageRoot, 'rules-based')
const legacyEntrypoint = JSON.parse(fs.readFileSync(path.join(legacyEntrypointRoot, 'package.json'), 'utf8'))

describe('legacy rules-based entrypoint', () => {
  it('publishes the physical entrypoint and its self-contained bundles', () => {
    expect(packageJson.files).toContain('rules-based/')
    expect(packageJson.files).toContain('bundle/')
  })

  it.each([
    ['main', 'cjs'],
    ['module', 'esm'],
  ])('maps %s to the %s compatibility bundle', (field, format) => {
    const relativePath = `bundle/legacy/${format}/rules-based.js`
    expect(path.resolve(legacyEntrypointRoot, legacyEntrypoint[field])).toBe(path.join(packageRoot, relativePath))
    // The bundle contains the protobuf text-encoding initialization side effect.
    expect(packageJson.sideEffects).toContain(`./${relativePath}`)
  })

  it('reuses the same public TypeScript declarations', () => {
    expect(path.resolve(legacyEntrypointRoot, legacyEntrypoint.types)).toBe(
      path.resolve(packageRoot, packageJson.exports['./rules-based'].types)
    )
  })

  it('keeps modern rules-based exports modular', () => {
    expect(packageJson.exports['./rules-based']).toEqual({
      types: './cjs/rules-based-configuration-wire.d.ts',
      import: './esm/rules-based-configuration-wire.js',
      require: './cjs/rules-based-configuration-wire.js',
      default: './esm/rules-based-configuration-wire.js',
    })
  })

  it('keeps the default entrypoint separate from the rules-based parser', () => {
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
