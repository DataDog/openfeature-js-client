import { canonicalizeFlagSelection, type FlagSelection } from '../../src/configuration/flag-selection'

// The 25 code points with the Unicode White_Space property.
const UNICODE_WHITE_SPACE = [
  '\t',
  '\n',
  '\v',
  '\f',
  '\r',
  ' ',
  '\u0085',
  '\u00A0',
  '\u1680',
  '\u2000',
  '\u2001',
  '\u2002',
  '\u2003',
  '\u2004',
  '\u2005',
  '\u2006',
  '\u2007',
  '\u2008',
  '\u2009',
  '\u200A',
  '\u2028',
  '\u2029',
  '\u202F',
  '\u205F',
  '\u3000',
]

describe('canonicalizeFlagSelection', () => {
  it('trims, drops empty values, dedupes, and sorts each list', () => {
    expect(
      canonicalizeFlagSelection({
        tags: [' team:web ', 'beta', '', '   ', 'team:web', 'beta'],
        keyPatterns: ['ffe-*', ' ffe-* ', 'checkout'],
      })
    ).toEqual({ selection: { tags: ['beta', 'team:web'], keyPatterns: ['checkout', 'ffe-*'] } })
  })

  it('returns an empty list for an omitted list', () => {
    expect(canonicalizeFlagSelection({ tags: ['beta'] })).toEqual({ selection: { tags: ['beta'], keyPatterns: [] } })
    expect(canonicalizeFlagSelection({ keyPatterns: ['a*'] })).toEqual({
      selection: { tags: [], keyPatterns: ['a*'] },
    })
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty object', {}],
    ['empty lists', { tags: [], keyPatterns: [] }],
    ['lists empty after trimming', { tags: [' ', ''], keyPatterns: ['　'] }],
    ['null lists', { tags: null, keyPatterns: null }],
  ])('returns no selection and no error for %s', (_, input) => {
    expect(canonicalizeFlagSelection(input)).toEqual({})
  })

  describe('trimming', () => {
    it.each(UNICODE_WHITE_SPACE.map((char) => [char.charCodeAt(0).toString(16).padStart(4, '0'), char]))(
      'trims U+%s',
      (_, char) => {
        expect(canonicalizeFlagSelection({ tags: [`${char}beta${char}`] }).selection?.tags).toEqual(['beta'])
      }
    )

    it('keeps interior white space', () => {
      expect(canonicalizeFlagSelection({ tags: [' a b '] }).selection?.tags).toEqual(['a b'])
    })

    it('lists every Unicode White_Space code point', () => {
      const whiteSpace = /^\p{White_Space}$/u
      const codePoints: number[] = []
      for (let code = 0; code <= 0x10ffff; code++) {
        if (whiteSpace.test(String.fromCodePoint(code))) codePoints.push(code)
      }
      expect(codePoints).toEqual(UNICODE_WHITE_SPACE.map((char) => char.codePointAt(0)))
    })

    it('trims no other BMP code point', () => {
      const whiteSpace = new Set(UNICODE_WHITE_SPACE)
      const trimmed: string[] = []
      for (let code = 0; code <= 0xffff; code++) {
        const char = String.fromCharCode(code)
        // Lone surrogates are malformed_selection.
        if ((code >= 0xd800 && code <= 0xdfff) || whiteSpace.has(char)) continue
        const value = `${char}x${char}`
        if (canonicalizeFlagSelection({ tags: [value] }).selection?.tags[0] !== value) {
          trimmed.push(code.toString(16))
        }
      }
      expect(trimmed).toEqual([])
    })

    describe('long white space runs', () => {
      // Every White_Space code point, repeated to the requested length.
      const run = (length: number) =>
        Array.from({ length }, (_, index) => UNICODE_WHITE_SPACE[index % UNICODE_WHITE_SPACE.length]).join('')
      const RUN_LENGTH = 16_000

      // A quadratic trim takes hundreds of milliseconds at this length; a linear one takes well under one.
      // The best of three runs keeps a single garbage collection pause from failing the test.
      const expectFast = (canonicalize: () => void) => {
        let fastest = Number.POSITIVE_INFINITY
        for (let attempt = 0; attempt < 3 && fastest >= 50; attempt++) {
          const startedAt = performance.now()
          canonicalize()
          fastest = Math.min(fastest, performance.now() - startedAt)
        }
        expect(fastest).toBeLessThan(50)
      }

      it.each([
        ['an interior run', `a${run(RUN_LENGTH)}b`, { error: 'invalid_tag' }],
        ['a value that is only white space', run(RUN_LENGTH), {}],
        [
          'leading and trailing runs',
          `${run(RUN_LENGTH)}a${run(RUN_LENGTH)}`,
          { selection: { tags: ['a'], keyPatterns: [] } },
        ],
      ])('canonicalizes %s in linear time', (_, value, expected) => {
        expect(canonicalizeFlagSelection({ tags: [value] })).toEqual(expected)
        expectFast(() => canonicalizeFlagSelection({ tags: [value] }))
      })
    })

    it.each([
      ['U+FEFF', '﻿'],
      ['U+180E', '᠎'],
      ['U+200B', '​'],
    ])('does not trim %s, which is not White_Space', (_, char) => {
      expect(canonicalizeFlagSelection({ tags: [`${char}beta`] }).selection?.tags).toEqual([`${char}beta`])
    })
  })

  it('sorts in UTF-8 byte order, not UTF-16 code unit order', () => {
    // UTF-16 puts U+1F600 (0xD83D...) before U+FF5E; UTF-8 puts it after (0xF0... > 0xEF...).
    const supplementary = '\u{1F600}'
    const bmp = '～'
    expect([supplementary, bmp].sort()).toEqual([supplementary, bmp])
    expect(canonicalizeFlagSelection({ tags: [supplementary, bmp, 'Z', 'a'] }).selection?.tags).toEqual([
      'Z',
      'a',
      bmp,
      supplementary,
    ])
  })

  describe('limits', () => {
    const values = (count: number) => Array.from({ length: count }, (_, index) => `value-${index}`)

    it.each(['tags', 'keyPatterns'])('accepts 31 %s and rejects 32', (list) => {
      expect(canonicalizeFlagSelection({ [list]: values(31) }).error).toBeUndefined()
      expect(canonicalizeFlagSelection({ [list]: values(32) })).toEqual({ error: 'too_many_values' })
    })

    it('counts values after dedupe and dropping empty values', () => {
      expect(canonicalizeFlagSelection({ tags: [...values(31), ...values(31), '', ' '] }).error).toBeUndefined()
    })

    it.each([
      ['ASCII', 'a'.repeat(200), 'a'.repeat(201)],
      ['multi-byte', 'é'.repeat(100), `${'é'.repeat(100)}a`],
    ])('accepts a %s tag of 200 UTF-8 bytes and rejects 201', (_, accepted, rejected) => {
      expect(canonicalizeFlagSelection({ tags: [accepted] }).error).toBeUndefined()
      expect(canonicalizeFlagSelection({ tags: [rejected] })).toEqual({ error: 'invalid_tag' })
    })

    it.each([
      ['ASCII', 'a'.repeat(200), 'a'.repeat(201)],
      ['multi-byte', 'é'.repeat(100), `${'é'.repeat(100)}a`],
    ])('accepts a %s key pattern of 200 UTF-8 bytes and rejects 201', (_, accepted, rejected) => {
      expect(canonicalizeFlagSelection({ keyPatterns: [accepted] }).error).toBeUndefined()
      expect(canonicalizeFlagSelection({ keyPatterns: [rejected] })).toEqual({ error: 'invalid_key_pattern' })
    })

    it('measures bytes after trimming', () => {
      expect(canonicalizeFlagSelection({ tags: [`  ${'a'.repeat(200)}  `] }).error).toBeUndefined()
    })
  })

  describe('type-invalid input', () => {
    it.each([
      ['a string', 'beta'],
      ['a number', 1],
      ['an array', ['beta']],
      ['tags that is not an array', { tags: 'beta' }],
      ['keyPatterns that is not an array', { keyPatterns: { 0: 'a*' } }],
      ['a non-string tag', { tags: ['beta', 1] }],
      ['a non-string key pattern', { keyPatterns: [null] }],
      ['a tag with a lone high surrogate', { tags: ['beta\uD83D'] }],
      ['a tag with a lone low surrogate', { tags: ['\uDE00beta'] }],
      ['a key pattern with a lone high surrogate', { keyPatterns: ['a\uD83Db*'] }],
      ['a key pattern with a lone low surrogate', { keyPatterns: ['a*\uDE00'] }],
      // biome-ignore lint/suspicious/noSparseArray: a hole is a malformed value
      ['a tags list with a hole', { tags: [, 'beta'] }],
      ['a keyPatterns list of holes', { keyPatterns: new Array(2) }],
    ])('returns malformed_selection for %s', (_, input) => {
      expect(canonicalizeFlagSelection(input)).toEqual({ error: 'malformed_selection' })
    })

    it('accepts readonly lists', () => {
      const tags = ['beta'] as const
      const keyPatterns = ['a*'] as const
      expect(canonicalizeFlagSelection({ tags, keyPatterns } satisfies FlagSelection)).toEqual({
        selection: { tags: ['beta'], keyPatterns: ['a*'] },
      })
    })

    it('accepts well-formed surrogate pairs', () => {
      expect(canonicalizeFlagSelection({ tags: ['team:\uD83D\uDE00'], keyPatterns: ['😀-*'] })).toEqual({
        selection: { tags: ['team:😀'], keyPatterns: ['😀-*'] },
      })
    })

    it('ignores unknown keys (selection still built from tags/keyPatterns)', () => {
      expect(canonicalizeFlagSelection({ tags: ['beta'], keyPatterns: ['a*'], key_patterns: ['b*'] })).toEqual({
        selection: { tags: ['beta'], keyPatterns: ['a*'] },
      })
    })
  })

  describe('check order', () => {
    const tooMany = Array.from({ length: 32 }, (_, index) => `value-${index}`)
    const longValue = 'a'.repeat(201)

    it('reports malformed_selection before too_many_values', () => {
      expect(canonicalizeFlagSelection({ tags: tooMany, keyPatterns: [1] })).toEqual({ error: 'malformed_selection' })
    })

    it('reports too_many_values before invalid_key_pattern', () => {
      expect(canonicalizeFlagSelection({ tags: tooMany, keyPatterns: [longValue] })).toEqual({
        error: 'too_many_values',
      })
    })

    it('reports invalid_key_pattern before invalid_tag', () => {
      expect(canonicalizeFlagSelection({ tags: [longValue], keyPatterns: [longValue] })).toEqual({
        error: 'invalid_key_pattern',
      })
    })
  })
})
