// Synthetic SDK wire for parser tests. Application examples use the browser getter instead.
export function fingerprint(capabilities: readonly string[] = [], fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    sdk: { name: 'browser', version: '2.3.0' },
    capabilities,
    ...fields,
  })
}
