import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { solveCap } from './cap.js'

const BASE = 'https://embed.dlsrv.online'
const SOLVER = 'https://check.dlsrv.online/30bb427100/'
const CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config.json')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'

const BASE_HEADERS = {
  'User-Agent': UA,
  'sec-ch-ua': '"Not:A-Brand";v="8", "Chromium";v="156"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'accept-language': 'en-US',
  Origin: BASE,
  Referer: `${BASE}/v3/full`,
}

const FORMATS = {
  mp4: ['2160', '1440', '1080', '720', '480', '360', '240', '144'],
  mp3: ['320', '256', '128', '96', '64'],
  m4a: ['320'],
  opus: ['320'],
}

const DEFAULT_QUALITY = { mp4: '1080', mp3: '320', m4a: '320', opus: '320' }

let session = { token: null, exp: 0 }
let renewing = null

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) } catch { return {} }
}

export function getCapsolverUrl() {
  return process.env.CAPSOLVER_URL || loadConfig().capsolver || ''
}

export function setCapsolverUrl(url) {
  const cfg = loadConfig()
  if (url) cfg.capsolver = url
  else delete cfg.capsolver
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2))
}

async function getCapToken(onStatus) {
  const remote = getCapsolverUrl()
  if (remote) {
    onStatus('Solve captcha via CapSolver...')
    try {
      const res = await fetch(remote.replace(/\/+$/, ''))
      const data = await res.json()
      if (data?.capToken) return data.capToken
    } catch {}
  }
  return solveCap(SOLVER, onStatus)
}

export function extractVideoId(input) {
  const s = String(input || '').trim()
  if (/^[\w-]{11}$/.test(s)) return s
  try {
    const u = new URL(s)
    const host = u.hostname.replace(/^www\./, '')
    if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null
    if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      if (u.searchParams.get('v')) return u.searchParams.get('v')
      const m = u.pathname.match(/^\/(shorts|embed|live|v)\/([\w-]{11})/)
      if (m) return m[2]
    }
  } catch {}
  return null
}

export async function fetchMeta(videoId) {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`)
    if (!res.ok) return { title: `YouTube Video ${videoId}`, thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, author: null }
    const data = await res.json()
    return { title: data.title, thumbnail: data.thumbnail_url, author: data.author_name }
  } catch {
    return { title: `YouTube Video ${videoId}`, thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, author: null }
  }
}

function authHeaders(token, extra = {}) {
  return { ...BASE_HEADERS, ...extra, Authorization: `Bearer ${token}` }
}

function decodeJwtExp(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
    return payload.exp ? payload.exp * 1000 : Date.now() + 60000
  } catch {
    return 0
  }
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts)
  let body = null
  try { body = await res.json() } catch {}
  return { status: res.status, body }
}

async function createSession(onStatus) {
  const capToken = await getCapToken(onStatus)
  onStatus('Verifikasi session...')
  const { status, body } = await fetchJson(`${BASE}/api/verify`, {
    method: 'POST',
    headers: { ...BASE_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ capToken }),
  })
  if (status === 403) throw new Error('verify rejected (403 Forbidden)')
  if (!body?.token) throw new Error(`verify failed: ${status} ${JSON.stringify(body)}`)
  return { token: body.token, exp: decodeJwtExp(body.token) }
}

async function ensureSession(onStatus = () => {}) {
  if (session.token && Date.now() < session.exp - 30000) return session.token
  if (!renewing) {
    renewing = createSession(onStatus)
      .then(s => { session = s; return s.token })
      .finally(() => { renewing = null })
  }
  return renewing
}

async function resetSession() {
  session = { token: null, exp: 0 }
}

async function touchSession(token, videoId) {
  await fetchJson(`${BASE}/api/session/touch`, {
    method: 'POST',
    headers: authHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ videoId }),
  })
}

async function startJob(token, videoId, format, quality) {
  const { status, body } = await fetchJson(`${BASE}/api/v3/download`, {
    method: 'POST',
    headers: authHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ videoId, format, quality }),
  })
  return { status, body }
}

async function pollJob(token, job, timeoutMs, onStatus) {
  const deadline = Date.now() + timeoutMs
  onStatus('Nunggu hasil konversi...')
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000))
    const { status, body } = await fetchJson(`${BASE}/api/v3/progress?${new URLSearchParams({ job })}`, {
      headers: authHeaders(token),
      cache: 'no-store',
    })
    if (status === 429) continue
    if (status === 401 || status === 403) throw new Error(`progress rejected: ${status}`)
    if (!body) continue
    if (typeof body.progress === 'number') onStatus(`Konversi... ${body.progress}%`, body.progress / 100)
    if (body.done) {
      if (body.url) return body.url
      throw new Error(body.error || 'conversion failed')
    }
    if (body.error) throw new Error(body.error)
  }
  throw new Error('conversion timed out')
}

export async function convert(videoId, format, quality, onStatus = () => {}) {
  let token = await ensureSession(onStatus)
  let renewed = false
  for (;;) {
    onStatus('Request konversi...')
    await touchSession(token, videoId)
    const { status, body } = await startJob(token, videoId, format, quality)
    if (status === 401 || status === 403) {
      if (renewed) throw new Error(`download rejected: ${status}`)
      renewed = true
      await resetSession()
      token = await ensureSession(onStatus)
      continue
    }
    if (body?.job) return pollJob(token, body.job, 300000, onStatus)
    if (body?.error === 'Session not ready. Please try again.') {
      if (renewed) throw new Error(body.error)
      renewed = true
      onStatus('Session belum siap, coba lagi...')
      await new Promise(r => setTimeout(r, 2000))
      continue
    }
    throw new Error(body?.error || `download failed: ${status}`)
  }
}

export function normalizeFormat(format) {
  const f = String(format || '').toLowerCase()
  return FORMATS[f] ? f : 'mp3'
}

export function normalizeQuality(format, quality) {
  const list = FORMATS[format]
  const q = String(quality || DEFAULT_QUALITY[format])
  return list.includes(q) ? q : DEFAULT_QUALITY[format]
}

export { FORMATS }
