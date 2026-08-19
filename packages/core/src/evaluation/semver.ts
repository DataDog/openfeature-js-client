const MAX_UINT64 = '18446744073709551615'

/**
 * The minimum number of dot-separated numeric core identifiers accepted by
 * the extended SemVer parser. There is no upper bound: one- and two-part
 * versions normalize to three parts, and any additional parts are accepted
 * as further numeric identifiers.
 */
const MIN_CORE_PARTS = 1

/**
 * The language-neutral SemVer representation used by the FFE evaluator.
 * Build metadata is validated while parsing but is intentionally not retained,
 * because it does not affect SemVer precedence.
 */
export interface ParsedSemver {
  parts: string[]
  prerelease: string
}

/**
 * Parse the SemVer subset.
 *
 * Core identifiers are limited to uint64; numeric prerelease identifiers may
 * be arbitrarily large. One- and two-part core versions are accepted and
 * normalized with missing parts treated as zero; any number of additional
 * core parts is accepted as further numeric identifiers.
 */
export function parseSemver(version: unknown): ParsedSemver | null {
  if (typeof version !== 'string' || version.length === 0) {
    return null
  }

  // Split the numeric core from the prerelease/build metadata at the first
  // '-' or '+' delimiter, which cannot appear inside the core.
  let coreEnd = version.length
  for (let i = 0; i < version.length; i++) {
    const code = version.charCodeAt(i)
    if (code === 45 /* - */ || code === 43 /* + */) {
      coreEnd = i
      break
    }
  }

  const parts = parseCoreParts(version.slice(0, coreEnd))
  if (parts === null) {
    return null
  }

  const parsed: ParsedSemver = { parts, prerelease: '' }

  let remainder = version.slice(coreEnd)
  if (remainder === '') {
    return parsed
  }

  if (remainder[0] === '-') {
    remainder = remainder.slice(1)
    const buildStart = remainder.indexOf('+')
    if (buildStart === -1) {
      return isValidSemverIdentifiers(remainder, false) ? { ...parsed, prerelease: remainder } : null
    }

    const prerelease = remainder.slice(0, buildStart)
    if (!isValidSemverIdentifiers(prerelease, false)) {
      return null
    }
    parsed.prerelease = prerelease
    remainder = remainder.slice(buildStart + 1)
  } else if (remainder[0] === '+') {
    remainder = remainder.slice(1)
  } else {
    return null
  }

  return isValidSemverIdentifiers(remainder, true) ? parsed : null
}

/** Compare SemVer precedence. Build metadata is intentionally ignored. */
export function compareSemver(left: ParsedSemver, right: ParsedSemver): number {
  const maxLength = Math.max(left.parts.length, right.parts.length)
  for (let i = 0; i < maxLength; i++) {
    const leftValue = i < left.parts.length ? left.parts[i] : '0'
    const rightValue = i < right.parts.length ? right.parts[i] : '0'
    const ordering = compareNumericStrings(leftValue, rightValue)
    if (ordering !== 0) {
      return ordering
    }
  }

  return compareSemverPrerelease(left.prerelease, right.prerelease)
}

function parseCoreParts(core: string): string[] | null {
  if (core.length === 0) {
    return null
  }

  const parts = core.split('.')
  if (parts.length < MIN_CORE_PARTS) {
    return null
  }

  const parsed: string[] = []
  for (const part of parts) {
    const identifier = parseCoreIdentifier(part)
    if (identifier === null) {
      return null
    }
    parsed.push(identifier)
  }
  return parsed
}

function parseCoreIdentifier(part: string): string | null {
  if (part.length === 0 || !isAsciiDigit(part.charCodeAt(0))) {
    return null
  }

  if (part[0] === '0') {
    return part.length === 1 ? '0' : null
  }

  for (let i = 1; i < part.length; i++) {
    if (!isAsciiDigit(part.charCodeAt(i))) {
      return null
    }
  }

  if (part.length > MAX_UINT64.length || (part.length === MAX_UINT64.length && part > MAX_UINT64)) {
    return null
  }
  return part
}

function isValidSemverIdentifiers(value: string, allowLeadingZeros: boolean): boolean {
  let identifierStart = 0
  let identifierNumeric = true

  for (let i = 0; i <= value.length; i++) {
    if (i === value.length || value[i] === '.') {
      if (i === identifierStart) {
        return false
      }
      if (!allowLeadingZeros && identifierNumeric && i - identifierStart > 1 && value[identifierStart] === '0') {
        return false
      }
      identifierStart = i + 1
      identifierNumeric = true
      continue
    }

    const code = value.charCodeAt(i)
    if (!isAsciiAlphanumeric(code) && value[i] !== '-') {
      return false
    }
    if (!isAsciiDigit(code)) {
      identifierNumeric = false
    }
  }

  return true
}

function compareSemverPrerelease(left: string, right: string): number {
  if (left === right) {
    return 0
  }
  if (left === '') {
    return 1
  }
  if (right === '') {
    return -1
  }

  let leftRemaining = left
  let rightRemaining = right
  while (true) {
    const [leftIdentifier, nextLeft] = nextSemverIdentifier(leftRemaining)
    const [rightIdentifier, nextRight] = nextSemverIdentifier(rightRemaining)
    const ordering = compareSemverIdentifier(leftIdentifier, rightIdentifier)
    if (ordering !== 0) {
      return ordering
    }

    if (nextLeft === '' || nextRight === '') {
      if (nextLeft === '' && nextRight === '') {
        return 0
      }
      return nextLeft === '' ? -1 : 1
    }

    leftRemaining = nextLeft.slice(1)
    rightRemaining = nextRight.slice(1)
  }
}

function nextSemverIdentifier(value: string): [string, string] {
  const dot = value.indexOf('.')
  return dot === -1 ? [value, ''] : [value.slice(0, dot), value.slice(dot)]
}

function compareSemverIdentifier(left: string, right: string): number {
  const leftNumeric = isSemverNumericIdentifier(left)
  const rightNumeric = isSemverNumericIdentifier(right)

  if (leftNumeric && rightNumeric) {
    return compareNumericStrings(left, right)
  }
  if (leftNumeric) {
    return -1
  }
  if (rightNumeric) {
    return 1
  }
  return compareAsciiStrings(left, right)
}

function isSemverNumericIdentifier(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (!isAsciiDigit(value.charCodeAt(i))) {
      return false
    }
  }
  return true
}

function compareNumericStrings(left: string, right: string): number {
  if (left.length !== right.length) {
    return left.length < right.length ? -1 : 1
  }
  return compareAsciiStrings(left, right)
}

function compareAsciiStrings(left: string, right: string): number {
  const length = Math.min(left.length, right.length)
  for (let i = 0; i < length; i++) {
    const leftCode = left.charCodeAt(i)
    const rightCode = right.charCodeAt(i)
    if (leftCode !== rightCode) {
      return leftCode < rightCode ? -1 : 1
    }
  }
  if (left.length === right.length) {
    return 0
  }
  return left.length < right.length ? -1 : 1
}

function isAsciiDigit(code: number): boolean {
  return code >= 48 && code <= 57
}

function isAsciiAlphanumeric(code: number): boolean {
  return isAsciiDigit(code) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}
