import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    target: 'es2015',
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        provider: fileURLToPath(new URL('./provider.html', import.meta.url)),
        coreProvider: fileURLToPath(new URL('./core-provider.html', import.meta.url)),
        protobuf: fileURLToPath(new URL('./protobuf.html', import.meta.url)),
        precomputed: fileURLToPath(new URL('./precomputed.html', import.meta.url)),
        privacy: fileURLToPath(new URL('./privacy.html', import.meta.url)),
        consent: fileURLToPath(new URL('./consent.html', import.meta.url)),
        obfuscation: fileURLToPath(new URL('./obfuscation.html', import.meta.url)),
        evaluationTelemetry: fileURLToPath(new URL('./evaluation-telemetry.html', import.meta.url)),
        experimentationOptOut: fileURLToPath(new URL('./experimentation-opt-out.html', import.meta.url)),
        trackingBaseline: fileURLToPath(new URL('./tracking-baseline.html', import.meta.url)),
        trackingExposure: fileURLToPath(new URL('./tracking-exposure.html', import.meta.url)),
        trackingEvaluation: fileURLToPath(new URL('./tracking-evaluation.html', import.meta.url)),
        trackingRum: fileURLToPath(new URL('./tracking-rum.html', import.meta.url)),
        trackingAll: fileURLToPath(new URL('./tracking-all.html', import.meta.url)),
      },
    },
  },
})
