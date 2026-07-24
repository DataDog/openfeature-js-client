import { getMD5Hash } from '../obfuscation'

export abstract class Sharder {
  abstract getShard(input: string, totalShards: number): number
}

export class MD5Sharder extends Sharder {
  getShard(input: string, totalShards: number): number {
    const hashOutput = getMD5Hash(input)
    const intFromHash = parseInt(hashOutput.slice(0, 8), 16)
    return intFromHash % totalShards
  }
}

export class DeterministicSharder extends Sharder {
  /*
  Deterministic sharding based on a look-up table
  to simplify writing tests
  */
  private lookup: Record<string, number>

  constructor(lookup: Record<string, number>) {
    super()
    this.lookup = lookup
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getShard(input: string, _totalShards: number): number {
    return this.lookup[input] ?? 0
  }
}
