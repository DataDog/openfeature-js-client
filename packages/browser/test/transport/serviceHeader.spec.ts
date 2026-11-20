/** @jest-environment node */

import { buildConfigurationHeaders } from '../../src/transport/fetchConfiguration'

// Node's Headers follows the Fetch standard, as browsers do. The jsdom polyfill does not check values.
describe('dd-service with the platform Headers', () => {
  const endpoints = ['precomputed', 'rules'] as const
  const headersFor = (service: string, endpoint: (typeof endpoints)[number]) =>
    buildConfigurationHeaders({ clientToken: 'test-token', service }, {}, endpoint)

  it.each(endpoints)('sends the service as fetch sends it on %s requests', (endpoint) => {
    const sent: Array<[string, string]> = [
      ['checkout', 'checkout'],
      ['Checkout API', 'Checkout API'],
      [' checkout\t', 'checkout'],
      ['café-api', 'café-api'],
    ]
    for (const [service, value] of sent) {
      expect(headersFor(service, endpoint)).toMatchObject({ 'dd-service': value })
    }
  })

  it.each(endpoints)('sends no header on %s requests when fetch rejects or empties the service', (endpoint) => {
    for (const service of ['   ', 'check\nout', 'check\rout', 'check\0out', '支付']) {
      const headers = headersFor(service, endpoint)

      expect(headers).not.toHaveProperty('dd-service')
      expect(headers).toMatchObject({ 'dd-client-token': 'test-token' })
      expect(() => new Headers(headers)).not.toThrow()
    }
  })
})
