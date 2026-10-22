import Ajv from 'ajv'
import schema from '../data/sdkdiagnostic-v1.json'

// Exact copy of dd-source PR #98932's canonical schema, blob 4684d81842d6a824a1c957916cb94d9ca8de9fc1.
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
      if (report.reason === 'deadline') expect(report.duration_ms).toBeGreaterThanOrEqual(30_000)
    }
    return record
  })
}
