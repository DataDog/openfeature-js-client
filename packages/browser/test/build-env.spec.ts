import * as path from 'node:path'

describe('build environment', () => {
  const originalBuildMode = process.env.BUILD_MODE

  afterEach(() => {
    if (originalBuildMode === undefined) {
      delete process.env.BUILD_MODE
    } else {
      process.env.BUILD_MODE = originalBuildMode
    }
    jest.restoreAllMocks()
    jest.resetModules()
  })

  it('uses the current package version for release builds', () => {
    process.env.BUILD_MODE = 'release'
    jest.spyOn(process, 'cwd').mockReturnValue(path.resolve(__dirname, '..'))

    const { getBuildEnvValue } = jest.requireActual<{
      getBuildEnvValue: (key: string) => string
    }>('../../../scripts/lib/buildEnv')
    const packageJson = jest.requireActual<{ version: string }>('../package.json')

    expect(getBuildEnvValue('SDK_VERSION')).toBe(packageJson.version)
    expect(getBuildEnvValue('SDK_VERSION')).not.toBe('independent')
  })
})
