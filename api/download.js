import { errorPayload } from '../src/diagnostics.js'
import { resolve as resolveDownload, normalizeFormat, normalizeQuality, extractVideoId } from '../src/engine.js'

function absolute(req, rel) {
  if (rel.startsWith('http')) return rel
  const proto = req.headers['x-forwarded-proto'] || 'https'
  const host = req.headers.host
  return `${proto}://${host}${rel}`
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Cache-Control', 'no-store')
  const q = req.query || {}
  const videoId = extractVideoId(q.url || q.id)
  if (!videoId) return res.status(400).json({ status: 'error', message: 'url youtube tidak valid' })

  const format = normalizeFormat(q.format)
  const quality = normalizeQuality(format, q.quality)

  if (q.stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
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

  try {
    const r = await resolveDownload(videoId, format, quality)
    res.status(200).json({
      status: 'ok', videoId,
      title: r.title, author: r.channel, thumbnail: r.thumbnail,
      format: r.format, quality: r.quality, size: r.size, label: r.label,
      url: absolute(req, r.url),
    })
  } catch (err) {
    res.status(500).json({ status: 'error', ...errorPayload(err) })
  }
}
