import { createFlagsConfigurationFetcher } from '../../src/transport/fetchConfiguration'

describe('existing unauthenticated assignment errors', () => {
  it('preserves the client-token diagnostic when no assignment token is supplied', async () => {
    const fetcher = createFlagsConfigurationFetcher({
      clientToken: 'bad-client-token',
      env: 'test',
      flagConfigurationFetch: async () =>
        new Response(JSON.stringify({ errors: [{ detail: 'invalid client token' }] }), {
          status: 401,
          headers: { 'content-type': 'application/vnd.api+json' },
        }),
    })
    await expect(fetcher({ targetingKey: 'user-a' })).rejects.toThrow('invalid client token')
  })
})

describe('assignment rejection classification', () => {
  it.each([
    [401, 'ASSIGNMENT_AUTHORIZATION_FAILED', 'GENERAL'],
    [401, 'invalid_client_token', undefined],
    [403, 'ASSIGNMENT_AUTHORIZATION_FAILED', undefined],
  ])('classifies only the assignment code on HTTP 401: %s %s', async (status, code, errorCode) => {
    const fetcher = createFlagsConfigurationFetcher({
      clientToken: 'client-token',
      env: 'test',
      flagConfigurationFetch: async () =>
        new Response(JSON.stringify({ errors: [{ code, detail: 'diagnostic' }] }), {
          status: status as number,
          headers: { 'content-type': 'application/vnd.api+json; charset=utf-8' },
        }),
    })
    const error = await fetcher({ targetingKey: 'a' }).catch((error) => error)
    expect(error.code).toBe(errorCode)
  })
})
