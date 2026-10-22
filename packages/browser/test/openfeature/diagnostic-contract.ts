import Ajv from 'ajv'
import schema from '../data/sdkdiagnostic-v1.json'

// Exact copy of the canonical flageval-worker schemas/sdkdiagnostic.json, blob fc4edae7e0acc310d1d0911455be96c8849ab4e5.
// Keep this fixture synchronized when the wire contract changes.
const validate = new Ajv({ strict: false, allErrors: true }).compile(schema)

export function diagnosticRecords(data: string) {
  const lines = data.split('\n')
  expect(lines.length).toBeLessThanOrEqual(32)
  return lines.map((line) => {
    const record = JSON.parse(line)
    expect(validate(record) ? [] : validate.errors).toEqual([])
    expect(new Blob([line]).size).toBeLessThanOrEqual(2048)
    const p = record.payload
    expect(Number(Boolean(p.application_id)) + Number(Boolean(p.service_id))).toBe(1)
    expect(p.timestamp).toBeLessThanOrEqual(Date.now() + 300_000)
    expect(p.timestamp).toBeGreaterThanOrEqual(Date.now() - 86_400_000)
    const report = p.initialization
    if (report) {
      expect(report.started_at).toBeLessThanOrEqual(p.timestamp)
      const config = report.milestones.configuration_received
      const ready = report.milestones.provider_ready
      if (config) expect(config.elapsed_ms).toBeLessThanOrEqual(report.duration_ms)
      if (ready) {
        expect(ready.elapsed_ms).toBeGreaterThanOrEqual(config.elapsed_ms)
        expect(ready.elapsed_ms).toBeLessThanOrEqual(report.duration_ms)
      }
    }
    return record
  })
}
