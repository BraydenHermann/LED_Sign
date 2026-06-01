import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/scan': 'http://127.0.0.1:8001',
      '/connect': 'http://127.0.0.1:8001',
      '/status': 'http://127.0.0.1:8001',
      '/power': 'http://127.0.0.1:8001',
      '/brightness': 'http://127.0.0.1:8001',
      '/speed': 'http://127.0.0.1:8001',
      '/clear': 'http://127.0.0.1:8001',
      '/calendar': 'http://127.0.0.1:8001',
      '/auth': 'http://127.0.0.1:8001',
      '/process-gif': 'http://127.0.0.1:8001',
      '/save-preset': 'http://127.0.0.1:8001',
      '/preset': 'http://127.0.0.1:8001',
      '/delete-preset': 'http://127.0.0.1:8001',
      '/push-text': 'http://127.0.0.1:8001',
      '/clock': 'http://127.0.0.1:8001',
      '/static': 'http://127.0.0.1:8001',
      '/disconnect': 'http://127.0.0.1:8001'
    }
  }
})
