import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    
    
    proxy: {
      '/scan': 'http://127.0.0.1:8000',
      '/connect': 'http://127.0.0.1:8000',
      '/status': 'http://127.0.0.1:8000',
      '/power': 'http://127.0.0.1:8000',
      '/brightness': 'http://127.0.0.1:8000',
      '/speed': 'http://127.0.0.1:8000',
      '/clear': 'http://127.0.0.1:8000',
      '/calendar': 'http://127.0.0.1:8000',
      '/auth': 'http://127.0.0.1:8000',
      '/process-gif': {
        target: 'http://127.0.0.1:8000',
        proxyTimeout: 300000,
        timeout: 300000
      },
      '/process-video': {
        target: 'http://127.0.0.1:8000',
        proxyTimeout: 300000,
        timeout: 300000
      },
      '/ui-heartbeat': 'http://127.0.0.1:8000',
      '/save-preset': {
        target: 'http://127.0.0.1:8000',
        proxyTimeout: 300000,
        timeout: 300000
      },
      '/save-progress': 'http://127.0.0.1:8000',
      '/preset': 'http://127.0.0.1:8000',
      '/delete-preset': 'http://127.0.0.1:8000',
      '/push-text': 'http://127.0.0.1:8000',
      '/render-text-preview': 'http://127.0.0.1:8000',
      '/clock': 'http://127.0.0.1:8000',
      '/static': 'http://127.0.0.1:8000',
      '/disconnect': 'http://127.0.0.1:8000',
      '/hardware-slots': 'http://127.0.0.1:8000',
      '/api': {
        target: 'http://127.0.0.1:8000',
        proxyTimeout: 300000,
        timeout: 300000
      },
      '/gemini-generate': {
        target: 'http://127.0.0.1:8000',
        proxyTimeout: 300000,
        timeout: 300000
      },
      '/gemini-status': 'http://127.0.0.1:8000',
      '/gemini-config': 'http://127.0.0.1:8000',
      '/openai-generate': {
        target: 'http://127.0.0.1:8000',
        proxyTimeout: 300000,
        timeout: 300000
      },
      '/openai-status': 'http://127.0.0.1:8000',
      '/ai-generate': {
        target: 'http://127.0.0.1:8000',
        proxyTimeout: 300000,
        timeout: 300000
      },
      '/ai-providers': 'http://127.0.0.1:8000'
    }
  }
})
