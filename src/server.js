import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { convert, normalizeFormat, normalizeQuality, extractVideoId, fetchMeta } from './engine.js'

const PORT = process.env.PORT || 3000

function send(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(JSON.stringify(data))
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
      const meta = await fetchMeta(videoId)
      const fileUrl = await convert(videoId, format, quality)
      return send(res, 200, { status: 'ok', videoId, title: meta.title, author: meta.author, format, quality, url: fileUrl })
    }
  } catch (err) {
    return send(res, 500, { status: 'error', message: err.message || 'server error' })
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
