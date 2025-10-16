import { OpenFeature } from '@openfeature/web-sdk'
import { DatadogProvider } from '@datadog/openfeature-browser'

// Initialize the Datadog provider
const provider = new DatadogProvider({
  applicationId: 'test-app-id',
  clientToken: 'test-token',
  site: 'datadoghq.com',
  service: 'test-service',
})

// Set the provider
OpenFeature.setProvider(provider)

// Get a client
const client = OpenFeature.getClient()

// Evaluate a flag
const value = client.getBooleanValue('test-flag', false)

console.log('✓ Successfully imported and initialized @datadog/openfeature-browser')
console.log(`Flag value: ${value}`)

// Update the DOM to show success
document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div>
    <h1>Test App</h1>
    <p>✓ Successfully imported and initialized @datadog/openfeature-browser</p>
    <p>Flag value: ${value}</p>
  </div>
`
