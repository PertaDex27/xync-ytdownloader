import { spawn, spawnSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import crypto from 'node:crypto'
import { upstreamFetch } from './upstream.js'

// ------------------------------------------------------------------- token
// Token = base64url(JSON konteks) + HMAC biar gak bisa dipalsu (SSRF gate).
const SECRET = process.env.SNAPYT_TOKEN_SECRET
  || crypto.createHash('sha256').update('xync-snapyt-token').digest('hex')

const TOKEN_TTL_MS = 6 * 60 * 60 * 1000

function hmac(body) {
  return crypto.createHmac('sha256', SECRET).update(body).digest('base64url').slice(0, 24)
}

function safeEqual(a, b) {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb)
}

export function makeStreamUrl(ctx) {
  const payload = { e: Date.now() + TOKEN_TTL_MS, ...ctx }
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `/api/stream?t=${body}.${hmac(body)}`
}

export function readToken(t) {
  if (!t || !t.includes('.')) throw new Error('token stream gak valid')
  const [body, sig] = t.split('.')
  if (!safeEqual(hmac(body), sig)) throw new Error('token stream gak valid')
  let ctx
  try { ctx = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) } catch {
    throw new Error('token stream gak valid')
  }
  if (!ctx.u || !/^https?:\/\//.test(ctx.u)) throw new Error('token stream gak valid')
  if (!ctx.e || ctx.e < Date.now()) throw new Error('link download kedaluwarsa, proses ulang videonya')
  return ctx
}

// ------------------------------------------------------------------ ffmpeg
let _ffmpeg = null
export function ffmpegAvailable() {
  if (_ffmpeg !== null) return _ffmpeg
  try {
    const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    _ffmpeg = !r.error && r.status === 0
  } catch { _ffmpeg = false }
  return _ffmpeg
}

// ------------------------------------------------------------------ proxy
const PROXY_MODE = process.env.SNAPYT_PROXY_MODE === 'redirect' ? 'redirect' : 'proxy'

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(data))
}

export async function handleStream(req, res) {
  const url = new URL(req.url, 'http://internal')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Cache-Control', 'no-store')

  let ctx
  try {
    ctx = readToken(url.searchParams.get('t'))
  } catch (err) {
    return json(res, 400, { status: 'error', message: err.message })
  }

  // Mode redirect: terusin langsung link snapyt (cek dulu referer-nya oke).
  if (PROXY_MODE === 'redirect' || url.searchParams.get('direct') === '1') {
    res.writeHead(302, { Location: ctx.u })
    return res.end()
  }

  const headers = { Referer: ctx.r || 'https://www.snapyt.app/id/' }
  if (ctx.k) headers.Cookie = ctx.k
  if (req.headers.range) headers.Range = req.headers.range

  let up
  try {
    up = await upstreamFetch(ctx.u, { headers, redirect: 'follow', signal: AbortSignal.timeout(600000) })
  } catch (err) {
    return json(res, 502, { status: 'error', message: `gak bisa nyambung ke sumber file: ${err.message}` })
  }
  const ctype = up.headers.get('content-type') || ''
  if (![200, 206].includes(up.status) || ctype.includes('json') || ctype.includes('text/html')) {
    let why = ''
    try { why = (await up.text()).slice(0, 120) } catch {}
    if (up.body) { try { await up.body.cancel() } catch {} }
    return json(res, 502, { status: 'error', message: `sumber file nolak (HTTP ${up.status}) ${why}`.trim() })
  }

  // MP3: transcode opus -> mp3 pakai ffmpeg lokal (cuma jalan kalau ffmpeg ada).
  if (ctx.ff?.br && ffmpegAvailable()) {
    const args = ['-hide_banner', '-loglevel', 'error',
      '-headers', `Referer: ${headers.Referer}\r\n${ctx.k ? `Cookie: ${ctx.k}\r\n` : ''}`,
      '-i', ctx.u, '-vn', '-c:a', 'libmp3lame', '-b:a', `${ctx.ff.br}k`, '-f', 'mp3', 'pipe:1']
    const child = spawn('ffmpeg', args)
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Disposition': contentDisposition(ctx.f || 'audio.mp3'),
      'Access-Control-Allow-Origin': '*',
    })
    child.stdout.pipe(res)
    child.stderr.on('data', d => { if (process.env.SNAPYT_DEBUG) console.log('[ffmpeg]', String(d)) })
    child.on('error', () => res.destroy())
    return
  }

  const out = {
    'Content-Type': ctype || 'application/octet-stream',
    'Content-Disposition': contentDisposition(ctx.f || 'download'),
    'Access-Control-Allow-Origin': '*',
    'Accept-Ranges': up.headers.get('accept-ranges') || 'bytes',
  }
  const len = up.headers.get('content-length')
  if (len) out['Content-Length'] = len
  res.writeHead(up.status, out)
  if (req.method === 'HEAD') return res.end()
  if (!up.body) return res.end()
  try {
    await pipeline(Readable.fromWeb(up.body), res)
  } catch {
    res.destroy()
  }
}

function contentDisposition(name) {
  const fallback = name.replace(/[^\w. -]/g, '_')
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`
}
