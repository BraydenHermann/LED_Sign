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
      '/process-gif': 'http://127.0.0.1:8000',
      '/save-preset': 'http://127.0.0.1:8000',
      '/preset': 'http://127.0.0.1:8000',
      '/delete-preset': 'http://127.0.0.1:8000',
      '/push-text': 'http://127.0.0.1:8000',
      '/render-text-preview': 'http://127.0.0.1:8000',
      '/clock': 'http://127.0.0.1:8000',
      '/static': 'http://127.0.0.1:8000',
      '/disconnect': 'http://127.0.0.1:8000',
      '/hardware-slots': 'http://127.0.0.1:8000'
    }
  }
})
