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
      },
    },
  },
})
