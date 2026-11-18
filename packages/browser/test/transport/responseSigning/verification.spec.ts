/** @jest-environment node */
/**
 * Response signing v1 with a certificate chain: leaf -> 1 to 3 intermediates -> pinned root.
 *
 * The chain tests use the real Vault-issued credentials in `chain-fixtures/` and synthetic chains
 * that change one certificate-profile rule at a time.
 *
 * The shared ffe-system-test-data corpora at the current `ffe-response-signing-data` pin, the local
 * `key-usage-supplement.json` and `shared-fixtures/` still use the removed single
 * `x-datadog-feature-flags-signing-intermediate` format and transcript tail. They are kept below and
 * skipped. A follow-up commit updates the pin to the regenerated chain fixtures and enables them again.
 */
import { createHash, generateKeyPairSync, type KeyObject, sign, webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TextDecoder, TextEncoder } from 'node:util'
import { AsnConvert, OctetString } from '@peculiar/asn1-schema'
import { BasicConstraints, Certificate, ExtendedKeyUsage, Extension, Extensions, Validity } from '@peculiar/asn1-x509'
import {
  buildSigningTranscript,
  decodeBase64,
  sha256,
  validateSigningRequest,
  verifyResponse,
} from '../../../src/transport/responseSigning/verification'
import {
  type CredentialName,
  expectedTranscript,
  FIXTURE_NOW,
  loadCredential,
  ROOT_A,
  ROOT_B,
  signedResponse,
  signingRequest,
} from './chainFixtures'

const previousCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!
beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
  Object.assign(globalThis, { TextEncoder, TextDecoder })
})
afterAll(() => Object.defineProperty(globalThis, 'crypto', previousCrypto))

const FFE_EKU = '1.3.6.1.4.1.99999.1.1'
const ANY_EKU = '2.5.29.37.0'
const CODE_SIGNING = '1.3.6.1.5.5.7.3.3'

test('fixture roots and the FFE EKU DER match the protocol constants', () => {
  expect(Buffer.from(AsnConvert.serialize(new ExtendedKeyUsage([FFE_EKU]))).toString('hex')).toBe(
    '300c060a2b0601040186' + '8d1f0101'
  )
  expect(Buffer.from(AsnConvert.serialize(new ExtendedKeyUsage([ANY_EKU]))).toString('hex')).toBe(
    '3006060455' + '1d2500'
  )
  expect(ROOT_A).not.toBe(ROOT_B)
})

describe('chain fixture table (real Vault-issued credentials)', () => {
  const pinned = { A: ROOT_A, B: ROOT_B }
  const table: Array<[CredentialName, Array<keyof typeof pinned>, boolean, string | undefined]> = [
    ['lukas-valid', ['A'], true, undefined],
    ['lukas-backup-root', ['B'], true, undefined],
    ['lukas-backup-root', ['A', 'B'], true, undefined],
    ['lukas-backup-root', ['A'], false, 'invalid-certificate'],
    ['lukas-rotated', ['A'], true, undefined],
    ['other-product', ['A'], false, 'invalid-certificate'],
    ['missing-dc-int', ['A'], false, 'invalid-certificate'],
    ['single-int-ffe', ['A'], true, undefined],
    ['v1-codesigning', ['A'], false, 'invalid-certificate'],
    ['unrelated-root', ['A', 'B'], false, 'invalid-certificate'],
  ]
  test.each(table)('%s with pinned roots %j: accept=%s', async (name, roots, accept, reason) => {
    const request = signingRequest()
    const response = signedResponse(request, loadCredential(name))
    const result = verifyResponse(
      request,
      response,
      roots.map((root) => pinned[root]),
      FIXTURE_NOW
    )
    if (accept) await expect(result).resolves.toEqual({ expiresAt: response.expiresAt, verifiedAt: FIXTURE_NOW })
    else await expect(result).rejects.toThrow(reason)
  })
})

describe('wire format and transcript', () => {
  test('the SDK transcript equals the independent v1 transcript, including the chain tail', async () => {
    const request = signingRequest()
    const credential = loadCredential('lukas-valid')
    const response = signedResponse(request, credential)
    const leaf = decodeBase64(credential.leafBase64, 4096)
    const intermediates = credential.intermediatesBase64.map((value) => decodeBase64(value, 4096))
    const transcript = await buildSigningTranscript(
      request,
      response,
      response.issuedAt,
      response.expiresAt,
      leaf,
      intermediates
    )
    expect(Buffer.from(transcript).equals(response.transcript)).toBe(true)
    expect(Buffer.from(transcript.subarray(0, 49)).toString()).toBe(
      'datadog.feature-flags.precomputed-assignments.v1\0'
    )
    // Tail: SHA256(leaf) || u8(n) || SHA256(int[0]) || SHA256(int[1]).
    const tail = Buffer.from(transcript.subarray(transcript.length - 32 * 3 - 1))
    const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest()
    expect(
      tail.equals(Buffer.concat([digest(leaf), Buffer.from([2]), digest(intermediates[0]), digest(intermediates[1])]))
    ).toBe(true)
  })
  test('the intermediate order is bound by the transcript and the path', async () => {
    const request = signingRequest()
    const credential = loadCredential('lukas-valid')
    const reversed = { ...credential, intermediatesBase64: [...credential.intermediatesBase64].reverse() }
    await expect(verifyResponse(request, signedResponse(request, reversed), [ROOT_A], FIXTURE_NOW)).rejects.toThrow(
      'invalid-certificate'
    )
    // A valid proof whose chain header is reordered after signing fails too.
    const response = signedResponse(request, credential)
    response.headers.set('x-datadog-feature-flags-signing-chain', reversed.intermediatesBase64.join(','))
    await expect(verifyResponse(request, response, [ROOT_A], FIXTURE_NOW)).rejects.toThrow()
  })
  test('a tampered body fails the signature', async () => {
    const request = signingRequest()
    const response = signedResponse(request, loadCredential('lukas-valid'))
    await expect(
      verifyResponse(request, { ...response, body: new Uint8Array(Buffer.from('{}')) }, [ROOT_A], FIXTURE_NOW)
    ).rejects.toThrow('invalid-signature')
  })
  test.each([
    ['missing', null, 'missing-proof'],
    ['empty', '', 'missing-proof'],
    ['space after comma', (chain: string[]) => chain.join(', '), 'invalid-proof'],
    ['trailing comma', (chain: string[]) => `${chain.join(',')},`, 'invalid-proof'],
    ['four entries', (chain: string[]) => [...chain, ...chain].join(','), 'invalid-proof'],
  ] as const)('the signing-chain header rejects %s', async (_label, value, reason) => {
    const request = signingRequest()
    const credential = loadCredential('lukas-valid')
    const response = signedResponse(request, credential)
    if (value === null) response.headers.delete('x-datadog-feature-flags-signing-chain')
    else
      response.headers.set(
        'x-datadog-feature-flags-signing-chain',
        typeof value === 'string' ? value : value(credential.intermediatesBase64)
      )
    await expect(verifyResponse(request, response, [ROOT_A], FIXTURE_NOW)).rejects.toThrow(reason)
  })
  test('an entry larger than 4096 bytes DER is rejected', async () => {
    const request = signingRequest()
    const credential = loadCredential('lukas-valid')
    const response = signedResponse(request, credential)
    const oversized = Buffer.alloc(4097, 1).toString('base64')
    response.headers.set('x-datadog-feature-flags-signing-chain', `${credential.intermediatesBase64[0]},${oversized}`)
    await expect(verifyResponse(request, response, [ROOT_A], FIXTURE_NOW)).rejects.toThrow('invalid-proof')
  })
  test('a response with only the removed signing-intermediate header is rejected', async () => {
    const request = signingRequest()
    const credential = loadCredential('single-int-ffe')
    const response = signedResponse(request, credential)
    response.headers.delete('x-datadog-feature-flags-signing-chain')
    response.headers.set('x-datadog-feature-flags-signing-intermediate', credential.intermediatesBase64[0])
    await expect(verifyResponse(request, response, [ROOT_A], FIXTURE_NOW)).rejects.toThrow('missing-proof')
  })
  test.each(['2', '3'])(
    'prototype signature version %s is rejected on the request and the response',
    async (version) => {
      const request = signingRequest()
      const response = signedResponse(request, loadCredential('lukas-valid'))
      response.headers.set('x-datadog-feature-flags-signature-version', version)
      await expect(verifyResponse(request, response, [ROOT_A], FIXTURE_NOW)).rejects.toThrow('invalid-proof')
      const prototypeRequest = signingRequest()
      prototypeRequest.headers.set('x-datadog-feature-flags-signature-version', version)
      expect(() => validateSigningRequest(prototypeRequest)).toThrow('unsupported-request')
    }
  )
  test.each(['v2', 'v3'])('a proof over the %s transcript domain is rejected', async (domain) => {
    const request = signingRequest()
    const credential = loadCredential('lukas-valid')
    const response = signedResponse(request, credential)
    const transcript = Buffer.from(response.transcript)
    transcript.write(`datadog.feature-flags.precomputed-assignments.${domain}\0`, 0, 'utf8')
    response.headers.set(
      'x-datadog-feature-flags-signature',
      sign('sha256', transcript, credential.privateKey).toString('base64')
    )
    await expect(verifyResponse(request, response, [ROOT_A], FIXTURE_NOW)).rejects.toThrow('invalid-signature')
  })
  test.each([
    ['https://PREVIEW.ff-cdn.datad0g.com:443/precompute-assignments?dd_env=e', 'preview.ff-cdn.datad0g.com'],
    ['https://preview.ff-cdn.datad0g.com:8443/precompute-assignments?dd_env=e', 'preview.ff-cdn.datad0g.com:8443'],
    ['https://[::1]:443/precompute-assignments?dd_env=e', '[::1]'],
  ])('the transcript authority of %s is %s', async (url, authority) => {
    const request = signingRequest(url)
    const credential = loadCredential('lukas-valid')
    const response = signedResponse(request, credential)
    await expect(verifyResponse(request, response, [ROOT_A], FIXTURE_NOW)).resolves.toHaveProperty('expiresAt')
    const transcript = await buildSigningTranscript(
      request,
      response,
      response.issuedAt,
      response.expiresAt,
      decodeBase64(credential.leafBase64, 4096),
      credential.intermediatesBase64.map((value) => decodeBase64(value, 4096))
    )
    const length = Buffer.alloc(4)
    length.writeUInt32BE(authority.length)
    const expected = Buffer.concat([Buffer.from('\0\0\0\x05https'), length, Buffer.from(authority)])
    expect(Buffer.from(transcript).includes(expected)).toBe(true)
  })
  test('the proof must cover now and stay within the leaf validity', async () => {
    const request = signingRequest()
    const credential = loadCredential('lukas-valid')
    await expect(
      verifyResponse(
        request,
        signedResponse(request, credential, FIXTURE_NOW + 72 * 3600),
        [ROOT_A],
        FIXTURE_NOW + 72 * 3600
      )
    ).rejects.toThrow('expired-proof')
  })
})

/**
 * Synthetic chains re-sign real fixture certificates with fresh keys and changed extensions.
 * They isolate one profile rule at a time; the verifier still parses every certificate from DER.
 */
describe('certificate profile (synthetic re-signed chains)', () => {
  interface Node {
    certificate: Certificate
    der: Uint8Array
    privateKey: KeyObject
  }
  const template = loadCredential('lukas-valid')
  const templates = {
    root: ROOT_A,
    dc: template.intermediatesBase64[1],
    tls: template.intermediatesBase64[0],
    leaf: template.leafBase64,
  }
  function ext(id: string, critical: boolean, value: object): Extension {
    return new Extension({ extnID: id, critical, extnValue: new OctetString(AsnConvert.serialize(value)) })
  }
  const caBasic = (pathLenConstraint?: number, critical = true, cA = true) =>
    ext(
      '2.5.29.19',
      critical,
      new BasicConstraints({ cA, ...(pathLenConstraint !== undefined && { pathLenConstraint }) })
    )
  const eku = (...purposes: string[]) => ext('2.5.29.37', false, new ExtendedKeyUsage(purposes))
  function forge(
    templateBase64: string,
    issuer: Node | 'self',
    replace: Extension[],
    remove: string[] = [],
    lifetime = 10 * 24 * 3600
  ): Node {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const certificate = AsnConvert.parse(Buffer.from(templateBase64, 'base64'), Certificate)
    const tbs = certificate.tbsCertificate
    const spki = publicKey.export({ format: 'der', type: 'spki' })
    tbs.subjectPublicKeyInfo.subjectPublicKey = new Uint8Array(spki.subarray(spki.length - 65)).buffer
    tbs.issuer = issuer === 'self' ? tbs.subject : issuer.certificate.tbsCertificate.subject
    tbs.validity = new Validity({
      notBefore: new Date((FIXTURE_NOW - 3600 - (issuer === 'self' ? 1000 : 0)) * 1000),
      notAfter: new Date((FIXTURE_NOW + lifetime) * 1000),
    })
    // Drop key identifiers: they are optional per link and would otherwise name the template keys.
    const dropped = new Set(['2.5.29.14', '2.5.29.35', ...remove, ...replace.map((e) => e.extnID)])
    const extensions = (tbs.extensions || []).filter((e) => !dropped.has(e.extnID))
    tbs.extensions = new Extensions([...extensions, ...replace])
    const tbsDer = Buffer.from(AsnConvert.serialize(tbs))
    const signer = issuer === 'self' ? privateKey : issuer.privateKey
    const forged = new Certificate({
      tbsCertificate: tbs,
      signatureAlgorithm: certificate.signatureAlgorithm,
      signatureValue: new Uint8Array(sign('sha256', tbsDer, signer)).buffer,
    })
    const der = new Uint8Array(AsnConvert.serialize(forged))
    return { certificate: AsnConvert.parse(der, Certificate), der, privateKey }
  }
  const b64 = (node: Node) => Buffer.from(node.der).toString('base64')
  interface Shape {
    root?: Extension[]
    intermediates?: Extension[][]
    leaf?: Extension[]
    leafRemove?: string[]
    intermediateRemove?: string[][]
  }
  /** Root -> intermediate[n-1] -> ... -> intermediate[0] -> leaf. Defaults mirror the Vault fixtures. */
  function chain(shape: Shape = {}) {
    const root = forge(templates.root, 'self', shape.root ?? [caBasic(2)])
    const intermediateShapes = shape.intermediates ?? [[caBasic(0)], [caBasic(1)]]
    const intermediates: Node[] = []
    let parent = root
    for (let index = intermediateShapes.length - 1; index >= 0; index--) {
      parent = forge(
        index === 0 ? templates.tls : templates.dc,
        parent,
        intermediateShapes[index],
        shape.intermediateRemove?.[index]
      )
      intermediates.unshift(parent)
    }
    const leaf = forge(templates.leaf, intermediates[0], shape.leaf ?? [eku(FFE_EKU)], shape.leafRemove, 3 * 24 * 3600)
    return { root, intermediates, leaf }
  }
  async function verify(shape: Shape, mutate?: (nodes: ReturnType<typeof chain>) => void) {
    const nodes = chain(shape)
    mutate?.(nodes)
    const request = signingRequest()
    const response = signedResponse(request, {
      privateKey: nodes.leaf.privateKey,
      leafBase64: b64(nodes.leaf),
      intermediatesBase64: nodes.intermediates.map(b64),
    })
    return verifyResponse(request, response, [b64(nodes.root)], FIXTURE_NOW)
  }
  const accepts = (shape: Shape) => expect(verify(shape)).resolves.toHaveProperty('expiresAt')
  const rejects = (shape: Shape) => expect(verify(shape)).rejects.toThrow('invalid-certificate')

  test('the synthetic baseline (Vault fixture shape) is accepted', () => accepts({}))

  test('leaf EKU with FFE plus other OIDs is accepted', () => accepts({ leaf: [eku(CODE_SIGNING, FFE_EKU)] }))
  test('leaf EKU criticality is not checked', () =>
    accepts({ leaf: [ext('2.5.29.37', true, new ExtendedKeyUsage([FFE_EKU]))] }))
  test('leaf EKU with anyExtendedKeyUsage is rejected', () => rejects({ leaf: [eku(FFE_EKU, ANY_EKU)] }))
  test('leaf EKU of codeSigning only is rejected', () => rejects({ leaf: [eku(CODE_SIGNING)] }))
  test('leaf EKU of another product only is rejected', () => rejects({ leaf: [eku('1.3.6.1.4.1.99999.1.2')] }))
  test('leaf without EKU is rejected', () => rejects({ leaf: [], leafRemove: ['2.5.29.37'] }))

  test('intermediate pathLen above its index is accepted', () =>
    accepts({ intermediates: [[caBasic(5)], [caBasic(1)]] }))
  test('intermediate[1] with pathLen 0 is rejected', () => rejects({ intermediates: [[caBasic(0)], [caBasic(0)]] }))
  test('intermediate without pathLen is rejected', () => rejects({ intermediates: [[caBasic()], [caBasic(1)]] }))
  test('intermediate with cA false is rejected', () =>
    rejects({ intermediates: [[caBasic(0, true, false)], [caBasic(1)]] }))
  test('non-critical intermediate basicConstraints is rejected', () =>
    rejects({ intermediates: [[caBasic(0, false)], [caBasic(1)]] }))
  test.each([
    ['FFE', [FFE_EKU], true],
    ['anyExtendedKeyUsage', [ANY_EKU], true],
    ['FFE with others', [CODE_SIGNING, FFE_EKU], true],
    ['codeSigning only', [CODE_SIGNING], false],
  ] as const)('intermediate EKU %s %j accept=%s', async (_label, purposes, accept) => {
    const shape = { intermediates: [[caBasic(0), eku(...purposes)], [caBasic(1)]] }
    if (accept) await accepts(shape)
    else await rejects(shape)
  })

  test('root pathLen below the intermediate count is rejected', () => rejects({ root: [caBasic(1)] }))
  test('root without pathLen is accepted', () => accepts({ root: [caBasic()] }))
  test.each([
    ['FFE', [FFE_EKU], true],
    ['anyExtendedKeyUsage', [ANY_EKU], true],
    ['FFE with others', [CODE_SIGNING, FFE_EKU], true],
    ['codeSigning only', [CODE_SIGNING], false],
    ['another product only', ['1.3.6.1.4.1.99999.1.2'], false],
  ] as const)('pinned root EKU %s %j accept=%s', async (_label, purposes, accept) => {
    const shape = { root: [caBasic(2), eku(...purposes)] }
    if (accept) await accepts(shape)
    else await rejects(shape)
  })
  test('a single intermediate under a root with pathLen 1 is accepted', () =>
    accepts({ root: [caBasic(1)], intermediates: [[caBasic(0)]] }))
  test('three intermediates are accepted', () =>
    accepts({ root: [caBasic(3)], intermediates: [[caBasic(0)], [caBasic(1)], [caBasic(2)]] }))
  test('four intermediates are rejected', async () => {
    await expect(
      verify({ root: [caBasic()], intermediates: [[caBasic(0)], [caBasic(1)], [caBasic(2)], [caBasic(3)]] })
    ).rejects.toThrow('invalid-proof')
  })
  test('every link is checked: intermediate[0] not issued by intermediate[1] is rejected', async () => {
    await expect(
      verify({}, (nodes) => {
        // Re-issue intermediate[0] from the root, keeping intermediate[1] in the header.
        const other = chain()
        nodes.intermediates[0] = other.intermediates[0]
        nodes.leaf = forge(templates.leaf, other.intermediates[0], [eku(FFE_EKU)], [], 3 * 24 * 3600)
      })
    ).rejects.toThrow('invalid-certificate')
  })
})

// Buffer.slice is a view, unlike Uint8Array.slice. Crypto must receive exactly the logical bytes.
test('hashes exactly the supplied view, including a Buffer subclass', async () => {
  const input = Buffer.from('prefix-exact-suffix').subarray(7, 12)
  expect(Buffer.from(await sha256(input)).toString('hex')).toBe(createHash('sha256').update('exact').digest('hex'))
})

test('the independent transcript helper is self-consistent with the response helper', () => {
  const request = signingRequest()
  const credential = loadCredential('single-int-ffe')
  const response = signedResponse(request, credential)
  const again = expectedTranscript(
    request,
    response,
    response.issuedAt,
    response.expiresAt,
    Buffer.from(credential.leafBase64, 'base64'),
    credential.intermediatesBase64.map((value) => Buffer.from(value, 'base64'))
  )
  expect(again.equals(response.transcript)).toBe(true)
  expect(again[again.length - 33]).toBe(1)
})

const SHARED_V1_FIXTURES_DISABLED =
  'disabled: the pinned fixtures use the removed signing-intermediate format; ' +
  'a follow-up commit updates the ffe-response-signing-data pin to the chain fixtures'
const chainOf = (headers: Headers) =>
  (headers.get('x-datadog-feature-flags-signing-chain') ?? '').split(',').map((value) => decodeBase64(value, 4096))
describe.skip(`shared v1 fixture suites (${SHARED_V1_FIXTURES_DISABLED})`, () => {
  const fixtureDirectory = join(__dirname, '../../ffe-response-signing-data/response-signing/v1')
  const raw = readFileSync(join(fixtureDirectory, 'corpus.json'))
  const corpus = JSON.parse(raw.toString()) as {
    anchor_der_base64: string
    cases: Array<{
      id: string
      now: number
      expected_accept: boolean
      transcript_base64?: string
      request: { url: string; method: string; headers: [string, string][]; body_base64: string }
      response: { status: number; headers: [string, string][]; body_base64: string }
    }>
  }

  test('the independent corpus and applicability counts are unchanged', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(
      '393490bfefe382b9b75cf2964c131a910faa679888689457f99c2da2dc57fbbd'
    )
    expect(corpus.cases).toHaveLength(46)
    expect(corpus.cases.filter((c) => c.expected_accept)).toHaveLength(6)
  })
  test.each(corpus.cases)('$id', async (vector) => {
    const request = {
      ...vector.request,
      headers: new Headers(vector.request.headers),
      body: decodeBase64(vector.request.body_base64, 1024 * 1024),
    }
    const response = {
      ...vector.response,
      headers: new Headers(vector.response.headers),
      body: decodeBase64(vector.response.body_base64, 2 * 1024 * 1024),
    }
    if (vector.expected_accept) {
      await expect(verifyResponse(request, response, [corpus.anchor_der_base64], vector.now)).resolves.toEqual({
        expiresAt: Number(response.headers.get('x-datadog-feature-flags-expires-at')),
        verifiedAt: vector.now,
      })
      const transcript = await buildSigningTranscript(
        request,
        response,
        Number(response.headers.get('x-datadog-feature-flags-issued-at')),
        Number(response.headers.get('x-datadog-feature-flags-expires-at')),
        decodeBase64(response.headers.get('x-datadog-feature-flags-signing-certificate')!, 4096),
        chainOf(response.headers)
      )
      expect(Buffer.from(transcript).toString('base64')).toBe(vector.transcript_base64)
    } else {
      await expect(verifyResponse(request, response, [corpus.anchor_der_base64], vector.now)).rejects.toThrow()
    }
  })

  const nestedDerRaw = readFileSync(join(fixtureDirectory, 'nested-der.json'))
  const nestedDer = JSON.parse(nestedDerRaw.toString()) as typeof corpus
  test('the shared nested-DER regression inputs are unchanged', () => {
    expect(createHash('sha256').update(nestedDerRaw).digest('hex')).toBe(
      '16a5de8b346087c4e4145e5c7bb43ac2dfd945a780fb56a75f38b1f7061302c4'
    )
    expect(nestedDer.cases).toHaveLength(2)
  })
  test.each(nestedDer.cases)('shared certificate regression: $id', async (vector) => {
    const request = {
      ...vector.request,
      headers: new Headers(vector.request.headers),
      body: decodeBase64(vector.request.body_base64, 1024 * 1024),
    }
    const response = {
      ...vector.response,
      headers: new Headers(vector.response.headers),
      body: decodeBase64(vector.response.body_base64, 2 * 1024 * 1024),
    }
    const result = verifyResponse(request, response, [nestedDer.anchor_der_base64], vector.now)
    if (vector.expected_accept) await expect(result).resolves.toHaveProperty('expiresAt')
    else await expect(result).rejects.toThrow('invalid-certificate')
  })

  // Independent reviewer regression: X.690 11.2.2 requires minimal encoding of named-bit lists.
  // Public-only synthetic chains/proofs; the pinned 46-case public-v1 corpus is independently generated.
  const keyUsageRaw = readFileSync(join(__dirname, 'key-usage-supplement.json'))
  const keyUsageSupplement = JSON.parse(keyUsageRaw.toString()) as { anchor: string; cases: typeof corpus.cases }
  test('the independently reviewed KeyUsage supplemental oracle is unchanged', () => {
    expect(createHash('sha256').update(keyUsageRaw).digest('hex')).toBe(
      'f7b55015240951b90596692c5edec4209660a842b6f5e82e9d39da2be7c83cd1'
    )
  })
  test.each(keyUsageSupplement.cases)('canonical DER control: $id', async (vector) => {
    const request = {
      ...vector.request,
      headers: new Headers(vector.request.headers),
      body: decodeBase64(vector.request.body_base64, 1024 * 1024),
    }
    const response = {
      ...vector.response,
      headers: new Headers(vector.response.headers),
      body: decodeBase64(vector.response.body_base64, 2 * 1024 * 1024),
    }
    const result = verifyResponse(request, response, [keyUsageSupplement.anchor], vector.now)
    if (vector.expected_accept) await expect(result).resolves.toHaveProperty('expiresAt')
    else await expect(result).rejects.toThrow('invalid-certificate')
  })

  const isolatedRaw = readFileSync(join(fixtureDirectory, 'isolated-certificate-rules.json'))
  const isolated = JSON.parse(isolatedRaw.toString()) as typeof corpus
  test('isolated certificate fixture integrity', () => {
    expect(createHash('sha256').update(isolatedRaw).digest('hex')).toBe(
      '7304bb12f011688a39b53ebd5fb5d842febd0f5ae81e67126a7e24d1e79a225a'
    )
    expect(isolated.cases).toHaveLength(4)
  })
  test.each(isolated.cases)('$id', async (vector) => {
    const request = {
      ...vector.request,
      headers: new Headers(vector.request.headers),
      body: decodeBase64(vector.request.body_base64, 1024 * 1024),
    }
    const response = {
      ...vector.response,
      headers: new Headers(vector.response.headers),
      body: decodeBase64(vector.response.body_base64, 2 * 1024 * 1024),
    }
    if (vector.expected_accept) {
      await expect(verifyResponse(request, response, [isolated.anchor_der_base64], vector.now)).resolves.toEqual({
        expiresAt: Number(response.headers.get('x-datadog-feature-flags-expires-at')),
        verifiedAt: vector.now,
      })
      const transcript = await buildSigningTranscript(
        request,
        response,
        Number(response.headers.get('x-datadog-feature-flags-issued-at')),
        Number(response.headers.get('x-datadog-feature-flags-expires-at')),
        decodeBase64(response.headers.get('x-datadog-feature-flags-signing-certificate')!, 4096),
        chainOf(response.headers)
      )
      expect(Buffer.from(transcript).toString('base64')).toBe(vector.transcript_base64)
    } else {
      await expect(verifyResponse(request, response, [isolated.anchor_der_base64], vector.now)).rejects.toThrow()
    }
  })

  const supplementDirectory = join(__dirname, 'shared-fixtures')
  const manifest = JSON.parse(readFileSync(join(supplementDirectory, 'manifest.json'), 'utf8')) as {
    files: Record<string, { sha256: string; response_cases: number }>
  }
  for (const name of ['subject-der', 'near-expiry', 'extension-profile']) {
    const filename = `${name}.json`
    const bytes = readFileSync(join(supplementDirectory, filename))
    const supplement = JSON.parse(bytes.toString()) as typeof corpus
    test(`shared ${name} fixture integrity`, () => {
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(manifest.files[filename].sha256)
      expect(supplement.cases).toHaveLength(manifest.files[filename].response_cases)
    })
    test.each(supplement.cases)(`${name}: $id`, async (vector) => {
      const request = {
        ...vector.request,
        headers: new Headers(vector.request.headers),
        body: decodeBase64(vector.request.body_base64, 1024 * 1024),
      }
      const response = {
        ...vector.response,
        headers: new Headers(vector.response.headers),
        body: decodeBase64(vector.response.body_base64, 2 * 1024 * 1024),
      }
      const result = verifyResponse(request, response, [supplement.anchor_der_base64], vector.now)
      if (!vector.expected_accept) {
        await expect(result).rejects.toThrow()
        return
      }
      const issued = Number(response.headers.get('x-datadog-feature-flags-issued-at'))
      const expires = Number(response.headers.get('x-datadog-feature-flags-expires-at'))
      await expect(result).resolves.toEqual({ expiresAt: expires, verifiedAt: vector.now })
      const transcript = await buildSigningTranscript(
        request,
        response,
        issued,
        expires,
        decodeBase64(response.headers.get('x-datadog-feature-flags-signing-certificate')!, 4096),
        chainOf(response.headers)
      )
      expect(Buffer.from(transcript).toString('base64')).toBe(vector.transcript_base64)
      await expect(verifyResponse(request, response, [supplement.anchor_der_base64], expires)).rejects.toThrow()
    })
  }
})
