/** @jest-environment node */
// Node's Headers follows the Fetch standard, as browsers do. The jsdom polyfill does not trim values.
import { buildConfigurationHeaders } from '../../src/transport/fetchConfiguration'

describe('dd-service header value', () => {
  const endpoints = ['precomputed', 'rules'] as const

  it.each(endpoints)('sends the service as fetch sends it on %s requests', (endpoint) => {
    for (const [service, sent] of [
      ['checkout', 'checkout'],
      ['web-store.v2:prod/api', 'web-store.v2:prod/api'],
      ['Checkout API', 'Checkout API'],
      [' checkout', 'checkout'],
      ['checkout\n', 'checkout'],
      ['café-api', 'café-api'],
    ]) {
      const headers = buildConfigurationHeaders({ clientToken: 'test-token', service }, {}, endpoint)

      expect(headers).toMatchObject({ 'dd-service': sent })
      expect(() => new Headers(headers)).not.toThrow()
    }
  })

  it.each(endpoints)('sends no header on %s requests for a service fetch cannot send', (endpoint) => {
    for (const service of [undefined, null, '', '   ', 'check\nout', '支付']) {
      expect(buildConfigurationHeaders({ clientToken: 'test-token', service }, {}, endpoint)).not.toHaveProperty(
        'dd-service'
      )
    }
  })
})
