import { DatadogProvider } from '@datadog/openfeature-browser'
import { OpenFeature } from '@openfeature/web-sdk'

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

// Evaluate a flag using getBooleanDetails to get full evaluation details
const details = client.getBooleanDetails('test-flag', false)

console.log('✓ Successfully imported and initialized @datadog/openfeature-browser')
console.log('Flag evaluation details:', details)

// Format the details for display
const detailsJson = JSON.stringify(details, null, 2)

// Update the DOM to show success
document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div>
    <h1>DataDog OpenFeature Browser Test App</h1>
    <p class="success">✓ Successfully imported and initialized @datadog/openfeature-browser</p>

    <div class="details">
      <h2>Flag Evaluation Details</h2>
      <p><strong>Flag Key:</strong> ${details.flagKey}</p>
      <p><strong>Value:</strong> ${details.value}</p>
      <p><strong>Reason:</strong> ${details.reason}</p>
      <p><strong>Variant:</strong> ${details.variant || 'N/A'}</p>
      <p><strong>Error Code:</strong> ${details.errorCode || 'N/A'}</p>

      <h3>Full Details (JSON):</h3>
      <pre>${detailsJson}</pre>
    </div>
  </div>
`
