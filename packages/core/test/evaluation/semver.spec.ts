import type { EvaluationContext } from '@openfeature/core'
import { isValidRule, matchesRule, OperatorType, type Rule } from '../../src/evaluation/rules'
import { compareSemver, type ParsedSemver, parseSemver } from '../../src/evaluation/semver'

type SemverOperator =
  | OperatorType.SEMVER_EQ
  | OperatorType.SEMVER_NEQ
  | OperatorType.SEMVER_LT
  | OperatorType.SEMVER_LTE
  | OperatorType.SEMVER_GT
  | OperatorType.SEMVER_GTE

function parse(version: string): ParsedSemver {
  const parsed = parseSemver(version)
  if (!parsed) {
    throw new Error(`Expected valid SemVer: ${version}`)
  }
  return parsed
}

describe('SemVer', () => {
  it.each([
    '0.0.0',
    '1.2.3-alpha.1',
    '1.2.3+build.001',
    '1.2.3-alpha-1+build.001',
    '18446744073709551615.18446744073709551615.18446744073709551615',
    '1.2.3-18446744073709551616',
    // Extended version-part support: one- and two-part versions normalize to
    // three parts; any number of additional parts is accepted.
    '18',
    '18.0',
    '1.2.3.4',
    '1.2.3.4.5',
    '1.2.3.4.5.6',
    '18.0.0.0',
    '18.0.0.0.0',
  ])('accepts %s', (version) => {
    expect(parseSemver(version)).not.toBeNull()
  })

  it.each([
    '',
    'v1.2.3',
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '18446744073709551616.0.0',
    '1.2.3-',
    '1.2.3+',
    '1.2.3-alpha..1',
    '1.2.3+build..1',
    '1.2.3-01',
    '1.2.3-alpha_1',
    '1.2.3-alpha+build+other',
    '1.2.3-α',
    ' 1.2.3',
    '1.2.3 ',
    // A trailing dot leaves an empty core identifier.
    '1.2.',
    '1.',
    // Consecutive dots leave an empty core identifier.
    '1..2',
  ])('rejects %s', (version) => {
    expect(parseSemver(version)).toBeNull()
  })

  it('orders prerelease versions according to SemVer precedence', () => {
    const ordered = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
      '1.0.1',
      '1.1.0',
      '2.0.0',
    ]

    for (let i = 0; i < ordered.length; i++) {
      for (let j = 0; j < ordered.length; j++) {
        const ordering = compareSemver(parse(ordered[i]), parse(ordered[j]))
        expect(Math.sign(ordering)).toBe(Math.sign(i - j))
      }
    }
  })

  it('compares arbitrarily large numeric prerelease identifiers', () => {
    expect(compareSemver(parse('1.0.0-99999999999999999999'), parse('1.0.0-100000000000000000000'))).toBeLessThan(0)
  })

  it('parses the core and prerelease fields while discarding build metadata', () => {
    expect(parseSemver('1.2.3-alpha.1+build.001')).toEqual({
      parts: ['1', '2', '3'],
      prerelease: 'alpha.1',
    })
  })

  it('accepts the maximum uint64 core components', () => {
    expect(parseSemver('18446744073709551615.18446744073709551615.18446744073709551615')).toEqual({
      parts: ['18446744073709551615', '18446744073709551615', '18446744073709551615'],
      prerelease: '',
    })
  })

  it('normalizes one- and two-part versions and retains additional parts', () => {
    expect(parseSemver('18')).toEqual({ parts: ['18'], prerelease: '' })
    expect(parseSemver('18.0')).toEqual({ parts: ['18', '0'], prerelease: '' })
    expect(parseSemver('1.2.3.4')).toEqual({ parts: ['1', '2', '3', '4'], prerelease: '' })
    expect(parseSemver('1.2.3.4.5')).toEqual({ parts: ['1', '2', '3', '4', '5'], prerelease: '' })
    expect(parseSemver('1.2.3.4.5.6')).toEqual({ parts: ['1', '2', '3', '4', '5', '6'], prerelease: '' })
  })

  it('compares extended version parts with zero-padding', () => {
    // One- and two-part versions compare equal to their three-part form.
    expect(compareSemver(parse('18'), parse('18.0.0'))).toBe(0)
    expect(compareSemver(parse('18.0'), parse('18.0.0'))).toBe(0)
    // A four- or five-part version compares above a lower three-part version.
    expect(compareSemver(parse('18.0.0.0'), parse('17.0.0'))).toBeGreaterThan(0)
    expect(compareSemver(parse('18.0.0.0.0'), parse('17.0.0'))).toBeGreaterThan(0)
    // A three-part version compares above a lower four- or five-part comparand.
    expect(compareSemver(parse('19.0.0'), parse('18.0.0.0'))).toBeGreaterThan(0)
    expect(compareSemver(parse('19.0.0'), parse('18.0.0.0.0'))).toBeGreaterThan(0)
    // Extra zero parts do not change precedence against the three-part form.
    expect(compareSemver(parse('1.0.0.0'), parse('1.0.0'))).toBe(0)
    expect(compareSemver(parse('1.0.0.0.0'), parse('1.0.0'))).toBe(0)
  })

  it('orders core components above Number.MAX_SAFE_INTEGER without precision loss', () => {
    expect(compareSemver(parse('9007199254740992.0.0'), parse('9007199254740991.0.0'))).toBeGreaterThan(0)
    expect(compareSemver(parse('18446744073709551615.0.0'), parse('18446744073709551614.0.0'))).toBeGreaterThan(0)
  })

  it('ignores build metadata', () => {
    expect(compareSemver(parse('1.0.0+build.1'), parse('1.0.0+build.2'))).toBe(0)
  })

  describe('condition evaluation', () => {
    function matchesSemver(operator: SemverOperator, attribute: unknown, comparand: unknown): boolean {
      return matchesRule(
        {
          conditions: [
            {
              operator,
              attribute: 'version',
              value: comparand as string,
            },
          ],
        },
        { version: attribute } as EvaluationContext
      )
    }

    it.each([
      ['equal', OperatorType.SEMVER_EQ, '1.2.3', '1.2.3', true],
      ['equal mismatch', OperatorType.SEMVER_EQ, '1.2.4', '1.2.3', false],
      ['not equal', OperatorType.SEMVER_NEQ, '1.2.4', '1.2.3', true],
      ['not equal mismatch', OperatorType.SEMVER_NEQ, '1.2.3', '1.2.3', false],
      ['less than', OperatorType.SEMVER_LT, '1.9.9', '2.0.0', true],
      ['less than mismatch', OperatorType.SEMVER_LT, '2.0.0', '2.0.0', false],
      ['less than or equal', OperatorType.SEMVER_LTE, '2.0.0', '2.0.0', true],
      ['less than or equal mismatch', OperatorType.SEMVER_LTE, '2.0.1', '2.0.0', false],
      ['greater than', OperatorType.SEMVER_GT, '1.0.1', '1.0.0', true],
      ['greater than mismatch', OperatorType.SEMVER_GT, '1.0.0', '1.0.0', false],
      ['greater than or equal', OperatorType.SEMVER_GTE, '1.0.0', '1.0.0', true],
      ['greater than or equal mismatch', OperatorType.SEMVER_GTE, '0.9.9', '1.0.0', false],
    ] as const)('%s', (_name, operator, attribute, comparand, expected) => {
      expect(matchesSemver(operator, attribute, comparand)).toBe(expected)
    })

    it.each([
      [OperatorType.SEMVER_EQ, true],
      [OperatorType.SEMVER_NEQ, false],
      [OperatorType.SEMVER_LT, false],
      [OperatorType.SEMVER_LTE, true],
      [OperatorType.SEMVER_GT, false],
      [OperatorType.SEMVER_GTE, true],
    ] as const)('ignores build metadata for %s', (operator, expected) => {
      expect(matchesSemver(operator, '4.0.0+build.42', '4.0.0')).toBe(expected)
    })

    it('treats different build metadata as equal precedence', () => {
      expect(matchesSemver(OperatorType.SEMVER_EQ, '1.0.0+linux', '1.0.0+darwin')).toBe(true)
      expect(matchesSemver(OperatorType.SEMVER_EQ, '4.0.0+exp.sha.5114f85', '4.0.0')).toBe(true)
    })

    it.each(['not-a-version', 'v1.2.3', '18446744073709551616.0.0'])(
      'does not match an invalid attribute: %s',
      (attribute) => {
        expect(matchesSemver(OperatorType.SEMVER_NEQ, attribute, '1.0.0')).toBe(false)
      }
    )

    it('does not match a missing or non-string attribute', () => {
      expect(
        matchesRule(
          {
            conditions: [{ operator: OperatorType.SEMVER_EQ, attribute: 'version', value: '1.0.0' }],
          },
          {} as EvaluationContext
        )
      ).toBe(false)
      expect(matchesSemver(OperatorType.SEMVER_EQ, 1.2, '1.2.0')).toBe(false)
    })

    it('does not match an invalid or non-string comparand', () => {
      expect(matchesSemver(OperatorType.SEMVER_EQ, '1.2.3', 'not-a-version')).toBe(false)
      expect(matchesSemver(OperatorType.SEMVER_EQ, '1.2.3', 1.2)).toBe(false)
    })

    it('rejects invalid configured SemVer comparands during rule validation', () => {
      const rule: Rule = {
        conditions: [{ operator: OperatorType.SEMVER_EQ, attribute: 'version', value: 'not-a-version' }],
      }
      expect(isValidRule(rule)).toBe(false)
    })

    it('returns false for unsupported operators', () => {
      const rule = {
        conditions: [{ operator: 'UNKNOWN', attribute: 'version', value: '1.0.0' }],
      } as unknown as Rule
      expect(matchesRule(rule, { version: '1.0.0' } as EvaluationContext)).toBe(false)
    })
  })
})
