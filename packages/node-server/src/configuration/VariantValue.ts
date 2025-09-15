import { VariantType } from './ufc-v1'

export class VariantValue {
  private readonly variantType: VariantType

  constructor(
    readonly value: boolean | string | number | object,
    variantType: string
  ) {
    if (variantType === 'BOOLEAN') {
      this.variantType = 'BOOLEAN'
    } else if (variantType === 'STRING') {
      this.variantType = 'STRING'
    } else if (variantType === 'INTEGER') {
      this.variantType = 'INTEGER'
    } else if (variantType === 'NUMERIC') {
      this.variantType = 'NUMERIC'
    } else if (variantType === 'JSON') {
      this.variantType = 'JSON'
    } else {
      throw new Error(`Invalid variant type: ${variantType}`)
    }
  }

  parseBoolean(): { value: boolean | null; isValid: boolean } {
    if (this.variantType === 'BOOLEAN') {
      if (typeof this.value === 'string') {
        const isValid = this.value === 'true' || this.value === 'false'
        return { value: isValid ? this.value === 'true' : null, isValid }
      }
      if (typeof this.value === 'boolean') {
        return { value: this.value, isValid: true }
      }
      return { value: null, isValid: false }
    }
    return { value: null, isValid: false }
  }

  parseString(): { value: string | null; isValid: boolean } {
    if (this.variantType === 'STRING') {
      const isValid = typeof this.value === 'string'
      return { value: isValid ? (this.value as string) : null, isValid }
    }
    return { value: null, isValid: false }
  }

  parseNumber(): { value: number | null; isValid: boolean } {
    if (this.variantType === 'INTEGER') {
      return { value: Number(this.value), isValid: Number.isInteger(Number(this.value)) }
    }
    if (this.variantType === 'NUMERIC') {
      return { value: Number(this.value), isValid: !isNaN(Number(this.value)) }
    }
    return { value: null, isValid: false }
  }

  parseObject(): { value: object | null; isValid: boolean } {
    if (this.variantType === 'JSON') {
      if (typeof this.value === 'string') {
        try {
          const isValid = this.value.startsWith('{')
          return { value: isValid ? JSON.parse(this.value) : null, isValid }
        } catch {
          return { value: null, isValid: false }
        }
      }
      if (typeof this.value === 'object') {
        return { value: this.value, isValid: true }
      }
    }
    return { value: null, isValid: false }
  }
}
