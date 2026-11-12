import { convert, normalizeFormat, normalizeQuality, extractVideoId, fetchMeta } from '../src/engine.js'

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
      const meta = await fetchMeta(videoId)
      const url = await convert(videoId, format, quality, (msg, frac) => push({ type: 'status', msg, frac }))
      push({ type: 'done', status: 'ok', videoId, title: meta.title, author: meta.author, thumbnail: meta.thumbnail, format, quality, url })
    } catch (err) {
      push({ type: 'error', message: err.message })
    }
    return res.end()
  }

  try {
    const meta = await fetchMeta(videoId)
    const url = await convert(videoId, format, quality)
    res.status(200).json({ status: 'ok', videoId, title: meta.title, author: meta.author, thumbnail: meta.thumbnail, format, quality, url })
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}
