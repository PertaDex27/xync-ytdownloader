import { errorPayload } from './diagnostics.js'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleStream } from './streamProxy.js'
import { resolve as resolveDownload, normalizeFormat, normalizeQuality, extractVideoId, fetchMeta } from './engine.js'

const PORT = process.env.PORT || 3000

function send(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(data))
}

function absolute(req, rel) {
  if (rel.startsWith('http')) return rel
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`
  // di belakang tunnel (cloudflared/ngrok) halaman dibuka via https — jangan balikin link http
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim()
  return `${proto}://${host}${rel}`
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const q = url.searchParams

  if (req.method !== 'GET') return send(res, 405, { status: 'error', message: 'method not allowed' })

  try {
    if (url.pathname === '/') {
      const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html'))
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(html)
    }

    if (url.pathname === '/api/stream') {
      return await handleStream(req, res)
    }

    if (url.pathname !== '/api/info' && url.pathname !== '/api/download') {
      return send(res, 404, { status: 'error', message: 'endpoint tidak ketemu' })
    }

    const videoId = extractVideoId(q.get('url') || q.get('id'))
    if (!videoId) return send(res, 400, { status: 'error', message: 'url/id youtube tidak valid' })

    if (url.pathname === '/api/info') {
      const meta = await fetchMeta(videoId)
      return send(res, 200, { status: 'ok', videoId, ...meta })
    }

    if (url.pathname === '/api/download') {
      const format = normalizeFormat(q.get('format'))
      const quality = normalizeQuality(format, q.get('quality'))

      if (q.get('stream')) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        })
        const push = data => res.write(`data: ${JSON.stringify(data)}\n\n`)
        try {
          const r = await resolveDownload(videoId, format, quality, (msg, frac) => push({ type: 'status', msg, frac }))
          push({
            type: 'done', status: 'ok', videoId,
            title: r.title, author: r.channel, thumbnail: r.thumbnail,
            format: r.format, quality: r.quality, size: r.size, label: r.label,
            url: absolute(req, r.url),
          })
        } catch (err) {
          push({ type: 'error', ...errorPayload(err) })
        }
        return res.end()
      }

      const r = await resolveDownload(videoId, format, quality)
      return send(res, 200, {
        status: 'ok', videoId,
        title: r.title, author: r.channel, thumbnail: r.thumbnail,
        format: r.format, quality: r.quality, size: r.size, label: r.label,
        url: absolute(req, r.url),
      })
    }
  } catch (err) {
    return send(res, 500, { status: 'error', ...errorPayload(err) })
  }
}

let instance = null

export function startServer(port = PORT) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(handle)
    srv.once('error', reject)
    srv.listen(port, () => {
      instance = srv
      resolve(srv)
    })
  })
}

export function stopServer() {
  return new Promise(resolve => {
    if (!instance) return resolve(false)
    instance.close(() => resolve(true))
    instance = null
  })
}

export function serverPort() {
  return Number(PORT)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  startServer()
    .then(() => console.log(`xync api jalan di http://localhost:${PORT}`))
    .catch(err => {
      console.error(`gagal jalan: ${err.message}`)
      process.exit(1)
    })
}
