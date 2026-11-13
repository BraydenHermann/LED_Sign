import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'

const ALLOWLIST_FILE = path.resolve(__dirname, '..', 'server', '.remote_access.json')
const REMOTE_PEER_HEADER = 'x-led-remote-peer'

// Mirrors server/remote_access.py: only this machine and the VPN client IPs in
// server/.remote_access.json may use the UI.
let allowlistCache = { mtimeMs: null, ranges: [] }

function normalizeIp(ip = '') {
  const text = String(ip).trim()
  return text.startsWith('::ffff:') ? text.slice(7) : text
}

function isLoopback(ip) {
  const addr = normalizeIp(ip)
  return addr === '::1' || /^127\./.test(addr)
}

function ipv4ToInt(ip) {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null
    value = value * 256 + Number(part)
  }
  return value
}

function parseRange(entry) {
  const [ip, bitsText] = String(entry).trim().split('/')
  const base = ipv4ToInt(ip)
  const bits = bitsText === undefined ? 32 : Number(bitsText)
  if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null
  const size = 2 ** (32 - bits)
  const start = Math.floor(base / size) * size
  return { start, end: start + size - 1 }
}

function loadAllowedRanges() {
  let mtimeMs
  try {
    mtimeMs = fs.statSync(ALLOWLIST_FILE).mtimeMs
  } catch {
    mtimeMs = null
  }
  if (allowlistCache.mtimeMs !== mtimeMs) {
    let entries
    try {
      entries = JSON.parse(fs.readFileSync(ALLOWLIST_FILE, 'utf8')).allowed_ips || []
    } catch {
      entries = []
    }
    allowlistCache = { mtimeMs, ranges: entries.map(parseRange).filter(Boolean) }
  }
  return allowlistCache.ranges
}

function isAllowedPeer(ip) {
  const addr = normalizeIp(ip)
  if (isLoopback(addr)) return true
  const value = ipv4ToInt(addr)
  if (value === null) return false
  return loadAllowedRanges().some(r => value >= r.start && value <= r.end)
}

const PRITUNL_INSTALL_URL = 'https://client.pritunl.com/#install'

function deniedPage() {
  return (
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Access Denied</title>' +
    '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0a0f;color:#e2e8f0;font-family:system-ui,sans-serif;text-align:center;padding:24px}' +
    '.card{max-width:420px;background:#161622;border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:28px}h1{font-size:20px;margin:0 0 8px}p{font-size:14px;color:#94a3b8;margin:0;line-height:1.5}a{color:#a78bfa}</style>' +
    '</head><body><div class="card"><h1>Access Denied</h1><p>LED Sign can only be controlled remotely over the work VPN. ' +
    `Connect with <a href="${PRITUNL_INSTALL_URL}" target="_blank" rel="noopener noreferrer">Pritunl</a>, then reload this page.</p></div></body></html>`
  )
}

// Remember recent blocked devices so the host can see which address a VPN
// connection arrives from and allow it in the Remote Access dialog.
const DENIED_FILE = path.resolve(__dirname, '..', 'server', '.remote_access_denied.json')
const MAX_DENIED = 10
const deniedLastWrite = new Map()

function recordDenied(ip) {
  const now = Date.now()
  if (now - (deniedLastWrite.get(ip) || 0) < 30000) return
  deniedLastWrite.set(ip, now)
  let entries
  try {
    entries = JSON.parse(fs.readFileSync(DENIED_FILE, 'utf8'))
    if (!Array.isArray(entries)) entries = []
  } catch {
    entries = []
  }
  entries = [{ ip, last_seen: now / 1000 }, ...entries.filter(e => e && e.ip !== ip)].slice(0, MAX_DENIED)
  try {
    fs.writeFileSync(DENIED_FILE, JSON.stringify(entries, null, 2))
  } catch (err) {
    console.warn(`[vpn-access] Could not record denied device: ${err.message}`)
  }
}

function vpnAccessGatePlugin() {
  return {
    name: 'vpn-access-gate',
    configureServer(server) {
      // Block websocket upgrades (HMR) from devices that aren't allowed.
      server.httpServer?.prependListener('upgrade', (req, socket) => {
        if (!isAllowedPeer(req.socket.remoteAddress)) {
          recordDenied(normalizeIp(req.socket.remoteAddress))
          socket.destroy()
        }
      })
      server.middlewares.use((req, res, next) => {
        const peer = normalizeIp(req.socket.remoteAddress)
        // Never trust a client-supplied value; the proxy forwards ours to the backend.
        delete req.headers[REMOTE_PEER_HEADER]
        if (!isAllowedPeer(peer)) {
          console.warn(`[vpn-access] Denied ${peer} ${req.method} ${req.url}`)
          recordDenied(peer)
          const wantsJson = String(req.headers.accept || '').includes('application/json') || String(req.url || '').startsWith('/api/')
          res.statusCode = 403
          res.setHeader('Content-Type', wantsJson ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8')
          res.end(wantsJson ? JSON.stringify({ detail: 'LED Sign can only be controlled remotely over the work VPN (Pritunl).' }) : deniedPage())
          return
        }
        if (!isLoopback(peer)) req.headers[REMOTE_PEER_HEADER] = peer
        return next()
      })
    }
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), vpnAccessGatePlugin()],
  server: {
    host: '0.0.0.0',
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
      '/api/google': 'http://127.0.0.1:8000'
    }
  }
})
