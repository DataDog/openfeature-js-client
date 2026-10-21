import { hasExperimentationOptOut } from './experimentation-opt-out'

describe('customer opt-out timestamp', () => {
  it('preserves evaluation without an attribute', () => {
    expect(hasExperimentationOptOut({})).toBe(false)
  })
  it.each([
    '2026-01-01T00:00:00Z',
    '2099-01-01T00:00:00.123456789Z',
    '2024-02-29T23:59:59-04:30',
    '2000-02-29T00:00:00+05:45',
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
    'not-a-timestamp',
  ])('rejects malformed RFC3339 %j', (value) => {
    expect(hasExperimentationOptOut({ dd_experimentation_opt_out_at: value })).toBeUndefined()
  })
})
