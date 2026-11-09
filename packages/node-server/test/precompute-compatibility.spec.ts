import crypto from 'node:crypto'
import {
  type ClientCompatibility,
  createExposureEvent,
  evaluate,
  configurationFromString as readPrecomputed,
} from '@datadog/flagging-core'
import wire from '../../browser/test/data/rules-v1-wire.json'
import {
  ConfigurationPrecomputeError,
  configurationFromString,
  configurationToString,
  precomputeConfiguration,
} from '../src/rules-based'

const context = { targetingKey: 'subject', country: 'US' }
const compatible = { capabilities: ['assignment-encoding-flag-key-256-v1'] }
const rules = () => configurationFromString(JSON.stringify(wire))

beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-11-06T12:00:00Z')))
afterEach(() => {
  jest.restoreAllMocks()
  jest.useRealTimers()
})

describe('target-client compatibility for precomputation', () => {
  it.each([undefined, { capabilities: [] }, { capabilities: ['unknown-v1', 'dependent-flag-variant-key-v1'] }])(
    'keeps the plaintext baseline for %j',
    (clientCompatibility) => {
      const random = jest.spyOn(crypto, 'randomBytes')
      const result = precomputeConfiguration(rules(), context, { clientCompatibility })
      expect(result.precomputed!.response.data.attributes.obfuscated).toBe(false)
      expect(result.precomputed!.response.data.attributes.obfuscation).toBeUndefined()
      expect(Object.keys(result.precomputed!.response.data.attributes.flags)).toContain('test-flag')
      expect(JSON.parse(configurationToString(result)).version).toBe(1)
      expect(random).not.toHaveBeenCalled()
    }
  )

  it('changes only the key map and encoding metadata, and round-trips through the precomputed reader', () => {
    const input = rules()
    for (const allocation of input.rules!.response.flags['test-flag'].allocations) allocation.logExposureEvent = true
    const before = configurationToString(input)
    const plaintext = precomputeConfiguration(input, context)
    const encoded = precomputeConfiguration(input, context, { clientCompatibility: compatible })
    const attributes = encoded.precomputed!.response.data.attributes
    expect(attributes.obfuscated).toBe(true)
    expect(attributes.obfuscation).toEqual({
      scheme: 'flag-key-sha256-v1',
      salt: expect.stringMatching(/^[a-f0-9]{32}$/),
    })
    expect(Object.keys(attributes.flags)).not.toContain('test-flag')
    const hash = crypto
      .createHash('sha256')
      .update('datadog.feature-flags.flag-key.v1\0')
      .update(Buffer.from(attributes.obfuscation!.salt, 'hex'))
      .update('test-flag')
      .digest('hex')
    expect(attributes.flags[hash]).toEqual(plaintext.precomputed!.response.data.attributes.flags['test-flag'])
    const serialized = configurationToString(encoded)
    expect(JSON.parse(serialized).version).toBe(2)
    const restored = readPrecomputed(serialized)
    const expected = evaluate(plaintext, 'boolean', 'test-flag', false, context)
    const actual = evaluate(restored, 'boolean', 'test-flag', false, context)
    expect(actual).toEqual(expected)
    const exposure = createExposureEvent(context, {
      ...actual,
      flagKey: 'test-flag',
      flagMetadata: actual.flagMetadata!,
    })
    expect(exposure).toMatchObject({ flag: { key: 'test-flag' } })
    expect(exposure).toEqual(
      createExposureEvent(context, { ...expected, flagKey: 'test-flag', flagMetadata: expected.flagMetadata! })
    )
    expect(restored.rules).toBeUndefined()
    expect(restored.precomputed!.context).toEqual(context)
    expect(configurationToString(input)).toBe(before)
  })

  it('uses the backend cross-language encoding vectors', () => {
    jest.spyOn(crypto, 'randomBytes').mockReturnValue(Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex') as never)
    const vectors = [
      ['new-route-planner', 'a60479237ef2f69175bbe0bd581966d1583766941815dc1d414c883767795190'],
      ['Flag', 'adca75d2141c51b0c0f084c1058edfb8e6e763f91aaf54ca06326d9847bd9586'],
      ['flag', '9817872c144b018abd77e3915bd77e2c27f4f534dccff8ffaca27361e3a5e1ee'],
      [' flag ', 'b1a5f851cc82a3fdf03a461d72a2241584dcf455df1d384e02a937901b3bc80b'],
      ['caf\u00e9', '3bfa8c3c17c1b61035b98ecf14007cdf5cba5ce61a48e8cfb65f8106541892d3'],
      ['cafe\u0301', '1e8b7ec5e8028a1ec96b38dd37f6ccea041c0a90358904af40ac5810c23c8765'],
      ['\ud83d\udeb2/\u65d7', '94b611e0d3b26b52f6ad66013d1c72f8a92ea109390049759e75d3c8d3aa4dab'],
      ['a\0b', 'bac134d201be5e7f28fc7019248f0809c2a013b137e866446ee71add2bc344c7'],
      ['', '072d985b427f536ad0a11b2d4c5e0f7e6f0ff6d23e779e082f75599ce3fe3eba'],
    ]
    const input = rules()
    const flag = input.rules!.response.flags['test-flag']
    input.rules!.response.flags = Object.fromEntries(vectors.map(([key]) => [key, flag]))
    const result = precomputeConfiguration(input, context, { clientCompatibility: compatible })
    expect(Object.keys(result.precomputed!.response.data.attributes.flags).sort()).toEqual(
      vectors.map(([, hash]) => hash).sort()
    )
  })

  it('uses a new salt for each snapshot, including empty snapshots', () => {
    const input = rules()
    input.rules!.response.flags = {}
    const first = precomputeConfiguration(input, context, { clientCompatibility: compatible })
    const second = precomputeConfiguration(input, context, { clientCompatibility: compatible })
    expect(first.precomputed!.response.data.attributes.obfuscation!.salt).not.toEqual(
      second.precomputed!.response.data.attributes.obfuscation!.salt
    )
    expect(readPrecomputed(configurationToString(first)).precomputed!.response.data.attributes.flags).toEqual({})
  })

  it('ignores unknown capabilities and future optional fields', () => {
    const clientCompatibility = {
      capabilities: [...compatible.capabilities, 'future-v1', ...compatible.capabilities],
      future: {},
    }
    expect(
      precomputeConfiguration(rules(), context, { clientCompatibility }).precomputed!.response.data.attributes
        .obfuscated
    ).toBe(true)
  })

  it.each([
    null,
    [],
    'secret',
    {},
    { capabilities: null },
    { capabilities: 'secret' },
    { capabilities: [42] },
    { capabilities: [undefined] },
  ])('rejects malformed compatibility %j with a typed error', (clientCompatibility) => {
    const run = () =>
      precomputeConfiguration(rules(), context, {
        clientCompatibility: clientCompatibility as unknown as ClientCompatibility,
      })
    expect(run).toThrow(ConfigurationPrecomputeError)
    expect(run).toThrow(expect.objectContaining({ code: 'invalid_options' }))
  })

  it('sanitizes accessor and revoked-proxy failures', () => {
    const proxy = Proxy.revocable({}, {})
    proxy.revoke()
    for (const clientCompatibility of [
      {
        get capabilities() {
          throw new Error('private input')
        },
      },
      proxy.proxy,
      {
        capabilities: [
          Object.defineProperty({}, 'value', {
            get() {
              throw new Error('private input')
            },
          }),
        ],
      },
    ]) {
      expect(() =>
        precomputeConfiguration(rules(), context, {
          clientCompatibility: clientCompatibility as ClientCompatibility,
        })
      ).toThrow(new ConfigurationPrecomputeError('invalid_options'))
    }
  })

  it('snapshots compatibility before user diagnostics run', () => {
    const input = rules()
    input.rules!.response.flags.broken = { ...input.rules!.response.flags['test-flag'], minimumFeatureLevel: 999 }
    const clientCompatibility = { capabilities: [...compatible.capabilities] }
    const result = precomputeConfiguration(input, context, {
      clientCompatibility,
      onEvaluationError: () => {
        clientCompatibility.capabilities.length = 0
      },
    })
    expect(result.precomputed!.response.data.attributes.obfuscated).toBe(true)
  })
})
