import { createServer, type IncomingHttpHeaders } from 'node:http'
import { test as base, expect } from '@playwright/test'
import response from '../../packages/browser/test/data/precomputed-v1.json' with { type: 'json' }

type Context = { targetingKey: string; country?: string; dd_assignment_token?: string }
type State = { status: string; error?: string; events: string[] }
declare global {
  interface Window {
    authorizationTest: {
      initialize(origin: string, context: Context): Promise<State>
      update(context: Context): Promise<State>
      evaluate(): {
        boolean: { value: boolean; errorCode?: string }
        string: string
        integer: number
        number: number
        object: unknown
        missing: { value: boolean; errorCode?: string }
      }
      close(): Promise<void>
    }
  }
}

type RequestRecord = { headers: IncomingHttpHeaders; body: string }
type Origin = {
  url: string
  mode: 'success' | 'authorization' | 'unrelated401' | 'unavailable' | 'malformed'
  allowToken: boolean
  allowError: boolean
  posts: RequestRecord[]
  preflights: IncomingHttpHeaders[]
  telemetry: string[]
}
// Use actual HTTP on another origin: Playwright route interception can bypass
// the browser's CORS enforcement and cannot validate the header allowlist.
const test = base.extend<{ origin: Origin }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires destructuring even for a fixture with no dependencies.
  origin: async ({}, use) => {
    const origin: Origin = {
      url: '',
      mode: 'success',
      allowToken: true,
      allowError: true,
      posts: [],
      preflights: [],
      telemetry: [],
    }
    const server = createServer(async (req, res) => {
      const intake = req.url?.startsWith('/intake')
      if (intake || origin.mode === 'success' || origin.allowError || req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:4173')
      }
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
      res.setHeader(
        'Access-Control-Allow-Headers',
        `content-type, dd-client-token, dd-application-id${origin.allowToken ? ', dd-assignment-token' : ''}`
      )
      res.setHeader('Access-Control-Max-Age', '0')
      if (req.method === 'OPTIONS') {
        origin.preflights.push(req.headers)
        res.writeHead(204).end()
        return
      }
      let body = ''
      for await (const chunk of req) body += chunk.toString()
      if (intake) {
        origin.telemetry.push(body)
        res.writeHead(202).end()
        return
      }
      origin.posts.push({ headers: req.headers, body })
      res.setHeader('Content-Type', 'application/json')
      if (origin.mode === 'success') res.end(JSON.stringify(response))
      else if (origin.mode === 'malformed') res.end(String(req.headers['dd-assignment-token']))
      else if (origin.mode === 'unavailable') res.writeHead(503).end('temporarily unavailable')
      else
        res.writeHead(401).end(
          JSON.stringify({
            errors: [
              {
                code: origin.mode === 'authorization' ? 'ASSIGNMENT_AUTHORIZATION_FAILED' : 'UNRELATED_AUTH_ERROR',
              },
            ],
          })
        )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test origin')
    origin.url = `http://127.0.0.1:${address.port}`
    try {
      await use(origin)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  },
})
const context: Context = { targetingKey: 'user-a', country: 'US' }
const token = (offset = 3600) =>
  `eyJhbGciOiJQUzI1NiJ9.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + offset })).toString('base64url')}.signature`

test.beforeEach(async ({ page }) => {
  await page.goto('/assignment-authorization.html')
  await page.waitForFunction(() => Boolean(window.authorizationTest))
})

for (const mode of ['success', 'unrelated401', 'unavailable'] as const) {
  test(`no-token parity: ${mode}, all flag types and context updates`, async ({ page, origin }) => {
    expect(
      (
        await page.evaluate(([url, ctx]) => window.authorizationTest.initialize(url, ctx), [
          origin.url,
          context,
        ] as const)
      ).status
    ).toBe('READY')
    const initial = await page.evaluate(() => window.authorizationTest.evaluate())
    expect(initial).toMatchObject({
      boolean: { value: true },
      string: 'red',
      integer: 42,
      number: 3.14,
      object: { key: 'value', prop: 123 },
      missing: { value: false, errorCode: 'FLAG_NOT_FOUND' },
    })
    origin.mode = mode
    const state = await page.evaluate((ctx) => window.authorizationTest.update(ctx), { ...context, country: 'CA' })
    expect(state.status).toBe(mode === 'success' ? 'READY' : 'ERROR')
    // Existing ordinary-fetch-error behavior retains in-memory assignments.
    expect(await page.evaluate(() => window.authorizationTest.evaluate())).toMatchObject({
      ...initial,
      // Exposure deduplication legitimately changes cache-hit metadata on repeat reads.
      boolean: { value: true, reason: 'TARGETING_MATCH' },
    })
    expect(origin.posts).toHaveLength(mode === 'unavailable' ? 4 : 2)
    for (const request of origin.posts) {
      expect(request.headers['dd-assignment-token']).toBeUndefined()
      expect(request.headers['dd-client-token']).toBe('local-validation-client')
      expect(request.body).not.toContain('dd_assignment_token')
    }
    const subject = JSON.parse(origin.posts.at(-1)!.body).data.attributes.subject
    expect(subject).toEqual({ targeting_key: 'user-a', targeting_attributes: { ...context, country: 'CA' } })
    expect(
      origin.preflights.every(
        (headers) => !String(headers['access-control-request-headers']).includes('dd-assignment-token')
      )
    ).toBe(true)
    await page.evaluate(() => window.authorizationTest.close())
    await expect.poll(() => origin.telemetry.length).toBeGreaterThan(0)
  })
}

test('token refresh, omission, subject switch, and telemetry/storage isolation', async ({ page, origin }) => {
  const jwt = token()
  const replacement = token(7200)
  const logs: string[] = []
  page.on('console', (message) => logs.push(message.text()))
  expect(
    (
      await page.evaluate(([url, ctx]) => window.authorizationTest.initialize(url, ctx), [
        origin.url,
        { ...context, dd_assignment_token: jwt },
      ] as const)
    ).status
  ).toBe('READY')
  await page.evaluate(() => window.authorizationTest.evaluate())
  await page.evaluate((ctx) => window.authorizationTest.update(ctx), { ...context, dd_assignment_token: replacement })
  await page.evaluate((ctx) => window.authorizationTest.update(ctx), context)
  await page.evaluate((ctx) => window.authorizationTest.update(ctx), { targetingKey: 'user-b' })
  expect(origin.posts.map((request) => request.headers['dd-assignment-token'])).toEqual([
    jwt,
    replacement,
    undefined,
    undefined,
  ])
  expect(
    origin.preflights.some((headers) =>
      String(headers['access-control-request-headers']).includes('dd-assignment-token')
    )
  ).toBe(true)
  await page.evaluate(() => window.authorizationTest.close())
  await expect.poll(() => origin.telemetry.length).toBeGreaterThan(0)
  const storage = await page.evaluate(async () => {
    const values: unknown[] = [JSON.stringify(localStorage), JSON.stringify(sessionStorage)]
    for (const database of await indexedDB.databases()) {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(database.name!)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      for (const name of db.objectStoreNames) {
        values.push(
          await new Promise((resolve, reject) => {
            const request = db.transaction(name).objectStore(name).getAll()
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
          })
        )
      }
      db.close()
    }
    return JSON.stringify(values)
  })
  expect(storage).toContain('flags')
  for (const serialized of [
    storage,
    JSON.stringify(origin.telemetry),
    JSON.stringify(logs),
    JSON.stringify(origin.posts.map((r) => r.body)),
  ]) {
    expect(serialized).not.toContain(jwt)
    expect(serialized).not.toContain(replacement)
    expect(serialized).not.toContain('dd_assignment_token')
  }
})

test('readable rejection preserves matching cache, rejects another subject, and recovers', async ({ page, origin }) => {
  await page.evaluate(([url, ctx]) => window.authorizationTest.initialize(url, ctx), [origin.url, context] as const)
  origin.mode = 'authorization'
  const stale = await page.evaluate((ctx) => window.authorizationTest.update(ctx), {
    ...context,
    dd_assignment_token: token(),
  })
  expect(stale.status).toBe('STALE')
  expect(stale.events).toContain('PROVIDER_STALE')
  expect((await page.evaluate(() => window.authorizationTest.evaluate())).boolean.value).toBe(true)
  const error = await page.evaluate((ctx) => window.authorizationTest.update(ctx), { targetingKey: 'user-b' })
  expect(error.status).toBe('ERROR')
  expect((await page.evaluate(() => window.authorizationTest.evaluate())).boolean).toMatchObject({
    value: false,
    errorCode: 'GENERAL',
  })
  expect(origin.posts).toHaveLength(3) // Neither rejected request is retried, including a missing token.
  origin.mode = 'success'
  expect(
    (
      await page.evaluate((ctx) => window.authorizationTest.update(ctx), {
        targetingKey: 'user-b',
        dd_assignment_token: token(7200),
      })
    ).status
  ).toBe('READY')
  expect((await page.evaluate(() => window.authorizationTest.evaluate())).boolean.value).toBe(true)
  await page.evaluate(() => window.authorizationTest.close())
})

test('cold authorization rejection returns defaults and permits recovery', async ({ page, origin }) => {
  origin.mode = 'authorization'
  expect(
    (await page.evaluate(([url, ctx]) => window.authorizationTest.initialize(url, ctx), [origin.url, context] as const))
      .status
  ).toBe('ERROR')
  expect((await page.evaluate(() => window.authorizationTest.evaluate())).boolean).toMatchObject({
    value: false,
    errorCode: 'GENERAL',
  })
  expect(origin.posts).toHaveLength(1)
  origin.mode = 'success'
  expect(
    (await page.evaluate((ctx) => window.authorizationTest.update(ctx), { ...context, dd_assignment_token: token() }))
      .status
  ).toBe('READY')
  await page.evaluate(() => window.authorizationTest.close())
})

test('malformed token-bearing responses cannot echo credentials into errors or telemetry', async ({ page, origin }) => {
  const jwt = 'private.jwt.signature'
  const logs: string[] = []
  page.on('console', (message) => logs.push(message.text()))
  page.on('pageerror', (error) => logs.push(String(error)))
  origin.mode = 'malformed'
  const state = await page.evaluate(([url, ctx]) => window.authorizationTest.initialize(url, ctx), [
    origin.url,
    { ...context, dd_assignment_token: jwt },
  ] as const)
  expect(state.status).toBe('ERROR')
  expect(state.error).toContain('Assignment response is not valid JSON')
  expect((await page.evaluate(() => window.authorizationTest.evaluate())).boolean.value).toBe(false)
  expect(origin.posts).toHaveLength(1)
  expect(origin.posts[0].headers['dd-assignment-token']).toBe(jwt)
  await page.evaluate(() => window.authorizationTest.close())
  await expect.poll(() => origin.telemetry.length).toBeGreaterThan(0)
  const diagnostics = JSON.stringify([state, logs, origin.telemetry])
  expect(diagnostics).not.toContain('private.jwt')
  expect(diagnostics).not.toContain('dd_assignment_token')
})

test('expired token is rejected locally without invalidating matching assignments', async ({ page, origin }) => {
  await page.evaluate(([url, ctx]) => window.authorizationTest.initialize(url, ctx), [origin.url, context] as const)
  expect(
    (
      await page.evaluate((ctx) => window.authorizationTest.update(ctx), {
        ...context,
        dd_assignment_token: token(-120),
      })
    ).status
  ).toBe('STALE')
  expect(origin.posts).toHaveLength(1)
  expect((await page.evaluate(() => window.authorizationTest.evaluate())).boolean.value).toBe(true)
  await page.evaluate(() => window.authorizationTest.close())
})

for (const failure of ['header-not-allowed', 'error-not-readable'] as const) {
  test(`real CORS negative control: ${failure}`, async ({ page, origin }) => {
    origin.allowToken = failure !== 'header-not-allowed'
    origin.allowError = failure !== 'error-not-readable'
    origin.mode = failure === 'error-not-readable' ? 'authorization' : 'success'
    const state = await page.evaluate(([url, ctx]) => window.authorizationTest.initialize(url, ctx), [
      origin.url,
      { ...context, dd_assignment_token: token() },
    ] as const)
    expect(state.status).toBe('ERROR')
    expect(state.error).not.toContain('ASSIGNMENT_AUTHORIZATION_FAILED')
    expect(origin.posts).toHaveLength(failure === 'header-not-allowed' ? 0 : 3)
    expect(origin.preflights.length).toBeGreaterThan(0)
    await page.evaluate(() => window.authorizationTest.close())
  })
}
