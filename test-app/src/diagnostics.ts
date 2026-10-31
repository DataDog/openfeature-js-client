import { DatadogProvider } from '@datadog/openfeature-browser'
import { OpenFeature } from '@openfeature/web-sdk'

function input(id: string): HTMLInputElement {
  const element = document.getElementById(id)
  if (!(element instanceof HTMLInputElement)) throw new Error(`Missing input: ${id}`)
  return element
}

function show(message: string) {
  const element = document.getElementById('status')
  if (element) element.textContent = message
}

const form = document.getElementById('setup')
const scenario = document.getElementById('scenario')
const start = document.getElementById('start')
if (
  !(form instanceof HTMLFormElement) ||
  !(scenario instanceof HTMLSelectElement) ||
  !(start instanceof HTMLButtonElement)
) {
  throw new Error('Missing diagnostic harness controls')
}

let provider: DatadogProvider | undefined
const nativeFetch = globalThis.fetch.bind(globalThis)
form.addEventListener('submit', (event) => {
  event.preventDefault()
  void initialize()
})

async function initialize() {
  if (!(start instanceof HTMLButtonElement) || !(scenario instanceof HTMLSelectElement)) return
  start.disabled = true
  const mode = scenario.value
  show('Initializing; inspect the console and network panel. Intake acceptance is not proof of storage.')
  try {
    await provider?.onClose()
    provider = new DatadogProvider({
      clientToken: input('token').value,
      applicationId: input('application').value || undefined,
      env: input('environment').value,
      site: 'datad0g.com',
      debugMode: input('debug').checked,
      enableFlagEvaluationTracking: input('evaluations').checked,
      enableExposureLogging: false,
      enableRumFeatureFlagTracking: false,
      flagConfigurationFetch: async (url, options) => {
        if (mode === 'failure') throw new TypeError('Deliberate configuration-only failure')
        if (mode === 'slow') await new Promise((resolve) => setTimeout(resolve, 35_000))
        return nativeFetch(url, options)
      },
    })
    await OpenFeature.setProviderAndWait(provider)
    show(`Initialization completed. Provider status: ${provider.status}. Check remote evidence separately.`)
  } catch {
    show('Initialization failed. Inspect local console/network diagnostics; remote evidence may be unavailable.')
  } finally {
    start.disabled = false
  }
}

document.getElementById('evaluate')?.addEventListener('click', () => {
  const details = OpenFeature.getClient().getBooleanDetails(input('flag').value, false)
  console.log('getBooleanDetails:', JSON.stringify(details))
  show(JSON.stringify(details, null, 2))
})

document.getElementById('close')?.addEventListener('click', () => {
  void OpenFeature.close().then(() => show('Provider closed; queued diagnostic delivery is best effort.'))
})
