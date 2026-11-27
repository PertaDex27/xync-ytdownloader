// Engine web: dulu ke embed.dlsrv.online (captcha + PoW), sekarang ke snapyt.app.
// Port JS dari api.py (SnapYT client) — nonce, process_video_url, race jalur,
// server merge. Kontrak API lama tetap: format mp3/mp4/m4a/opus + kualitas.
import { SnapYT, pickOption, bestAudio, outName, safeName } from './snapyt.js'
import { makeStreamUrl, ffmpegAvailable } from './streamProxy.js'

const IS_VERCEL = !!process.env.VERCEL

export const FORMATS = {
  mp4: ['2160', '1440', '1080', '720', '480', '360', '240', '144'],
  mp3: ['320', '256', '128', '96', '64'],
  m4a: ['320'],
  opus: ['320'],
}

const DEFAULT_QUALITY = { mp4: '1080', mp3: '320', m4a: '320', opus: '320' }

export function normalizeFormat(format) {
  const f = String(format || '').toLowerCase()
  return FORMATS[f] ? f : 'mp3'
}

export function normalizeQuality(format, quality) {
  const list = FORMATS[format]
  const q = String(quality || DEFAULT_QUALITY[format])
  return list.includes(q) ? q : DEFAULT_QUALITY[format]
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

/** Info mentah snapyt (judul, channel, durasi, semua opsi format). */
export async function getSnapytInfo(videoId, onStatus = () => {}) {
  const cli = new SnapYT({ ajaxTimeout: IS_VERCEL ? 45000 : 90000 })
  onStatus('Ngambil info video dari snapyt...')
  return cli.fetchInfo(`https://www.youtube.com/watch?v=${videoId}`)
}

/**
 * Selesaikan satu permintaan download -> konteks stream snapyt yang sudah
 * kebukti jalan (dibalap dulu jalurnya), dibungkus token buat /api/stream.
 */
export async function resolve(videoId, format, quality, onStatus = () => {}) {
  const cli = new SnapYT({ ajaxTimeout: IS_VERCEL ? 45000 : 90000 })
  onStatus('Ngambil info video dari snapyt...')
  const info = await cli.fetchInfo(`https://www.youtube.com/watch?v=${videoId}`)

  let fmt = format
  let pick = pickOption(info, fmt, quality)
  let opt = pick.option || pick
  const mode = pick.mode || 'single'
  if (pick.degraded) {
    onStatus(`Resolusi ${quality}p gak tersedia → pakai ${opt.res ? `${opt.res}p` : opt.label}`)
  }

  let ffBr = null
  if (fmt === 'mp3') {
    const br = Number(opt.mp3) || Number(quality) || 320
    if (!IS_VERCEL && ffmpegAvailable()) {
      // Sumber mp3 di snapyt tetap opus/webm — encode MP3-nya di lokal (kayak api.py).
      onStatus(`Nyiapin sumber audio buat encode MP3 ${br}k...`)
      ffBr = br
    } else {
      // Gak ada ffmpeg (mis. di Vercel) → fallback M4A biar tetap bisa diputar.
      const alt = bestAudio(info, 'mp4') || opt
      opt = alt
      fmt = 'm4a'
      onStatus(`MP3 perlu ffmpeg (gak ada di sini) → dikasih M4A ${quality}k`)
    }
  }

  let stream
  if (mode === 'mux') {
    onStatus(`Server merge: ${opt.label} + ${pick.audio.label}...`)
    stream = await cli.serverMerge(info, opt, pick.audio, {
      onStatus,
      deadlineMs: IS_VERCEL ? 45000 : 240000,
    })
  } else {
    onStatus(`Nyari jalur tercepat buat ${opt.label}...`)
    stream = await cli.openStream(info, opt, {
      onRetry: (_sent, _host, _route, why) => onStatus(`Nyari jalur download · ${why}`),
    })
  }

  const ext = fmt === 'mp3' ? 'mp3' : mode === 'mux' ? 'mp4' : (opt.ext === 'opus' ? 'webm' : opt.ext)
  const filename = ffBr
    ? `${safeName(info.title)} [MP3-${ffBr}k].mp3`
    : outName(info, opt, opt.isAudio ? opt : (pick.audio || null), ext)

  const ctx = { u: stream.url, r: stream.referer, k: stream.cookie, f: filename, s: ffBr ? 0 : (opt.bytes || 0) }
  if (ffBr) ctx.ff = { br: ffBr }

  return {
    url: makeStreamUrl(ctx),
    title: info.title,
    channel: info.channel,
    duration: info.duration,
    secs: info.secs,
    thumbnail: info.thumbs[0] || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    format: fmt,
    quality: fmt === 'mp4' ? String(opt.res || quality)
      : fmt === 'mp3' ? String(ffBr || opt.mp3 || quality)
      : quality,
    label: opt.label,
    size: opt.bytes || 0,
    via: stream.via || '',
  }
}

/** Kompatibel kontrak lama: balikin URL final siap diunduh. */
export async function convert(videoId, format, quality, onStatus = () => {}) {
  const r = await resolve(videoId, format, quality, onStatus)
  const base = process.env.SNAPYT_PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`
  return r.url.startsWith('http') ? r.url : base + r.url
}
