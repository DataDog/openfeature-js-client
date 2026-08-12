interface PrereleaseIdentifier {
  readonly numeric: boolean
  readonly value: string
}

export interface SemanticVersion {
  readonly core: readonly [number, number, number]
  readonly prerelease: readonly PrereleaseIdentifier[]
}

const identifier = String.raw`(?:0|[1-9]\d*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`
const maxSemanticVersionLength = 256
const semanticVersionPattern = new RegExp(
  String.raw`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(${identifier}(?:\.${identifier})*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`
)

export function parseSemanticVersion(value: unknown): SemanticVersion | undefined {
  if (typeof value !== 'string' || value.length > maxSemanticVersionLength) {
    return undefined
  }

  const match = semanticVersionPattern.exec(value)
  if (!match) {
    return undefined
  }

  const core = [Number(match[1]), Number(match[2]), Number(match[3])] as const
  if (!core.every(Number.isSafeInteger)) {
    return undefined
  }

  return {
    core,
    prerelease: match[4]
      ? match[4].split('.').map((part) => ({
          numeric: /^\d+$/.test(part),
          value: part,
        }))
      : [],
  }
}

export function compareSemanticVersions(left: SemanticVersion, right: SemanticVersion): number {
  for (let index = 0; index < left.core.length; index++) {
    const difference = left.core[index] - right.core[index]
    if (difference !== 0) {
      return Math.sign(difference)
    }
  }

  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length === 0 ? 1 : -1
  }

  const identifierCount = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < identifierCount; index++) {
    const leftIdentifier = left.prerelease[index]
    const rightIdentifier = right.prerelease[index]
    if (!leftIdentifier || !rightIdentifier) {
      return leftIdentifier ? 1 : -1
    }
    if (leftIdentifier.value === rightIdentifier.value) {
      continue
    }
    if (leftIdentifier.numeric !== rightIdentifier.numeric) {
      return leftIdentifier.numeric ? -1 : 1
    }
    if (leftIdentifier.numeric) {
      if (leftIdentifier.value.length !== rightIdentifier.value.length) {
        return leftIdentifier.value.length < rightIdentifier.value.length ? -1 : 1
      }
    }
    return leftIdentifier.value < rightIdentifier.value ? -1 : 1
  }

  return 0
}
