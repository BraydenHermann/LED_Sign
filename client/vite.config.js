import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const LINK_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000
const TOKEN_FILE = path.resolve(__dirname, '..', 'server', '.tunnel_token')
const GENERATED_AT_FILE = path.resolve(__dirname, '..', 'server', '.tunnel_generated_at')

function parseCookies(cookieHeader = '') {
  const out = {}
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    const k = part.slice(0, idx).trim()
    const v = part.slice(idx + 1).trim()
    if (k) out[k] = decodeURIComponent(v)
  }
  return out
}

function safeTokenEquals(a, b) {
  if (!a || !b) return false
  const bufA = Buffer.from(String(a), 'utf8')
  const bufB = Buffer.from(String(b), 'utf8')
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

function isRemoteTokenValid(providedToken) {
  if (!providedToken) return false
  try {
    const expectedToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim()
    if (!expectedToken || expectedToken.length < 16) return false
    if (fs.existsSync(GENERATED_AT_FILE)) {
      const genSec = parseFloat(fs.readFileSync(GENERATED_AT_FILE, 'utf8').trim())
      if (Number.isFinite(genSec) && Date.now() - genSec * 1000 >= LINK_EXPIRY_MS) {
        return false
      }
    }
    return safeTokenEquals(providedToken, expectedToken)
  } catch {
    return false
  }
}

function remoteTunnelGatePlugin() {
  return {
    name: 'remote-tunnel-gate',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const host = String(req.headers['x-forwarded-host'] || req.headers.host || '')
          .split(':')[0]
          .toLowerCase()
        const isRemoteTunnel = Boolean(
          req.headers['cf-connecting-ip'] ||
          req.headers['cf-ray'] ||
          host.endsWith('.trycloudflare.com')
        )
        if (!isRemoteTunnel) {
          return next()
        }

        const parsedUrl = new URL(req.url || '/', 'http://localhost')
        const queryToken = parsedUrl.searchParams.get('token')?.trim() || ''
        const headerToken = String(req.headers['x-remote-token'] || '').trim()
        const cookies = parseCookies(req.headers.cookie || '')
        const cookieToken = String(cookies.led_remote_token || '').trim()

        const tokenToCheck = queryToken || headerToken || cookieToken
        if (!isRemoteTokenValid(tokenToCheck)) {
          const acceptsJson = String(req.headers.accept || '').includes('application/json')
          if (acceptsJson || parsedUrl.pathname.startsWith('/api/')) {
            res.statusCode = 403
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({ detail: 'This remote access link is invalid or has expired.' }))
            return
          }
          res.statusCode = 403
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.end(
            '<!doctype html><html><head><meta charset="utf-8"><title>Link Unavailable</title>' +
            '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0a0f;color:#e2e8f0;font-family:system-ui,sans-serif;text-align:center;padding:24px}' +
            '.card{max-width:420px;background:#161622;border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:28px}h1{font-size:20px;margin:0 0 8px}p{font-size:14px;color:#94a3b8;margin:0;line-height:1.5}</style>' +
            '</head><body><div class="card"><h1>Link Unavailable</h1><p>This remote access link is no longer valid or has expired. Request a new link from the LED Sign host.</p></div></body></html>'
          )
          return
        }

        if (queryToken && isRemoteTokenValid(queryToken)) {
          const isHttps = req.headers['x-forwarded-proto'] === 'https' || host.endsWith('.trycloudflare.com')
          const cookieFlags = isHttps ? 'Path=/; HttpOnly; SameSite=Lax; Secure' : 'Path=/; HttpOnly; SameSite=Lax'
          res.setHeader('Set-Cookie', `led_remote_token=${encodeURIComponent(queryToken)}; ${cookieFlags}`)
        }

        return next()
      })
    }
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), remoteTunnelGatePlugin()],
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: {
      '/scan': 'http://127.0.0.1:8000',
      '/connect': 'http://127.0.0.1:8000',
      '/sign-password': 'http://127.0.0.1:8000',
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
      '/local-presets': 'http://127.0.0.1:8000',
      '/claim-notification': 'http://127.0.0.1:8000',
      '/sync': {
        target: 'http://127.0.0.1:8000',
        proxyTimeout: 300000,
        timeout: 300000
      },
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
      '/ai-providers': 'http://127.0.0.1:8000',
      '/loy-categories': 'http://127.0.0.1:8000',
      '/loy-materials': 'http://127.0.0.1:8000',
      '/loy-my-materials': 'http://127.0.0.1:8000',
      '/loy-proxy-media': 'http://127.0.0.1:8000',
      '/loy-auth-status': 'http://127.0.0.1:8000',
      '/loy-login': 'http://127.0.0.1:8000',
      '/loy-logout': 'http://127.0.0.1:8000',
      '/loy-upload': 'http://127.0.0.1:8000',
      '/api/loy': 'http://127.0.0.1:8000',
      '/google-images': 'http://127.0.0.1:8000',
      '/google-proxy-media': 'http://127.0.0.1:8000',
      '/api/google': 'http://127.0.0.1:8000',
      '/tunnel-url': 'http://127.0.0.1:8000',
      '/tunnel-status': 'http://127.0.0.1:8000'
    }
  }
})
