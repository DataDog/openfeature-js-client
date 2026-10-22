import { compareOptOutInstants, hasExperimentationOptOut, parseOptOutInstant } from './experimentation-opt-out'

describe('customer opt-out timestamp', () => {
  it('preserves evaluation without an attribute', () => {
    expect(hasExperimentationOptOut({})).toBe(false)
  })
  it.each([
    '2026-01-01T00:00:00Z',
    '2099-01-01T00:00:00.123456789Z',
    '2024-02-29T23:59:59-04:30',
    '2000-02-29T00:00:00+05:45',
    '2026-01-01T00:00:00.1Z',
    '2026-01-01T00:00:00.123Z',
    '2026-01-01T00:00:00.123456+01:30',
    '0000-01-01T00:00:00Z',
    '9999-12-31T23:59:59.999999999Z',
    '2026-01-01t00:00:00Z',
    '2026-01-01T00:00:00z',
    '2026-01-01T00:00:00.1234567890Z',
    '2026-01-01t00:00:00.123456789999z',
  ])('accepts %s', (value) => {
    expect(hasExperimentationOptOut({ dd_experimentation_opt_out_at: value })).toBe(true)
  })
  it.each([null, false, true, 123, {}, [], undefined])('rejects non-string %j', (value) => {
    expect(hasExperimentationOptOut({ dd_experimentation_opt_out_at: value })).toBeUndefined()
  })
  it.each([
    '',
    '2026-01-01',
    '2026-01-01T00:00:00',
    '2026-02-29T00:00:00Z',
    '1900-02-29T00:00:00Z',
    '2026-04-31T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-01-01T24:00:00Z',
    '2026-01-01T00:60:00Z',
    '2026-01-01T00:00:60Z',
    '2026-01-01T00:00:00+24:00',
    '2026-01-01T00:00:00+00:60',
    '2026-01-01 00:00:00Z',
    '2026-01-01T00:00:00 UTC',
    '2026-01-01T00:00:00+0000',
    '2026-01-01T00:00:00\u221205:00',
    '2026-01-01T00:00:00.Z',
    ' 2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00Z ',
    '2026-01-01T00:00:00Z\n',
    '0000-01-01T00:00:00+01:00',
    '9999-12-31T23:59:59-00:01',
    'not-a-timestamp',
  ])('rejects timestamps outside the supported format: %j', (value) => {
    expect(hasExperimentationOptOut({ dd_experimentation_opt_out_at: value })).toBeUndefined()
  })

  it.each([
    ['2026-10-19t12:00:00.123456789999z', '2026-10-19T12:00:00.123456789Z'],
    ['2026-10-19t08:00:00.123456789999-04:00', '2026-10-19T12:00:00.123456789Z'],
    ['1969-12-31t23:59:59.999999999999z', '1969-12-31T23:59:59.999999999Z'],
  ])('normalizes %s without rounding across a nanosecond boundary', (input, expected) => {
    expect(parseOptOutInstant(input)).toEqual(parseOptOutInstant(expected))
  })

  it('compares canonical offsets and fractional precision without rounding', () => {
    const utc = parseOptOutInstant('2026-10-19T12:00:00.123456789Z')!
    const offset = parseOptOutInstant('2026-10-19T08:00:00.123456789-04:00')!
    const later = parseOptOutInstant('2026-10-19T12:00:00.123456790Z')!
    expect(compareOptOutInstants(utc, offset)).toBe(0)
    expect(compareOptOutInstants(utc, later)).toBe(-1)
    expect(
      compareOptOutInstants(
        parseOptOutInstant('2026-10-19T12:00:00.1Z')!,
        parseOptOutInstant('2026-10-19T12:00:00.100Z')!
      )
    ).toBe(0)
  })
})
