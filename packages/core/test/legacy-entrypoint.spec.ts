import fs from 'fs'
import path from 'path'

const packageRoot = process.cwd()
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
const legacyEntrypointRoot = path.join(packageRoot, 'rules-based')
const legacyEntrypoint = JSON.parse(fs.readFileSync(path.join(legacyEntrypointRoot, 'package.json'), 'utf8'))

describe('legacy rules-based entrypoint', () => {
  it('includes the physical entrypoint in the published package', () => {
    expect(packageJson.files).toContain('rules-based/')
  })

  it.each([
    ['main', 'require'],
    ['module', 'import'],
    ['types', 'types'],
  ])('maps %s to the same implementation as the %s export', (field, condition) => {
    expect(path.resolve(legacyEntrypointRoot, legacyEntrypoint[field])).toBe(
      path.resolve(packageRoot, packageJson.exports['./rules-based'][condition])
    )
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
