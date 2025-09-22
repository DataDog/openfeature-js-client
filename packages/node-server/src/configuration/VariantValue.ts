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

  validateBoolean(): boolean {
    if (this.variantType === 'BOOLEAN') {
      if (typeof this.value === 'string') {
        return this.value === 'true' || this.value === 'false'
      }
      if (typeof this.value === 'boolean') {
        return true
      }
      return false
    }
    return false
  }

  validateString(): boolean {
    if (this.variantType === 'STRING') {
      return typeof this.value === 'string'
    }
    return false
  }

  validateNumber(): boolean {
    if (this.variantType === 'INTEGER') {
      return Number.isInteger(Number(this.value))
    }
    if (this.variantType === 'NUMERIC') {
      return !isNaN(Number(this.value))
    }
    return false
  }

  validateObject(): boolean {
    if (this.variantType === 'JSON') {
      if (typeof this.value === 'string') {
        try {
          return JSON.parse(this.value) !== undefined
        } catch {
          return false
        }
      }
      if (typeof this.value === 'object') {
        return true
      }
    }
    return false
  }
}
