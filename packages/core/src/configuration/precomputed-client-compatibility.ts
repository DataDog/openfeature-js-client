/** Response formats a target client can read. Plaintext is always supported. */
export type PrecomputedClientCompatibility = {
  readonly capabilities: readonly string[]
}
