/** @jest-environment node */
/**
 * Response signing v1 with a certificate chain: leaf -> 1 to 3 intermediates -> pinned root.
 *
 * The chain tests use the test-CA-issued credentials in `test/data/response-signing/chain` and synthetic chains
 * that change one certificate-profile rule at a time.
 *
 * The shared ffe-system-test-data v1 fixtures run from the copies in `test/data/response-signing/v1`.
 */
import { createHash, generateKeyPairSync, type KeyObject, sign, webcrypto, X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TextDecoder, TextEncoder } from 'node:util'
import { AsnConvert, OctetString } from '@peculiar/asn1-schema'
import { BasicConstraints, Certificate, ExtendedKeyUsage, Extension, Extensions, Validity } from '@peculiar/asn1-x509'
import { createResponseSigningController } from '../../../src/transport/responseSigning/controller'
import {
  forgetMinimumNotBeforeInMemory,
  storedMinimumNotBefore,
} from '../../../src/transport/responseSigning/minimumNotBefore'
import stagingRoot from '../../../src/transport/responseSigning/staging-root.json'
import { bundledRootsForEndpoint } from '../../../src/transport/responseSigning/trustRoots'
import {
  buildSigningTranscript,
  decodeBase64,
  parseCertificate,
  sha256,
  validateSigningRequest,
  verifyChild,
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

describe('chain fixture table (test-CA-issued credentials)', () => {
  const pinned = { A: ROOT_A, B: ROOT_B }
  const table: Array<[CredentialName, Array<keyof typeof pinned>, boolean, string | undefined]> = [
    ['two-intermediates', ['A'], true, undefined],
    ['backup-root', ['B'], true, undefined],
    ['backup-root', ['A', 'B'], true, undefined],
    ['backup-root', ['A'], false, 'invalid-certificate'],
    ['rotated-lower-intermediate', ['A'], true, undefined],
    ['other-product', ['A'], false, 'invalid-certificate'],
    ['missing-upper-intermediate', ['A'], false, 'invalid-certificate'],
    ['one-intermediate', ['A'], true, undefined],
    ['codesigning-leaf', ['A'], false, 'invalid-certificate'],
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
    if (accept) await expect(result).resolves.toMatchObject({ expiresAt: response.expiresAt, verifiedAt: FIXTURE_NOW })
    else await expect(result).rejects.toThrow(reason)
  })
})

describe('wire format and transcript', () => {
  test('the SDK transcript equals the independent v1 transcript, including the chain tail', async () => {
    const request = signingRequest()
    const credential = loadCredential('two-intermediates')
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
    const credential = loadCredential('two-intermediates')
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
    const response = signedResponse(request, loadCredential('two-intermediates'))
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
    const credential = loadCredential('two-intermediates')
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
    const credential = loadCredential('two-intermediates')
    const response = signedResponse(request, credential)
    const oversized = Buffer.alloc(4097, 1).toString('base64')
    response.headers.set('x-datadog-feature-flags-signing-chain', `${credential.intermediatesBase64[0]},${oversized}`)
    await expect(verifyResponse(request, response, [ROOT_A], FIXTURE_NOW)).rejects.toThrow('invalid-proof')
  })
  test('a response with only the removed signing-intermediate header is rejected', async () => {
    const request = signingRequest()
    const credential = loadCredential('one-intermediate')
    const response = signedResponse(request, credential)
    response.headers.delete('x-datadog-feature-flags-signing-chain')
    response.headers.set('x-datadog-feature-flags-signing-intermediate', credential.intermediatesBase64[0])
    await expect(verifyResponse(request, response, [ROOT_A], FIXTURE_NOW)).rejects.toThrow('missing-proof')
  })
  test.each(['2', '3'])(
    'prototype signature version %s is rejected on the request and the response',
    async (version) => {
      const request = signingRequest()
      const response = signedResponse(request, loadCredential('two-intermediates'))
      response.headers.set('x-datadog-feature-flags-signature-version', version)
      await expect(verifyResponse(request, response, [ROOT_A], FIXTURE_NOW)).rejects.toThrow('invalid-proof')
      const prototypeRequest = signingRequest()
      prototypeRequest.headers.set('x-datadog-feature-flags-signature-version', version)
      expect(() => validateSigningRequest(prototypeRequest)).toThrow('unsupported-request')
    }
  )
  test.each(['v2', 'v3'])('a proof over the %s transcript domain is rejected', async (domain) => {
    const request = signingRequest()
    const credential = loadCredential('two-intermediates')
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
    ['https://ASSIGNMENTS.example.test:443/precompute-assignments?dd_env=e', 'assignments.example.test'],
    ['https://assignments.example.test:8443/precompute-assignments?dd_env=e', 'assignments.example.test:8443'],
    ['https://[::1]:443/precompute-assignments?dd_env=e', '[::1]'],
  ])('the transcript authority of %s is %s', async (url, authority) => {
    const request = signingRequest(url)
    const credential = loadCredential('two-intermediates')
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
    const credential = loadCredential('two-intermediates')
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
  const template = loadCredential('two-intermediates')
  const templates = {
    root: ROOT_A,
    upper: template.intermediatesBase64[1],
    lower: template.intermediatesBase64[0],
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
  /** Root -> intermediate[n-1] -> ... -> intermediate[0] -> leaf. Defaults mirror the chain fixtures. */
  function chain(shape: Shape = {}) {
    const root = forge(templates.root, 'self', shape.root ?? [caBasic(2)])
    const intermediateShapes = shape.intermediates ?? [[caBasic(0)], [caBasic(1)]]
    const intermediates: Node[] = []
    let parent = root
    for (let index = intermediateShapes.length - 1; index >= 0; index--) {
      parent = forge(
        index === 0 ? templates.lower : templates.upper,
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

  test('the synthetic baseline (chain fixture shape) is accepted', () => accepts({}))

  test('leaf EKU with FFE plus other OIDs is accepted', () => accepts({ leaf: [eku(CODE_SIGNING, FFE_EKU)] }))
  test('leaf EKU criticality is not checked', () =>
    accepts({ leaf: [ext('2.5.29.37', true, new ExtendedKeyUsage([FFE_EKU]))] }))
  test('leaf EKU with anyExtendedKeyUsage is rejected', () => rejects({ leaf: [eku(FFE_EKU, ANY_EKU)] }))
  test('leaf EKU of codeSigning only is rejected', () => rejects({ leaf: [eku(CODE_SIGNING)] }))
  test('leaf EKU of another product only is rejected', () => rejects({ leaf: [eku('1.3.6.1.4.1.99999.1.2')] }))
  test('leaf without EKU is rejected', () => rejects({ leaf: [], leafRemove: ['2.5.29.37'] }))
  // X.690 11.2.2: DER omits every trailing zero bit of a named-bit list. This replaces the former
  // single-intermediate key-usage-supplement.json regression with the same two encodings.
  const keyUsage = (hex: string) =>
    new Extension({ extnID: '2.5.29.15', critical: true, extnValue: new OctetString(Buffer.from(hex, 'hex')) })
  test('canonical leaf KeyUsage digitalSignature (03 02 07 80) is accepted', () =>
    accepts({ leaf: [eku(FFE_EKU), keyUsage('03020780')] }))
  test('nonminimal leaf KeyUsage digitalSignature (03 03 00 80 00) is rejected', () =>
    rejects({ leaf: [eku(FFE_EKU), keyUsage('0303008000')] }))
  const basicDer = (hex: string) =>
    new Extension({ extnID: '2.5.29.19', critical: true, extnValue: new OctetString(Buffer.from(hex, 'hex')) })
  test('leaf basicConstraints with an explicit default cA FALSE (30 03 01 01 00) is rejected', () =>
    rejects({ leaf: [eku(FFE_EKU), basicDer('3003010100')] }))
  test('non-critical leaf basicConstraints is rejected', () =>
    rejects({ leaf: [eku(FFE_EKU), ext('2.5.29.19', false, new BasicConstraints({ cA: false }))] }))
  test('nonminimal pinned root KeyUsage (03 03 01 06 00) is rejected', () =>
    rejects({
      root: [
        caBasic(2),
        new Extension({
          extnID: '2.5.29.15',
          critical: true,
          extnValue: new OctetString(Buffer.from('0303010600', 'hex')),
        }),
      ],
    }))

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

/**
 * The server rotates leaves (previous, current, next) and renews intermediates. Each response carries its own
 * leaf and chain, and the client pins only the root. No leaf or intermediate identity is pinned or cached.
 */
describe('rotation under one pinned root', () => {
  const rotation: CredentialName[] = ['two-intermediates', 'rotated-lower-intermediate', 'one-intermediate']
  test('the rotation fixtures use different leaves and different lower intermediates', () => {
    const credentials = rotation.map(loadCredential)
    expect(new Set(credentials.map((c) => c.leafBase64)).size).toBe(rotation.length)
    expect(new Set(credentials.map((c) => c.intermediatesBase64[0])).size).toBe(rotation.length)
  })
  test('verifyResponse accepts each rotated leaf, in any order', async () => {
    for (const name of [...rotation, ...[...rotation].reverse()]) {
      const request = signingRequest()
      const response = signedResponse(request, loadCredential(name))
      await expect(verifyResponse(request, response, [ROOT_A], FIXTURE_NOW)).resolves.toMatchObject({
        expiresAt: response.expiresAt,
        verifiedAt: FIXTURE_NOW,
      })
    }
  })
  test('one controller accepts a new leaf after an earlier leaf, then the earlier leaf again', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(FIXTURE_NOW * 1000)
    try {
      const signing = createResponseSigningController(
        { mode: 'required', trustedRootCertificates: [ROOT_A] },
        { site: 'datad0g.com' }
      )!
      for (const name of ['two-intermediates', 'rotated-lower-intermediate', 'two-intermediates'] as const) {
        const request = signing.prepare(
          'https://preview.ff-cdn.datad0g.com/precompute-assignments?dd_env=staging',
          { 'content-type': 'application/vnd.api+json', 'dd-client-token': 'fixture-token' },
          '{"data":{}}'
        )!
        const signed = signedResponse(request, loadCredential(name))
        const result = await signing.read(
          new Response(Buffer.from(signed.body), { status: 200, headers: signed.headers }),
          request
        )
        expect(result.proof).toMatchObject({ expiresAt: signed.expiresAt, verifiedAt: FIXTURE_NOW })
      }
    } finally {
      jest.restoreAllMocks()
    }
  })
})

describe('bundled trust anchor', () => {
  const STAGING_ROOT_SHA256 = '0e469f3cecc9cd51fd64373879636540512d56e99eecd70361c78b98c47ea934'
  test('the staging root is the verified Datadog Customer Signing Root CA - staging', () => {
    const der = Buffer.from(stagingRoot.certificateDerBase64, 'base64')
    expect(createHash('sha256').update(der).digest('hex')).toBe(STAGING_ROOT_SHA256)
    expect(stagingRoot.sha256).toBe(STAGING_ROOT_SHA256)
    const certificate = new X509Certificate(der)
    expect(certificate.subject).toBe('CN=Datadog Customer Signing Root CA - staging')
    expect(certificate.issuer).toBe(certificate.subject)
    expect(certificate.ca).toBe(true)
    expect(certificate.checkIssued(certificate)).toBe(true)
    expect(certificate.verify(certificate.publicKey)).toBe(true)
  })
  test('the staging endpoint bundles exactly the staging root; other endpoints bundle no root', () => {
    expect(bundledRootsForEndpoint(new URL('https://preview.ff-cdn.datad0g.com/precompute-assignments'))).toEqual([
      stagingRoot.certificateDerBase64,
    ])
    for (const url of [
      'https://preview.ff-cdn.datadoghq.com/precompute-assignments',
      'https://preview.ff-cdn.datadoghq.eu/precompute-assignments',
      'https://proxy.test/assign',
    ])
      expect(bundledRootsForEndpoint(new URL(url))).toEqual([])
  })
  test('the real us1.staging DC intermediate links to the bundled root under the client profile', async () => {
    const pem = readFileSync(
      join(__dirname, '../../data/response-signing/chain/staging-us1-dc-intermediate.pem'),
      'utf8'
    )
    const dcDer = new Uint8Array(Buffer.from(pem.replace(/-----(BEGIN|END) CERTIFICATE-----|\s+/g, ''), 'base64'))
    const root = parseCertificate(decodeBase64(stagingRoot.certificateDerBase64, 4096), 'anchor')
    // The DC intermediate is the upper intermediate (index 1): cluster intermediate (0) <- DC (1) <- root.
    const dc = parseCertificate(dcDer, 'intermediate', 1)
    expect(root.pathLength).toBe(2)
    expect(dc.pathLength).toBe(1)
    await expect(verifyChild(dc, root)).resolves.toBeUndefined()
    // Another anchor does not issue it.
    await expect(verifyChild(dc, parseCertificate(decodeBase64(ROOT_A, 4096), 'anchor'))).rejects.toThrow(
      'invalid-certificate'
    )
  })
  test('test roots are not bundled', () => {
    expect(stagingRoot.certificateDerBase64).not.toBe(ROOT_A)
    expect(stagingRoot.certificateDerBase64).not.toBe(ROOT_B)
  })
  test('a test-CA chain does not verify against the staging root', async () => {
    const request = signingRequest()
    const response = signedResponse(request, loadCredential('two-intermediates'))
    await expect(verifyResponse(request, response, [stagingRoot.certificateDerBase64], FIXTURE_NOW)).rejects.toThrow(
      'invalid-certificate'
    )
  })
})

// Buffer.slice is a view, unlike Uint8Array.slice. Crypto must receive exactly the logical bytes.
test('hashes exactly the supplied view, including a Buffer subclass', async () => {
  const input = Buffer.from('prefix-exact-suffix').subarray(7, 12)
  expect(Buffer.from(await sha256(input)).toString('hex')).toBe(createHash('sha256').update('exact').digest('hex'))
})

test('the independent transcript helper is self-consistent with the response helper', () => {
  const request = signingRequest()
  const credential = loadCredential('one-intermediate')
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

/**
 * Shared ffe-system-test-data response-signing v1 fixtures, copied byte for byte into
 * `test/data/response-signing/v1` (source commit in its README.md). Verifiers run `cases` only; `signing_cases` are for signers.
 * A case `anchor_der_base64` overrides the file anchor. `rejection_reason` is a rule code, not a native
 * error message, so rejected cases assert only the rejection.
 */
describe('shared v1 fixtures', () => {
  interface SharedCase {
    id: string
    now: number
    expected_accept: boolean
    rejection_reason?: string
    anchor_der_base64?: string
    transcript_base64?: string
    request: { url: string; method: string; headers: [string, string][]; body_base64: string }
    response: { status: number; headers: [string, string][]; body_base64: string }
  }
  const fixtureDirectory = join(__dirname, '../../data/response-signing/v1')
  const manifestRaw = readFileSync(join(fixtureDirectory, 'manifest.json'))
  const manifest = JSON.parse(manifestRaw.toString()) as {
    files: Record<string, { sha256: string; response_cases: number; accepted: number }>
  }
  const FILES = [
    'corpus.json',
    'isolated-certificate-rules.json',
    'nested-der.json',
    'subject-der.json',
    'near-expiry.json',
    'extension-profile.json',
  ]
  const chainOf = (headers: Headers) =>
    headers
      .get('x-datadog-feature-flags-signing-chain')!
      .split(',')
      .map((value) => decodeBase64(value, 4096))

  test('the pinned manifest is unchanged and lists every suite', () => {
    // Byte changes to the shared fixtures require a deliberate pin update and review.
    expect(createHash('sha256').update(manifestRaw).digest('hex')).toBe(
      'cd97bbe1893671c57cf02d23ba06cf5c71e8961c3afc069aadb9ad4a18e17fde'
    )
    expect(Object.keys(manifest.files).sort()).toEqual([...FILES].sort())
  })
  for (const filename of FILES) {
    const raw = readFileSync(join(fixtureDirectory, filename))
    const suite = JSON.parse(raw.toString()) as { anchor_der_base64: string; cases: SharedCase[] }
    test(`${filename} matches the manifest hash and counts`, () => {
      expect(createHash('sha256').update(raw).digest('hex')).toBe(manifest.files[filename].sha256)
      expect(suite.cases).toHaveLength(manifest.files[filename].response_cases)
      expect(suite.cases.filter((c) => c.expected_accept)).toHaveLength(manifest.files[filename].accepted)
    })
    test.each(suite.cases)(`${filename}: $id`, async (vector) => {
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
      const anchor = vector.anchor_der_base64 ?? suite.anchor_der_base64
      const result = verifyResponse(request, response, [anchor], vector.now)
      if (!vector.expected_accept) {
        await expect(result).rejects.toThrow()
        return
      }
      const issued = Number(response.headers.get('x-datadog-feature-flags-issued-at'))
      const expires = Number(response.headers.get('x-datadog-feature-flags-expires-at'))
      await expect(result).resolves.toMatchObject({ expiresAt: expires, verifiedAt: vector.now })
      const transcript = await buildSigningTranscript(
        request,
        response,
        issued,
        expires,
        decodeBase64(response.headers.get('x-datadog-feature-flags-signing-certificate')!, 4096),
        chainOf(response.headers)
      )
      expect(Buffer.from(transcript).toString('base64')).toBe(vector.transcript_base64)
      // No expiry grace: the same proof fails at its expiry time.
      await expect(verifyResponse(request, response, [anchor], expires)).rejects.toThrow()
    })
  }
})

describe('minimum not-before revocation (draft wire)', () => {
  const notBefore = (base64: string) => Date.parse(new X509Certificate(Buffer.from(base64, 'base64')).validFrom) / 1000
  const newChain = loadCredential('one-intermediate')
  const oldChain = loadCredential('two-intermediates')
  // The new chain's earliest notBefore (its intermediate). The old chain's intermediates are older than it.
  const FLOOR = Math.min(notBefore(newChain.leafBase64), ...newChain.intermediatesBase64.map(notBefore))
  const anchorKey = createHash('sha256').update(Buffer.from(ROOT_A, 'base64')).digest('hex')
  const url = 'https://preview.ff-cdn.datad0g.com/precompute-assignments?dd_env=staging'
  type Mode = 'observe' | 'required'
  function capture() {
    const events: Array<{ name: string; fields: any }> = []
    const logger = {
      enabled: true,
      event: (name: string, fields?: () => unknown) => events.push({ name, fields: fields?.() }),
      child: () => logger,
    }
    return { events, logger }
  }
  function controller(mode: Mode) {
    return createResponseSigningController({ mode, trustedRootCertificates: [ROOT_A] }, { site: 'datad0g.com' })!
  }
  async function read(
    signing: ReturnType<typeof controller>,
    credential: ReturnType<typeof loadCredential>,
    minimumNotBefore?: number,
    change?: (headers: Headers) => void,
    logger = capture().logger
  ) {
    const request = signing.prepare(url, { 'dd-client-token': 'fixture-token' }, '{"data":{}}')!
    const signed = signedResponse(request, credential, FIXTURE_NOW, undefined, minimumNotBefore)
    change?.(signed.headers)
    return signing.read(
      new Response(Buffer.from(signed.body), { status: 200, headers: signed.headers }),
      request,
      logger
    )
  }
  // This suite runs in the node environment: install a minimal Storage, as a browser page has.
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  let storage: Map<string, string>
  let blocked = false
  const localStorage = {
    getItem: (key: string) => {
      if (blocked) throw new Error('blocked')
      return storage.get(key) ?? null
    },
    setItem: (key: string, value: string) => {
      if (blocked) throw new Error('blocked')
      storage.set(key, value)
    },
  }
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(FIXTURE_NOW * 1000)
    storage = new Map()
    blocked = false
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage })
    forgetMinimumNotBeforeInMemory()
  })
  afterEach(() => {
    jest.restoreAllMocks()
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
    else delete (globalThis as { localStorage?: unknown }).localStorage
  })

  test('the old chain has intermediates older than every certificate of the new chain', () => {
    expect(Math.min(...oldChain.intermediatesBase64.map(notBefore))).toBeLessThan(FLOOR)
    expect(notBefore(newChain.leafBase64)).toBeGreaterThanOrEqual(FLOOR)
  })
  test('required: a signed value is stored, then the old chain is rejected and the new chain still verifies', async () => {
    const signing = controller('required')
    expect((await read(signing, oldChain)).proof).toBeDefined()
    const { events, logger } = capture()
    expect((await read(signing, newChain, FLOOR, undefined, logger)).proof).toMatchObject({ minimumNotBefore: FLOOR })
    expect(events.find((event) => event.name === 'signing.minimum_not_before')?.fields).toMatchObject({
      outcome: 'stored',
      value: FLOOR,
    })
    expect(storedMinimumNotBefore(anchorKey)).toBe(FLOOR)
    expect(localStorage.getItem(`dd-ffe-response-signing-minimum-not-before-v1:${anchorKey}`)).toBe(String(FLOOR))
    await expect(read(signing, oldChain)).rejects.toThrow('Response signing: revoked-certificate')
    expect((await read(signing, newChain)).proof).toBeDefined()
  })
  test('observe: applies the check, reports revoked-certificate, accepts the response, and stores values', async () => {
    const signing = controller('observe')
    expect((await read(signing, newChain, FLOOR)).proof).toBeDefined()
    expect(storedMinimumNotBefore(anchorKey)).toBe(FLOOR)
    const { events, logger } = capture()
    const result = await read(signing, oldChain, undefined, undefined, logger)
    expect(result.proof).toBeUndefined()
    expect(result.json).toBeDefined()
    expect(events.find((event) => event.name === 'signing.failed')?.fields).toMatchObject({
      reason: 'revoked-certificate',
      action: 'continue_unverified',
    })
  })
  test('a value lower than the stored value is ignored', async () => {
    const signing = controller('required')
    await read(signing, newChain, FLOOR)
    const { events, logger } = capture()
    await read(signing, newChain, FLOOR - 1, undefined, logger)
    expect(events.find((event) => event.name === 'signing.minimum_not_before')?.fields.outcome).toBe(
      'not-higher-than-stored'
    )
    expect(storedMinimumNotBefore(anchorKey)).toBe(FLOOR)
  })
  test.each([
    ['greater than the leaf notBefore', notBefore(newChain.leafBase64) + 1],
    // Between the intermediate and the leaf: a leaf-only rule would revoke every later chain.
    ['greater than an intermediate notBefore', FLOOR + 1],
  ])('a value %s is ignored, because a response never revokes its own chain', async (_label, value) => {
    const signing = controller('required')
    const { events, logger } = capture()
    expect((await read(signing, newChain, value, undefined, logger)).proof).toBeDefined()
    expect(events.find((event) => event.name === 'signing.minimum_not_before')?.fields.outcome).toBe(
      'minimum-not-before-ignored'
    )
    expect(storedMinimumNotBefore(anchorKey)).toBe(0)
    expect((await read(signing, oldChain)).proof).toBeDefined()
    expect((await read(signing, newChain)).proof).toBeDefined()
  })
  test.each([
    [
      'changed',
      (headers: Headers) => headers.set('x-datadog-feature-flags-minimum-not-before', String(FLOOR - 1)),
      FLOOR,
      'invalid-signature',
    ],
    [
      'removed',
      (headers: Headers) => headers.delete('x-datadog-feature-flags-minimum-not-before'),
      FLOOR,
      'invalid-signature',
    ],
    [
      'added',
      (headers: Headers) => headers.set('x-datadog-feature-flags-minimum-not-before', String(FLOOR)),
      undefined,
      'invalid-signature',
    ],
    [
      'duplicated',
      (headers: Headers) => headers.append('x-datadog-feature-flags-minimum-not-before', String(FLOOR - 1)),
      FLOOR,
      'invalid-proof',
    ],
    [
      'leading zero',
      (headers: Headers) => headers.set('x-datadog-feature-flags-minimum-not-before', `0${FLOOR}`),
      FLOOR,
      'invalid-proof',
    ],
    [
      'above 2^53-1',
      (headers: Headers) => headers.set('x-datadog-feature-flags-minimum-not-before', '9007199254740992'),
      FLOOR,
      'invalid-proof',
    ],
  ] as const)('a %s header fails verification and stores nothing', async (_label, change, signedValue, reason) => {
    const signing = controller('required')
    await expect(read(signing, newChain, signedValue, change)).rejects.toThrow(`Response signing: ${reason}`)
    expect(storedMinimumNotBefore(anchorKey)).toBe(0)
  })
  test('the stored value survives a restart', async () => {
    await read(controller('required'), newChain, FLOOR)
    forgetMinimumNotBeforeInMemory()
    await expect(read(controller('required'), oldChain)).rejects.toThrow('Response signing: revoked-certificate')
  })
  test('without localStorage the value is kept in memory for the page only', async () => {
    blocked = true
    const signing = controller('required')
    await read(signing, newChain, FLOOR)
    await expect(read(signing, oldChain)).rejects.toThrow('Response signing: revoked-certificate')
    forgetMinimumNotBeforeInMemory()
    expect((await read(controller('required'), oldChain)).proof).toBeDefined()
  })
  test('values are kept per trust anchor', async () => {
    await read(controller('required'), newChain, FLOOR)
    const other = createHash('sha256').update(Buffer.from(ROOT_B, 'base64')).digest('hex')
    expect(storedMinimumNotBefore(other)).toBe(0)
    const backup = createResponseSigningController(
      { mode: 'required', trustedRootCertificates: [ROOT_B] },
      { site: 'datad0g.com' }
    )!
    expect((await read(backup, loadCredential('backup-root'))).proof).toBeDefined()
  })
})
