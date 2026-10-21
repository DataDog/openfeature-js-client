import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { expect, test } from '@playwright/test'

const require = createRequire(import.meta.url)

type SourceMap = {
  sources: string[]
  sourcesContent?: (string | null)[]
}

for (const packageName of ['@datadog/openfeature-browser', '@datadog/flagging-core']) {
  for (const format of ['esm', 'cjs']) {
    test(`${packageName} ships self-contained ${format} JavaScript source maps`, () => {
      const packageDirectory = dirname(require.resolve(`${packageName}/package.json`))
      const buildDirectory = join(packageDirectory, format)
      const maps = readdirSync(buildDirectory, { recursive: true }).filter((file) => file.endsWith('.js.map'))
      expect(maps.length).toBeGreaterThan(0)

      for (const file of maps) {
        const map = JSON.parse(readFileSync(join(buildDirectory, file), 'utf8')) as SourceMap
        expect(map.sources.length, file).toBeGreaterThan(0)
        expect(map.sourcesContent, file).toHaveLength(map.sources.length)
        for (const [index, source] of map.sources.entries()) {
          expect(map.sourcesContent?.[index], `${file}: ${source}`).toEqual(expect.any(String))
          expect(map.sourcesContent?.[index], `${file}: ${source}`).not.toBe('')
        }
      }
    })
  }
}
