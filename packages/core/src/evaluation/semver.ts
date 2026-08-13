const MAX_UINT64 = '18446744073709551615'

/**
 * The language-neutral SemVer representation used by the FFE evaluator.
 * Build metadata is validated while parsing but is intentionally not retained,
 * because it does not affect SemVer precedence.
 */
export interface ParsedSemver {
  major: string
  minor: string
  patch: string
  prerelease: string
}

/**
 * Parse the SemVer subset.
 * Core identifiers are limited to uint64; numeric prerelease identifiers may
 * be arbitrarily large.
 */
export function parseSemver(version: unknown): ParsedSemver | null {
  if (typeof version !== 'string') {
    return null
  }

  const major = parseCoreIdentifier(version, 0)
  if (!major || major.next >= version.length || version[major.next] !== '.') {
    return null
  }

  const minor = parseCoreIdentifier(version, major.next + 1)
  if (!minor || minor.next >= version.length || version[minor.next] !== '.') {
    return null
  }

  const patch = parseCoreIdentifier(version, minor.next + 1)
  if (!patch) {
    return null
  }

  const parsed: ParsedSemver = {
    major: major.value,
    minor: minor.value,
    patch: patch.value,
    prerelease: '',
  }

  if (patch.next === version.length) {
    return parsed
  }

  let remainder = version.slice(patch.next)
  if (remainder.startsWith('-')) {
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
  } else if (remainder.startsWith('+')) {
    remainder = remainder.slice(1)
  } else {
    return null
  }

  return isValidSemverIdentifiers(remainder, true) ? parsed : null
}

/** Compare SemVer precedence. Build metadata is intentionally ignored. */
export function compareSemver(left: ParsedSemver, right: ParsedSemver): number {
  for (const [leftValue, rightValue] of [
    [left.major, right.major],
    [left.minor, right.minor],
    [left.patch, right.patch],
  ]) {
    const ordering = compareNumericStrings(leftValue, rightValue)
    if (ordering !== 0) {
      return ordering
    }
  }

  return compareSemverPrerelease(left.prerelease, right.prerelease)
}

function parseCoreIdentifier(version: string, start: number): { value: string; next: number } | null {
  if (start >= version.length || !isAsciiDigit(version.charCodeAt(start))) {
    return null
  }

  if (version[start] === '0') {
    return { value: '0', next: start + 1 }
  }

  let end = start
  while (end < version.length && isAsciiDigit(version.charCodeAt(end))) {
    end++
  }

  const value = version.slice(start, end)
  if (value.length > MAX_UINT64.length || (value.length === MAX_UINT64.length && value > MAX_UINT64)) {
    return null
  }
  return { value, next: end }
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
