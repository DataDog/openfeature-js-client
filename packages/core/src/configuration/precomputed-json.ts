import { isLosslessNumber, LosslessNumber, parse, stringify } from 'lossless-json'
import type { PrecomputedConfigurationResponse } from './configuration'

const NUMERIC_TYPES = new Set(['NUMBER', 'NUMERIC', 'INTEGER', 'number', 'integer', 'float'])

/** @internal Preserve unrepresentable numeric assignments until typed evaluation. */
export function parsePrecomputedConfigurationJson(text: string): unknown {
  let hasUnrepresentableNumber = false
  const value = parse(text, undefined, {
    parseNumber: (source) => {
      if (isRepresentableNumber(source)) return Number(source)
      hasUnrepresentableNumber = true
      return new LosslessNumber(source)
    },
    // Match JSON.parse's last-key-wins behavior.
    onDuplicateKey: ({ newValue }) => newValue,
  })
  if (!hasUnrepresentableNumber) return value
  const retained = new Set<LosslessNumber>()
  if (isRecord(value) && isRecord(value.data) && isRecord(value.data.attributes)) {
    const flags = value.data.attributes.flags
    if (isRecord(flags)) {
      for (const flag of Object.values(flags)) {
        if (
          isRecord(flag) &&
          NUMERIC_TYPES.has(flag.variationType as string) &&
          isLosslessNumber(flag.variationValue)
        ) {
          retained.add(flag.variationValue)
        }
      }
    }
  }

  // Only numeric assignments have the strict conversion contract. Other JSON
  // values retain the ordinary JSON.parse conversion behavior.
  function normalize(item: unknown): unknown {
    if (isLosslessNumber(item)) return retained.has(item) ? item : Number(item.value)
    if (item !== null && typeof item === 'object') {
      for (const key of Object.keys(item)) {
        const record = item as Record<string, unknown>
        Object.defineProperty(item, key, {
          ...Object.getOwnPropertyDescriptor(item, key),
          value: normalize(record[key]),
        })
      }
    }
    return item
  }
  return normalize(value)
}

export function stringifyPrecomputedConfigurationJson(
  response: PrecomputedConfigurationResponse,
  numericErrors?: Record<string, string>
): string {
  if (!numericErrors) return JSON.stringify(response)
  const attributes = response.data.attributes
  const flags = Object.fromEntries(
    Object.entries(attributes.flags).map(([key, flag]) => {
      const source = Object.getOwnPropertyDescriptor(numericErrors, key)?.value
      return [key, source === undefined ? flag : { ...flag, variationValue: new LosslessNumber(source) }]
    })
  )
  return stringify({ ...response, data: { ...response.data, attributes: { ...attributes, flags } } })!
}

export function isUnrepresentablePrecomputedNumber(value: unknown): boolean {
  return isLosslessNumber(value)
}

export function precomputedNumberSource(value: unknown): string | undefined {
  return isLosslessNumber(value) ? value.value : undefined
}

function isRepresentableNumber(source: string): boolean {
  const value = Number(source)
  if (!Number.isFinite(value)) return false
  if (value !== 0 && (Number.isSafeInteger(value) || !Number.isInteger(value))) return true
  const [mantissa, exponent = '0'] = source.toLowerCase().split('e')
  const [whole, fraction = ''] = mantissa.split('.')
  const digits = (whole.replace('-', '') + fraction).replace(/^0+/, '')
  if (!digits) return true
  if (value === 0) return false
  let end = digits.length
  while (digits[end - 1] === '0') end--
  const significant = digits.slice(0, end)
  const scale = Number(exponent) - fraction.length + digits.length - significant.length
  // Non-integral JSON values may round to a finite double, even to an integer.
  if (scale < 0) return true
  // A finite double's integral decimal expansion has at most 309 digits.
  if (significant.length + scale > 309) return false
  const exact = `${value < 0 ? '-' : ''}${significant}${'0'.repeat(scale)}`
  return integerToDecimal(value) === exact
}

function integerToDecimal(value: number): string {
  if (Math.abs(value) < 1e21) return value.toFixed(0)
  // Number#toString(10) can shorten an integer's exact decimal expansion.
  // Convert its exact binary digits in bounded base-10 chunks instead. This
  // also works on older Hermes runtimes without BigInt (at most 1024 bits).
  const chunks = [0]
  for (const bit of Math.abs(value).toString(2)) {
    let carry = Number(bit)
    for (let index = 0; index < chunks.length; index++) {
      const next = chunks[index] * 2 + carry
      chunks[index] = next % 10000000
      carry = Math.floor(next / 10000000)
    }
    if (carry) chunks.push(carry)
  }
  const mostSignificant = chunks.pop()!
  return `${value < 0 ? '-' : ''}${mostSignificant}${chunks
    .reverse()
    .map((chunk) => String(chunk).padStart(7, '0'))
    .join('')}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
