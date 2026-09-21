import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    target: 'es2015',
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        protobuf: fileURLToPath(new URL('./protobuf.html', import.meta.url)),
        precomputed: fileURLToPath(new URL('./precomputed.html', import.meta.url)),
        trackingBaseline: fileURLToPath(new URL('./tracking-baseline.html', import.meta.url)),
        trackingExposure: fileURLToPath(new URL('./tracking-exposure.html', import.meta.url)),
        trackingEvaluation: fileURLToPath(new URL('./tracking-evaluation.html', import.meta.url)),
        trackingRum: fileURLToPath(new URL('./tracking-rum.html', import.meta.url)),
        trackingAll: fileURLToPath(new URL('./tracking-all.html', import.meta.url)),
      },
    },
  },
})
