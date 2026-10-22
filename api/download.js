import { convert, normalizeFormat, normalizeQuality, extractVideoId, fetchMeta } from '../src/engine.js'

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Cache-Control', 'no-store')
  const q = req.query || {}
  const videoId = extractVideoId(q.url || q.id)
  if (!videoId) return res.status(400).json({ status: 'error', message: 'url youtube tidak valid' })
  try {
    const format = normalizeFormat(q.format)
    const quality = normalizeQuality(format, q.quality)
    const meta = await fetchMeta(videoId)
    const url = await convert(videoId, format, quality)
    res.status(200).json({ status: 'ok', videoId, title: meta.title, author: meta.author, thumbnail: meta.thumbnail, format, quality, url })
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}
