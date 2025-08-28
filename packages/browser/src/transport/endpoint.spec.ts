import { buildEndpointHost } from './endpoint'

describe('buildEndpointHost', () => {
  describe('with default customer subdomain (preview)', () => {
    const testCases = [
      {
        description: 'for datadoghq.com site',
        site: 'datadoghq.com',
        expected: 'preview.ff-cdn.datadoghq.com',
      },
      {
        description: 'for us3.datadoghq.com site',
        site: 'us3.datadoghq.com',
        expected: 'preview.ff-cdn.us3.datadoghq.com',
      },
      {
        description: 'for us5.datadoghq.com site',
        site: 'us5.datadoghq.com',
        expected: 'preview.ff-cdn.us5.datadoghq.com',
      },
      {
        description: 'for ap1.datadoghq.com site',
        site: 'ap1.datadoghq.com',
        expected: 'preview.ff-cdn.ap1.datadoghq.com',
      },
      {
        description: 'for ap2.datadoghq.com site',
        site: 'ap2.datadoghq.com',
        expected: 'preview.ff-cdn.ap2.datadoghq.com',
      },
      {
        description: 'for datadoghq.eu site',
        site: 'datadoghq.eu',
        expected: 'preview.ff-cdn.datadoghq.eu',
      },
      {
        description: 'for datad0g.com site',
        site: 'datad0g.com',
        expected: 'preview.ff-cdn.datad0g.com',
      },
    ]

    test.each(testCases)('should return $expected $description', ({ site, expected }) => {
      const result = buildEndpointHost(site)
      expect(result).toBe(expected)
    })
  })

  describe('with customer subdomain', () => {
    const testCases = [
      {
        description: 'for datadoghq.com site',
        site: 'datadoghq.com',
        customerDomain: 'custom',
        expected: 'custom.ff-cdn.datadoghq.com',
      },
      {
        description: 'for us3.datadoghq.com site (non-default datacenter)',
        site: 'us3.datadoghq.com',
        customerDomain: 'custom',
        expected: 'custom.ff-cdn.us3.datadoghq.com',
      },
      {
        description: 'for datadoghq.eu site (non-default top-level domain)',
        site: 'datadoghq.eu',
        customerDomain: 'custom',
        expected: 'custom.ff-cdn.datadoghq.eu',
      },
      {
        description: 'for datad0g.com site (ddstaging)',
        site: 'datad0g.com',
        customerDomain: 'custom',
        expected: 'custom.ff-cdn.datad0g.com',
      },
    ]

    test.each(testCases)('should use custom domain $description', ({ site, customerDomain, expected }) => {
      const result = buildEndpointHost(site, customerDomain)
      expect(result).toBe(expected)
    })
  })

  describe('error cases', () => {
    const errorTestCases = [
      {
        description: 'for ddog-gov.com site',
        site: 'ddog-gov.com',
        expectedError: 'ddog-gov.com is not supported for flagging endpoints',
      },
      {
        description: 'for unsupported site',
        site: 'unsupported.example.com',
        expectedError:
          'Unsupported site: unsupported.example.com. Supported sites: datadoghq.com, us3.datadoghq.com, us5.datadoghq.com, ap1.datadoghq.com, ap2.datadoghq.com, datadoghq.eu',
      },
      {
        description: 'for empty string site',
        site: '',
        expectedError:
          'Unsupported site: . Supported sites: datadoghq.com, us3.datadoghq.com, us5.datadoghq.com, ap1.datadoghq.com, ap2.datadoghq.com, datadoghq.eu',
      },
    ]

    test.each(errorTestCases)('should throw error $description', ({ site, expectedError }) => {
      expect(() => buildEndpointHost(site)).toThrow(expectedError)
    })
  })

  describe('edge cases', () => {
    const edgeTestCases = [
      {
        description: 'empty custDomain',
        site: 'datadoghq.com',
        custDomain: '',
        expected: '.ff-cdn.datadoghq.com',
      },
      {
        description: 'special characters in custDomain',
        site: 'datadoghq.com',
        custDomain: 'test-env',
        expected: 'test-env.ff-cdn.datadoghq.com',
      },
    ]

    test.each(edgeTestCases)('should handle $description', ({ site, custDomain, expected }) => {
      const result = buildEndpointHost(site, custDomain)
      expect(result).toBe(expected)
    })
  })
})
