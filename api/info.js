import { extractVideoId, fetchMeta } from '../src/engine.js'

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  const q = req.query || {}
  const videoId = extractVideoId(q.url || q.id)
  if (!videoId) return res.status(400).json({ status: 'error', message: 'url youtube tidak valid' })
  try {
    const meta = await fetchMeta(videoId)
    res.status(200).json({ status: 'ok', videoId, ...meta })
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}
