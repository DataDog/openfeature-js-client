import { createDebugLogger } from '../../../src/debug'
import { createResponseSigningController } from '../../../src/transport/responseSigning/controller'

describe('signing diagnostic accessor parity', () => {
  let log: jest.SpyInstance
  beforeEach(() => {
    log = jest.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => jest.restoreAllMocks())

  it.each(['observe', 'required'] as const)('keeps %s trust reads identical with debug on and off', (mode) => {
    for (const enabled of [false, true]) {
      let reads = 0
      const signing = createResponseSigningController(
        {
          mode,
          get trustedRootCertificates() {
            return ++reads <= 2 ? ['test-root'] : []
          },
        },
        { flaggingProxy: 'https://proxy.test' },
        createDebugLogger(enabled)
      )
      expect(signing?.mode).toBe(mode)
      expect(reads).toBe(2)
      if (enabled) {
        const events = log.mock.calls.map(([line]) => JSON.parse(String(line).slice('[Datadog Feature Flags] '.length)))
        expect(events.find((event) => event.event === 'signing.trust').details).toMatchObject({
          trustAnchorCount: 1,
          source: 'explicit_roots',
        })
      } else expect(log).not.toHaveBeenCalled()
      log.mockClear()
    }
  })

  it.each([false, true])('does not read unused trust options with signing off and debug=%s', (enabled) => {
    const read = jest.fn(() => {
      throw new Error('unused roots')
    })
    expect(
      createResponseSigningController(
        {
          mode: 'off',
          get trustedRootCertificates(): readonly string[] {
            return read()
          },
        },
        {},
        createDebugLogger(enabled)
      )
    ).toBeUndefined()
    expect(read).not.toHaveBeenCalled()
  })
})
