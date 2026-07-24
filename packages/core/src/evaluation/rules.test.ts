import { isValidRule, matchesRule, OperatorType, type Rule } from './rules'

describe('SemVer conditions', () => {
  it.each([
    [OperatorType.SEMVER_EQUAL, '1.2.3+build.9', '1.2.3+other', true],
    [OperatorType.SEMVER_NOT_EQUAL, '1.2.3-alpha', '1.2.3', true],
    [OperatorType.SEMVER_LT, '1.2.3-alpha.2', '1.2.3-alpha.10', true],
    [OperatorType.SEMVER_LTE, '1.2.3', '1.2.3', true],
    [OperatorType.SEMVER_GT, '2.0.0', '1.999999999999999999999.0', true],
    [OperatorType.SEMVER_GTE, '1.2.3', '2.0.0', false],
  ] as const)('%s compares %s against %s', (operator, actual, expected, matches) => {
    expect(
      matchesRule({ conditions: [{ operator, attribute: 'version', value: expected }] }, { version: actual })
    ).toBe(matches)
  })

  it.each(['1.2', '01.2.3', '1.2.3-01', '1.2.3+'])('rejects invalid strict SemVer value %s', (value) => {
    const rule: Rule = {
      conditions: [{ operator: OperatorType.SEMVER_EQUAL, attribute: 'version', value: '1.2.3' }],
    }

    expect(matchesRule(rule, { version: value })).toBe(false)
  })
})

describe('SHA-256 membership conditions', () => {
  const hash = 'c0e551d80aa1e2cb1eaf5be7edbb04e51eb1823e562e2ce5dfeda0ecba76c744'

  it('matches the hash of salt bytes followed by the UTF-8 attribute value', () => {
    const rule: Rule = {
      conditions: [
        {
          operator: OperatorType.ONE_OF_SHA256,
          attribute: 'name',
          value: { salt: [1, 2], hashes: [hash] },
        },
      ],
    }

    expect(isValidRule(rule)).toBe(true)
    expect(matchesRule(rule, { name: 'hello' })).toBe(true)
  })

  it('supports negative membership', () => {
    const rule: Rule = {
      conditions: [
        {
          operator: OperatorType.NOT_ONE_OF_SHA256,
          attribute: 'name',
          value: { salt: [1, 2], hashes: [hash] },
        },
      ],
    }

    expect(matchesRule(rule, { name: 'other' })).toBe(true)
    expect(matchesRule(rule, { name: 'hello' })).toBe(false)
  })
})
