import Ajv from 'ajv'
import schema from '../data/sdkdiagnostic-v1.json'

// Schema copied from the canonical flageval-worker schemas/sdkdiagnostic.json, blob 81342916fc0dbab6cdb60047fb52de46a0f5d4f2.
// Keep this fixture synchronized when the wire contract changes.
const validate = new Ajv({ strict: false, allErrors: true }).compile(schema)

export function diagnosticRecords(data: string) {
  const lines = data.split('\n')
  return lines.map((line) => {
    const record = JSON.parse(line)
    expect(validate(record) ? [] : validate.errors).toEqual([])
    const p = record.payload
    expect(Number(Boolean(p.application_id)) + Number(Boolean(p.service_id))).toBe(1)
    expect(p.timestamp).toBeLessThanOrEqual(Date.now() + 300_000)
    expect(p.timestamp).toBeGreaterThanOrEqual(Date.now() - 86_400_000)
    const report = p.initialization
    if (report) {
      expect(report.started_at_ms).toBeLessThanOrEqual(p.timestamp)
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
