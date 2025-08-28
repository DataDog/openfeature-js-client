import { buildEndpointHost } from './endpoint'

describe('buildEndpointHost', () => {
  describe('with default custDomain (preview)', () => {
    it('should return default datadoghq.com endpoint when no site is provided', () => {
      const result = buildEndpointHost()
      expect(result).toBe('preview.ff-cdn.datadoghq.com')
    })

    it('should return default datadoghq.com endpoint when undefined site is provided', () => {
      const result = buildEndpointHost(undefined)
      expect(result).toBe('preview.ff-cdn.datadoghq.com')
    })

    it('should return datadoghq.com endpoint for datadoghq.com site', () => {
      const result = buildEndpointHost('datadoghq.com')
      expect(result).toBe('preview.ff-cdn.datadoghq.com')
    })

    it('should return us3 datacenter endpoint for us3.datadoghq.com site', () => {
      const result = buildEndpointHost('us3.datadoghq.com')
      expect(result).toBe('preview.ff-cdn.us3.datadoghq.com')
    })

    it('should return us5 datacenter endpoint for us5.datadoghq.com site', () => {
      const result = buildEndpointHost('us5.datadoghq.com')
      expect(result).toBe('preview.ff-cdn.us5.datadoghq.com')
    })

    it('should return ap1 datacenter endpoint for ap1.datadoghq.com site', () => {
      const result = buildEndpointHost('ap1.datadoghq.com')
      expect(result).toBe('preview.ff-cdn.ap1.datadoghq.com')
    })

    it('should return ap2 datacenter endpoint for ap2.datadoghq.com site', () => {
      const result = buildEndpointHost('ap2.datadoghq.com')
      expect(result).toBe('preview.ff-cdn.ap2.datadoghq.com')
    })

    it('should return EU endpoint for datadoghq.eu site', () => {
      const result = buildEndpointHost('datadoghq.eu')
      expect(result).toBe('preview.ff-cdn.datadoghq.eu')
    })

    it('should return staging endpoint for datad0g.com site', () => {
      const result = buildEndpointHost('datad0g.com')
      expect(result).toBe('preview.ff-cdn.datad0g.com')
    })
  })

  describe('with custom custDomain', () => {
    it('should use custom domain for datadoghq.com site', () => {
      const result = buildEndpointHost('datadoghq.com', 'custom')
      expect(result).toBe('custom.ff-cdn.datadoghq.com')
    })

    it('should use custom domain for us3.datadoghq.com site', () => {
      const result = buildEndpointHost('us3.datadoghq.com', 'custom')
      expect(result).toBe('custom.ff-cdn.us3.datadoghq.com')
    })

    it('should use custom domain for datadoghq.eu site', () => {
      const result = buildEndpointHost('datadoghq.eu', 'custom')
      expect(result).toBe('custom.ff-cdn.datadoghq.eu')
    })

    it('should use custom domain for datad0g.com site', () => {
      const result = buildEndpointHost('datad0g.com', 'custom')
      expect(result).toBe('custom.ff-cdn.datad0g.com')
    })
  })

  describe('error cases', () => {
    it('should throw error for ddog-gov.com site', () => {
      expect(() => buildEndpointHost('ddog-gov.com')).toThrow(
        'ddog-gov.com is not supported for flagging endpoints'
      )
    })

    it('should throw error for unsupported site', () => {
      const unsupportedSite = 'unsupported.example.com'
      expect(() => buildEndpointHost(unsupportedSite)).toThrow(
        `Unsupported site: ${unsupportedSite}. Supported sites: datadoghq.com, us3.datadoghq.com, us5.datadoghq.com, ap1.datadoghq.com, ap2.datadoghq.com, datadoghq.eu`
      )
    })

    it('should default to datadoghq.com for empty string site', () => {
      const result = buildEndpointHost('')
      expect(result).toBe('preview.ff-cdn.datadoghq.com')
    })
  })

  describe('edge cases', () => {
    it('should handle empty custDomain', () => {
      const result = buildEndpointHost('datadoghq.com', '')
      expect(result).toBe('.ff-cdn.datadoghq.com')
    })

    it('should handle special characters in custDomain', () => {
      const result = buildEndpointHost('datadoghq.com', 'test-env')
      expect(result).toBe('test-env.ff-cdn.datadoghq.com')
    })
  })
})