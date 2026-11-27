// Port JS dari api.py (SnapYT v5 client) — https://www.snapyt.app
// Alur: nonce -> process_video_url -> halaman preview -> opsi format ->
//       balapan jalur (route book + probe) / server merge (vd_mux_start).
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { upstreamFetch, usingWorker } from './upstream.js'

export const BASE = process.env.SNAPYT_BASE || 'https://www.snapyt.app'
export const AJAX = `${BASE}/wp-admin/admin-ajax.php`

const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36'

// Header ala browser beneran — Cloudflare lebih galak ke request yg "polos".
const BROWSER_HEADERS = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'sec-ch-ua': '"Chromium";v="154", "Not.A/Brand";v="99", "Google Chrome";v="154"',
  'sec-ch-ua-mobile': '?1',
  'sec-ch-ua-platform': '"Android"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'upgrade-insecure-requests': '1',
}

// Opsional: lewatin proxy kalau IP server (mis. Vercel) diblok Cloudflare.
// Set env SNAPYT_PROXY=http://user:pass@host:port
let _dispatcher
async function dispatcher() {
  const proxy = process.env.SNAPYT_PROXY
  if (!proxy) return undefined
  if (_dispatcher === undefined) {
    try {
      const { ProxyAgent } = await import('undici')
      _dispatcher = new ProxyAgent(proxy)
      dbg('proxy aktif', new URL(proxy).host)
    } catch (err) {
      console.warn('[snapyt] SNAPYT_PROXY di-set tapi undici gak ada:', err.message)
      _dispatcher = null
    }
  }
  return _dispatcher || undefined
}

// Bikin error yg jelas: siapa yg nolak (Cloudflare / origin), cf-ray, potongan body.
async function upstreamError(res, what) {
  let body = ''
  try { body = await res.text() } catch {}
  const h = name => res.headers.get(name) || ''
  const cf = h('cf-mitigated') === 'challenge' || /Just a moment|challenge-platform|cf-chl|Attention Required/i.test(body)
  const blockedBy = cf ? 'Cloudflare (anti-bot / IP server diblok)' : (h('server') || 'origin')
  const hint = res.status === 403 || res.status === 429
    ? (usingWorker()
      ? ' — snapyt juga nolak IP worker Cloudflare. Worker gak tembus, perlu proxy residential (SNAPYT_PROXY) / host sendiri.'
      : ' — kemungkinan IP server (Vercel/datacenter) diblok snapyt. Set env SNAPYT_WORKER (Cloudflare Worker) atau SNAPYT_PROXY.')
    : ''
  const err = new Error(`gak bisa buka ${what}: HTTP ${res.status} diblok ${blockedBy}${hint}`)
  const u = new URL(res.url || BASE)
  err.diagnostic = {
    source: 'upstream',
    url: u.origin + u.pathname,
    status: res.status,
    statusText: res.statusText,
    capturedAt: new Date().toISOString(),
    headers: Object.fromEntries(['content-type', 'server', 'cf-ray', 'cf-mitigated', 'retry-after', 'x-vercel-id']
      .flatMap(n => (h(n) ? [[n, h(n)]] : []))),
    region: process.env.VERCEL_REGION || null,
    via: usingWorker() ? 'cloudflare-worker' : 'direct',
    body: body.replace(/\s+/g, ' ').slice(0, 800),
    truncated: body.length > 800,
  }
  return err
}

const ROUTES_FILE = process.env.SNAPYT_ROUTES_PATH
  || path.join(os.tmpdir(), 'snapyt_routes.json')

const dbg = (...args) => { if (process.env.SNAPYT_DEBUG) console.log('[snapyt]', ...args) }

export const randomHex = bytes => crypto.randomBytes(bytes).toString('hex')

const ENTITY_MAP = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }

export function unescapeHtml(s = '') {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z#0-9]+);/gi, (_, n) => ENTITY_MAP[n.toLowerCase()] ?? `&${n};`)
}

const stripTags = s => String(s).replace(/<[^>]+>/g, '')

export function safeName(s = '') {
  const out = String(s)
    .replace(/#\S+/g, '')
    .replace(/[\\/:*?"<>|]+/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 80)
  return out || 'video'
}

export function tagLabel(label = '') {
  return String(label).replace(/·/g, '-').replace(/ /g, '').replace(/[^\w.+-]/g, '')
}

export function hms(sec) {
  sec = Math.max(0, Math.floor(sec || 0))
  if (sec < 3600) {
    const m = String(Math.floor(sec / 60)).padStart(2, '0')
    const s = String(sec % 60).padStart(2, '0')
    return `${m}:${s}`
  }
  const h = Math.floor(sec / 3600)
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0')
  const s = String(sec % 60).padStart(2, '0')
  return `${h}:${m}:${s}`
}

// ---------------------------------------------------------------- cookie jar
class CookieJar {
  constructor() { this.map = new Map() }

  store(res) {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
    for (const line of list) {
      const pair = line.split(';')[0]
      const eq = pair.indexOf('=')
      if (eq > 0) this.map.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
    }
  }

  header() { return [...this.map.entries()].map(([k, v]) => `${k}=${v}`).join('; ') }
}

// ---------------------------------------------------------------- route book
const SEEDS = ['975', '872', '881']

export class RouteBook {
  constructor(file = ROUTES_FILE) {
    this.file = file
    this.db = new Map()
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      for (const [k, rows] of Object.entries(raw || {})) this.db.set(k, new Map(Object.entries(rows || {})))
    } catch {}
  }

  _save() {
    try {
      const out = {}
      for (const [k, rows] of this.db) out[k] = Object.fromEntries(rows)
      fs.writeFileSync(this.file, JSON.stringify(out))
    } catch {}
  }

  _rows(key) {
    let rows = this.db.get(key)
    if (!rows) {
      rows = new Map()
      this.db.set(key, rows)
      if (key.startsWith('www@')) for (const r of SEEDS) rows.set(r, { ok: 1, fail: 0, t: 0, dead: 0 })
      for (const [k, other] of this.db) {
        if (k === key || k.split('@')[0] !== key.split('@')[0]) continue
        for (const [r, st] of other) {
          if ((st.ok || 0) > 1 && !st.dead && !rows.has(r)) rows.set(r, { ok: 1, fail: 0, t: 0, dead: 0 })
        }
      }
    }
    return rows
  }

  static _score(st, now) {
    return (st.ok || 0) - 3 * (st.fail || 0) + (now - (st.t || 0) < 3600 ? 3 : 0)
  }

  best(key, n = 3, skip = []) {
    const now = Date.now() / 1000
    const rows = this._rows(key)
    return [...rows.entries()]
      .filter(([r, st]) => !st.dead && RouteBook._score(st, now) > -4 && !skip.includes(r))
      .sort((a, b) => RouteBook._score(b[1], now) - RouteBook._score(a[1], now))
      .slice(0, n)
      .map(([r]) => r)
  }

  mark(key, route, ok, dead = false) {
    if (!route || !/^\d+$/.test(String(route))) return
    const rows = this._rows(key)
    const st = rows.get(String(route)) || { ok: 0, fail: 0, t: 0, dead: 0 }
    if (ok) {
      st.ok++
      st.fail = Math.max(0, st.fail - 2)
      st.t = Math.floor(Date.now() / 1000)
      st.dead = 0
    } else {
      st.fail++
      if (dead) st.dead = 1
    }
    rows.set(String(route), st)
    this._save()
  }
}

const ROUTES = new RouteBook()

// ------------------------------------------------------------------- client
export class SnapYT {
  constructor({ retries = 12, timeout = 30000, race = 4, ajaxTimeout = 90000 } = {}) {
    this.jar = new CookieJar()
    this.retries = retries
    this.timeout = timeout
    this.ajaxTimeout = ajaxTimeout
    this.race = Math.max(1, Math.min(8, race))
    this.referer = `${BASE}/id/`
    this._ping = new Map()
  }

  async _request(url, { method = 'GET', data = null, headers = {}, timeout } = {}) {
    const isAjax = method !== 'GET' || 'X-Requested-With' in headers
    const hdr = {
      'User-Agent': UA,
      'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
      ...(isAjax ? { 'Accept': '*/*' } : BROWSER_HEADERS),
      ...headers,
    }
    const cookie = this.jar.header()
    if (cookie) hdr.Cookie = cookie
    let body
    if (data != null) {
      body = new URLSearchParams(data).toString()
      hdr['Content-Type'] = 'application/x-www-form-urlencoded'
    }
    let res
    try {
      res = await upstreamFetch(url, {
        method,
        headers: hdr,
        body,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeout || this.timeout),
        dispatcher: usingWorker() ? undefined : await dispatcher(),
      })
    } catch (err) {
      if (/^(worker cloudflare|SNAPYT_WORKER)/.test(err.message)) throw err
      const via = usingWorker() ? ' lewat worker' : ''
      throw new Error(`gak bisa nyambung ke ${new URL(url).host}${via} (${err.cause?.code || err.message})`)
    }
    this.jar.store(res)
    return res
  }

  async _text(res) {
    try { return await res.text() } catch { return '' }
  }

  async nonce() {
    // Coba beberapa halaman (kadang cuma 1 path yg kena rule Cloudflare),
    // terus fallback ke AJAX vd_fresh_nonce sebelum nyerah.
    let firstBad = null
    for (const p of ['/id/', '/', '/en/']) {
      const res = await this._request(`${BASE}${p}`)
      if (!res.ok) {
        dbg('nonce', p, `HTTP ${res.status}`, res.headers.get('cf-mitigated') || '')
        if (!firstBad) firstBad = await upstreamError(res, `snapyt${p}`)
        else await this._text(res)
        continue
      }
      const page = await this._text(res)
      const m = page.match(/var videoDownloader\s*=\s*\{[^}]*"nonce":"([0-9a-f]+)"/)
      dbg('nonce', m ? `dari halaman ${p}` : 'gak ketemu di halaman', m?.[1] || '')
      if (m) return m[1]
      break
    }
    try {
      return await this.freshNonce()
    } catch (err) {
      throw firstBad || err
    }
  }

  async freshNonce() {
    const res = await this._request(AJAX, {
      method: 'POST',
      data: { action: 'vd_fresh_nonce' },
      headers: { Origin: BASE, Referer: `${BASE}/id/`, 'X-Requested-With': 'XMLHttpRequest' },
      timeout: this.timeout,
    })
    if (!res.ok) throw await upstreamError(res, 'snapyt (vd_fresh_nonce)')
    const j = await res.json().catch(() => null)
    const n = j?.data?.nonce
    if (!n) throw new Error('gak dapet nonce baru dari snapyt')
    dbg('nonce', 'fresh', n)
    return n
  }

  async fetchInfo(ytUrl) {
    this.referer = `${BASE}/id/`
    const hdr = { Origin: BASE, Referer: this.referer, 'X-Requested-With': 'XMLHttpRequest' }
    let sec = await this.nonce()
    let status = 0
    let text = ''
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this._request(AJAX, {
        method: 'POST',
        data: { action: 'process_video_url', video_url: ytUrl, security: sec },
        headers: hdr,
        timeout: this.ajaxTimeout,
      })
      status = res.status
      text = await this._text(res)
      dbg('lookup', 'process_video_url', ytUrl, `HTTP ${status}`, text.slice(0, 300).replace(/\n/g, ' '))
      if (text.trim() !== '-1') break
      sec = await this.freshNonce()
    }
    let j
    try { j = JSON.parse(text) } catch {
      if (status === 403 || status === 429) {
        const err = new Error(`snapyt nolak request (HTTP ${status}) — kemungkinan IP server diblok Cloudflare. Coba ganti region function, atau set env SNAPYT_PROXY.`)
        err.diagnostic = { source: 'upstream', url: AJAX, status, region: process.env.VERCEL_REGION || null, body: text.replace(/\s+/g, ' ').slice(0, 800) }
        throw err
      }
      throw new Error(`respon aneh dari server: HTTP ${status} ${text.slice(0, 120)}`)
    }
    if (!j.success) {
      const msg = j.data && typeof j.data === 'object' ? j.data.message : j.data
      throw new Error(`server nolak URL: ${msg || JSON.stringify(j).slice(0, 120)}`)
    }
    const preview = j.data?.redirect
    if (!preview) throw new Error('server gak ngasih halaman preview')
    const pRes = await this._request(preview, { headers: { Referer: this.referer } })
    if (!pRes.ok) throw await upstreamError(pRes, 'preview')
    this.referer = preview
    const page = await this._text(pRes)
    const info = SnapYT.parsePreview(page, preview)
    if (!info.options.length) {
      throw new Error('halaman preview gak ada opsi download (video private/umur/live?)')
    }
    return info
  }

  static parsePreview(page, preview) {
    const first = (pat, fallback = '') => {
      const m = page.match(pat)
      return m ? unescapeHtml(stripTags(m[1])).trim() : fallback
    }
    const title = first(/<h1 class="title">([\s\S]*?)<\/h1>/, 'video')
    const channel = first(/Channel:\s*<strong[^>]*>([\s\S]*?)<\/strong>/, '-')
    const duration = first(/Duration:\s*([0-9:]+)/, '')
    const thumbsRaw = first(/data-srcs="([^"]+)"/, '')
    const thumbs = thumbsRaw.split('|').filter(Boolean)
    const vid = first(/[;?&]t=([\w-]{11})\.\d{9,}/, '')
    let secs = 0
    for (const part of duration.split(':')) {
      if (/^\d+$/.test(part)) secs = secs * 60 + Number(part)
    }
    if (!secs) secs = Number(first(/data-secs="(\d+)"/, '0')) || 0

    const sel = page.match(/<select id="fmt-select"[\s\S]*?<\/select>/)
    const body = sel ? sel[0] : page
    const opts = []
    const seen = new Set()
    let group = ''
    const rx = /<optgroup label="([^"]*)"|<option\s([^>]*?data-force[^>]*)>/g
    for (const m of body.matchAll(rx)) {
      if (m[1] !== undefined) { group = unescapeHtml(m[1]); continue }
      const attrs = {}
      for (const a of m[2].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = unescapeHtml(a[2])
      const no = attrs.value || ''
      if (!no || seen.has(no)) continue
      seen.add(no)
      const force = attrs['data-force'] || ''
      const tg = (force.match(/[?&]tg=([^&]+)/) || [])[1] || ''
      const label = attrs['data-label'] || ''
      const ext = attrs['data-ext'] || ''
      const g = group.match(/Audio\s*·\s*(.+)$/)
      const lang = g && attrs['data-kind'] === 'audio-only' && !attrs['data-mp3'] ? g[1].trim() : ''
      const rm = label.match(/^(\d+)p(\d+)?/)
      const codec = label.includes('AV1') ? 'AV1'
        : rm && ext === 'webm' ? 'VP9'
        : rm ? 'H.264'
        : label.includes('Opus') ? 'Opus'
        : label.includes('M4A') ? 'AAC'
        : label.includes('MP3') ? 'MP3'
        : ''
      opts.push({
        no,
        label,
        kind: attrs['data-kind'] || '',
        ext,
        size: attrs['data-size'] || '',
        bytes: Number(attrs['data-bytes'] || 0) || 0,
        group,
        force,
        itag: tg.split('.')[0],
        lang,
        mp3: attrs['data-mp3'] || '',
        src: attrs['data-src'] || '',
        recommended: attrs['data-recommended'] === '1',
        res: rm ? Number(rm[1]) : 0,
        fps: rm ? (rm[2] ? Number(rm[2]) : 30) : 0,
        codec,
        isVideo: false,
        isAudio: false,
      })
      const o = opts[opts.length - 1]
      o.isVideo = o.kind === 'video-only' || o.kind === 'video+audio'
      o.isAudio = o.kind === 'audio-only' && !o.mp3
    }

    let hosts = {}
    const hm = page.match(/var VD_HOSTS\s*=\s*(\{[\s\S]*?\});/)
    if (hm) {
      try { for (const [k, h] of Object.entries(JSON.parse(hm[1]))) if (h) hosts[k] = h } catch {}
    }

    let mux = {}
    const mm = page.match(/<a id="merge-link"([^>]*)>/)
    if (mm) {
      for (const a of mm[1].matchAll(/(data-\w+)="([^"]*)"/g)) mux[a[1].slice(5)] = unescapeHtml(a[2])
    }
    const muxMaxM = page.match(/var MUX_MAX\s*=\s*(\d+)/)

    return {
      title,
      channel,
      duration,
      secs,
      vid,
      preview,
      thumbs,
      options: opts,
      hosts,
      mux,
      muxMax: muxMaxM ? Number(muxMaxM[1]) : 3221225472,
    }
  }

  // ------------------------------------------------------------- jalur/race
  static vtype(o) {
    if (o.kind === 'audio-only') return o.mp3 ? 'mp3_source' : 'audio'
    return o.bytes > 300 * 1048576 ? 'big_file' : 'single'
  }

  static country(info) {
    for (const h of Object.values(info.hosts || {})) {
      const parts = String(h?.vt || '').split('.')
      if (parts.length >= 3 && /^[a-z]+$/i.test(parts[1])) return parts[1].toUpperCase()
    }
    return 'XX'
  }

  rkey(info, hn) { return `${hn}@${SnapYT.country(info)}` }

  _url(opt, h, px, did, tried, refresh) {
    const q = { did, stream: 1, busy_ok: 1, px }
    if (refresh) q.refresh = 1
    if (tried?.length && px === 'auto') q.tried = tried.join(',')
    let url = `${opt.force}&${new URLSearchParams(q).toString()}`
    if (h) url = url.split(AJAX).join(h.u) + `&vt=${h.vt}`
    return url
  }

  async ping(h, info) {
    if (!h) return false
    if (!this._ping.has(h.n)) {
      let ok = false
      try {
        const res = await this._request(`${h.u}?action=vd_node_ping`, {
          headers: { Origin: BASE, Referer: this.referer },
          timeout: 4000,
        })
        ok = res.ok && (await res.json().catch(() => null))?.ok === 1
      } catch {}
      this._ping.set(h.n, ok)
      dbg('ping', h.n, ok)
    }
    return this._ping.get(h.n)
  }

  async _try(info, opt, cand, did, tried, rng) {
    const { h, px, refresh } = cand
    const hn = h ? h.n : 'www'
    const res = { h, hn, px, refresh, ok: false, url: '', route: '', why: '', st: 0 }
    const headers = { Referer: this.referer }
    if (h) headers.Origin = BASE
    if (rng) headers.Range = rng
    const url = res.url = this._url(opt, h, px, did, tried, refresh)
    const t0 = Date.now()
    try {
      const r = await this._request(url, { headers, timeout: rng && rng !== 'bytes=0-0' ? 60000 : 15000 })
      const ctype = r.headers.get('content-type') || ''
      res.st = r.status
      res.route = r.headers.get('x-vd-route') || ''
      res.ok = (r.status === 200 || r.status === 206)
        && !ctype.includes('json') && !ctype.includes('text/html')
      if (!res.ok) {
        res.why = r.headers.get('x-vd-why') || r.headers.get('x-vd-fail')
          || ([502, 504, 522, 524].includes(r.status) ? 'timeout server' : '')
        if (!res.why) {
          const body = await Promise.race([this._text(r), new Promise(rs => setTimeout(() => rs(''), 3000))])
          res.why = String(body).slice(0, 40).trim()
        }
        if (!res.why) res.why = `HTTP ${r.status}`
      }
      if (r.body) { try { r.body.cancel() } catch {} }
    } catch (err) {
      res.why = err?.name === 'TimeoutError' ? 'timeout' : String(err?.cause?.code || err?.message || err).slice(0, 40)
    }
    dbg('req', res.ok ? 'OK' : 'FAIL', `fmt=${opt.no}`, `host=${hn}`, `px=${px}`, `st=${res.st}`, `route=${res.route}`, `why=${res.why}`, `${Date.now() - t0}ms`)

    const key = this.rkey(info, hn)
    const pinned = /^\d+$/.test(String(px)) ? String(px) : ''
    const dead = res.why === 'no_route' || res.why === 'Route unavailable'
    if (pinned && res.route && res.route !== pinned) ROUTES.mark(key, pinned, false, true)
    if (res.ok) ROUTES.mark(key, res.route || pinned, true)
    else ROUTES.mark(key, res.route || pinned, false, dead)
    return res
  }

  async _wave(info, opt, n, used, waveNo) {
    const hHost = info.hosts[SnapYT.vtype(opt)]
    const h = hHost && (await this.ping(hHost, info)) ? hHost : null
    const cands = []
    for (const r of ROUTES.best(this.rkey(info, 'www'), 3, [...(used.www || [])])) {
      cands.push({ h: null, px: r, refresh: false })
    }
    if (h) {
      for (const r of ROUTES.best(this.rkey(info, h.n), 1, [...(used[h.n] || [])])) {
        cands.push({ h, px: r, refresh: false })
      }
    }
    cands.length = Math.min(cands.length, Math.max(1, n - 2))
    cands.push({ h: null, px: 'auto', refresh: false })
    if (h) cands.push({ h, px: 'auto', refresh: false })
    if (waveNo >= 2) cands.push({ h: null, px: 'auto', refresh: true })
    while (cands.length < n) cands.push({ h: null, px: 'auto', refresh: false })
    return cands.slice(0, n)
  }

  /**
   * Balapan jalur kayak open_stream di api.py, tapi balikin konteks URL
   * (bukan stream) biar /api/stream bisa nyulang request-nya.
   */
  async openStream(info, opt, { onRetry } = {}) {
    const width = this.race
    const did = randomHex(8)
    const used = {}
    const tried = {}
    let sent = 0
    let last = ''
    let waveNo = 0
    const budget = Math.max(this.retries, width)

    while (sent < budget) {
      waveNo++
      const cands = await this._wave(info, opt, Math.min(width, budget - sent), used, waveNo)
      dbg('race', `ronde ${waveNo}`, opt.no, cands.map(c => `${c.h?.n || 'www'}:${c.px}${c.refresh ? '+refresh' : ''}`).join(' '))
      if (onRetry && waveNo > 1) onRetry(sent, 'race', '-', `ronde ${waveNo} · ${cands.length} jalur paralel`)

      const results = await Promise.all(cands.map(async c => {
        const hn = c.h?.n || 'www'
        try {
          return await this._try(info, opt, c, did, tried[hn], 'bytes=0-0')
        } catch (err) {
          return { hn, px: c.px, refresh: c.refresh, ok: false, route: '', why: String(err?.message || err).slice(0, 40), st: 0 }
        }
      }))
      sent += results.length

      let winner = null
      for (const res of results) {
        used[res.hn] ||= new Set()
        used[res.hn].add(String(res.px))
        if (!res.ok) {
          last = `${res.hn} ${res.st} ${res.why}`
          if (res.route && res.px === 'auto') {
            (tried[res.hn] ||= []).push(res.route)
          }
        } else if (!winner) winner = res
      }

      if (!winner) {
        dbg('race', `ronde ${waveNo} gagal semua`, last)
        if (onRetry) onRetry(sent, 'race', '-', `ronde ${waveNo} gagal (${last})`)
        continue
      }

      const px = winner.route || winner.px
      for (let attempt = 0; attempt < 2; attempt++) {
        sent++
        const res = await this._try(info, opt, { h: winner.h, px, refresh: winner.refresh && attempt === 0 }, did, null, 'bytes=0-65535')
        if (res.ok) {
          const via = `${res.hn} ${res.route ? `route ${res.route}` : 'cache'}`
          return {
            ok: true,
            url: res.url,
            referer: this.referer,
            cookie: this.jar.header(),
            route: res.route || px,
            hn: res.hn,
            did,
            waveNo,
            via: via + (sent > 1 ? ` · ${sent} req` : ''),
          }
        }
        last = `${res.hn} ${res.st} ${res.why}`
      }
    }
    throw new Error(`gak nemu jalur download (${last})`)
  }

  // ------------------------------------------------------------- server merge
  async serverMerge(info, vo, ao, { onStatus, deadlineMs = 240000 } = {}) {
    const mux = info.mux
    if (!mux.pid || !mux.nonce) throw new Error('server merge gak tersedia')
    if (vo.bytes + ao.bytes > info.muxMax) throw new Error('kegedean buat server merge')
    const deadline = Date.now() + deadlineMs

    const hHost = info.hosts.merge
    const h = hHost && (await this.ping(hHost, info)) ? hHost : null
    const plan = ROUTES.best(this.rkey(info, 'www'), 2).map(r => ({ host: null, refresh: false, px: r }))
    if (h) plan.push({ host: h, refresh: false, px: 'auto' })
    plan.push({ host: null, refresh: false, px: 'auto' })
    plan.push({ host: null, refresh: true, px: 'auto' })

    const did = randomHex(8)
    const tried = {}
    const whys = []
    const hdr = { Origin: BASE, Referer: this.referer }

    for (const step of plan) {
      const hn = step.host?.n || 'www'
      const body = {
        action: 'vd_mux_start',
        pid: mux.pid,
        v: vo.no,
        a: ao.no,
        nonce: mux.nonce,
        px: step.px,
        sid: randomHex(8),
        did,
      }
      if (tried[hn]?.length && step.px === 'auto') body.tried = tried[hn].join(',')
      if (step.refresh) {
        body.refresh = '1'
        if (whys.length) body.fk = whys.join('|').slice(0, 300)
      }
      if (step.host) body.vt = step.host.vt
      const url = step.host ? step.host.u : (mux.admin || AJAX)
      const tag = `${hn}${step.px !== 'auto' ? ` route ${step.px}` : ''}${step.refresh ? ' refresh' : ''}`

      onStatus?.(`Server merge · start job (${tag})`)
      let data = null
      const t0 = Date.now()
      for (;;) {
        let j = null
        try {
          const r = await this._request(url, { method: 'POST', data: body, headers: hdr, timeout: 40000 })
          j = await r.json().catch(() => null)
        } catch (err) {
          dbg('mux', 'start error', String(err?.message || err))
          whys.push(`${hn}:start_${err?.name || 'Error'}`)
          break
        }
        data = j?.data || {}
        dbg('mux', 'jawaban start', j?.success, JSON.stringify(data).slice(0, 400))
        if (j?.success && data.status_url) break
        if (data.retry_in && Date.now() - t0 < 60000) {
          onStatus?.(`Server merge antre (${tag}) · nunggu ${data.retry_in}s`)
          await new Promise(r => setTimeout(r, Math.max(1, Math.min(10, Number(data.retry_in))) * 1000))
          continue
        }
        whys.push(`${hn}:start_refused`)
        onStatus?.(`Start ditolak (${tag}) · ${data.message || 'gak jelas'}`)
        if (data.blocked || data.too_big || data.give_up) throw new Error(`server merge nolak: ${data.message || 'refused'}`)
        data = null
        break
      }
      if (!data) continue
      if (data.px_used != null) (tried[hn] ||= []).push(String(data.px_used))

      let st = data
      if (st.status !== 'done') {
        const interval = Math.max(1, (data.poll_interval || 2500) / 1000)
        let badSince = 0
        for (;;) {
          if (Date.now() > deadline) throw new Error('server merge belum selesai (timeout) — coba resolusi lebih rendah')
          await new Promise(r => setTimeout(r, interval * 1000))
          try {
            const rr = await this._request(data.status_url, { headers: hdr, timeout: 20000 })
            st = (await rr.json().catch(() => null))?.data || {}
            badSince = 0
          } catch {
            badSince ||= Date.now()
            if (Date.now() - badSince > 180000) { st = { status: 'error', why: 'status_unreadable' }; break }
            continue
          }
          const pct = Math.max(0, Math.min(100, Number(st.percent) || 0))
          onStatus?.(`Server merge ${pct}% · ${hms(st.elapsed_sec || 0)}${st.message ? ` · ${st.message}` : ''}`)
          if (['done', 'error', 'canceled'].includes(st.status)) break
        }
      }
      ROUTES.mark(this.rkey(info, hn), st.px_used ?? data.px_used, st.status === 'done')
      if (st.status !== 'done') {
        const why = st.why || st.fail_reason || 'failed'
        dbg('mux', 'gagal', tag, why)
        whys.push(`${hn}/${st.px_used ?? '?'}:${why}`)
        onStatus?.(`Server merge gagal (${tag}) · ${why} → coba lagi`)
        continue
      }
      const dl = st.download_url || data.download_url
      if (!dl) { whys.push(`${hn}:no_download_url`); continue }
      const sep = dl.includes('?') ? '&' : '?'
      return {
        ok: true,
        url: `${dl}${sep}did=${did}`,
        referer: this.referer,
        cookie: this.jar.header(),
        via: `server merge · ${hn}`,
      }
    }
    throw new Error(`server merge gagal: ${whys.join(' | ') || 'semua jalur ditolak'}`)
  }
}

// ------------------------------------------------------------- pilihan format
const CODEC_RANK = { 'H.264': 3, VP9: 2, AV1: 1 }

export function bestVideo(info) {
  return info.options
    .filter(o => o.isVideo)
    .sort((a, b) => (b.res - a.res) || (b.fps - a.fps) || (CODEC_RANK[b.codec] || 0) - (CODEC_RANK[a.codec] || 0))[0]
}

export function bestAudio(info, preferExt = 'mp4', lang = null) {
  const aud = info.options.filter(o => o.isAudio)
  if (!aud.length) return null
  let pool = lang
    ? (aud.filter(o => o.lang.toLowerCase().includes(lang.toLowerCase()))).length
      ? aud.filter(o => o.lang.toLowerCase().includes(lang.toLowerCase()))
      : aud
    : (aud.filter(o => o.lang.toLowerCase().includes('original'))).length
      ? aud.filter(o => o.lang.toLowerCase().includes('original'))
      : aud
  const want = preferExt === 'mp4' ? 'm4a' : 'opus'
  const cand = pool.filter(o => o.ext === want)
  if (cand.length) pool = cand
  return pool.sort((a, b) => b.bytes - a.bytes)[0]
}

export const LANG_ALIAS = {
  id: 'indonesian', en: 'english', ja: 'japanese', es: 'spanish', pt: 'portuguese',
  fr: 'french', de: 'german', hi: 'hindi', ko: 'korean', ar: 'arabic',
}

export function resolveAudio(info, spec, vo) {
  if (!spec || ['auto', 'best'].includes(spec)) return bestAudio(info, vo.ext)
  const o = info.options.find(x => x.no === spec)
  if (o && o.isAudio) return o
  return bestAudio(info, vo.ext, LANG_ALIAS[spec.toLowerCase()] || spec)
}

/**
 * Petahkan format/kualitas ala web (mp3/mp4/m4a/opus + kualitas) ke opsi snapyt.
 * Prioritas mp4: video+audio pas resolusi -> video-only pas + server merge -> terdekat.
 */
export function pickOption(info, format, quality) {
  const opts = info.options
  if (format === 'mp3') {
    const pool = opts.filter(o => o.mp3)
    if (!pool.length) throw new Error('MP3 gak tersedia buat video ini (coba M4A/OPUS)')
    const target = Number(quality) || 320
    return pool.sort((a, b) =>
      Math.abs(Number(a.mp3) - target) - Math.abs(Number(b.mp3) - target)
      || Number(b.mp3) - Number(a.mp3))[0]
  }
  if (format === 'm4a' || format === 'opus') {
    const wantExt = format === 'm4a' ? 'm4a' : 'opus'
    const aud = opts.filter(o => o.kind === 'audio-only' && !o.mp3)
    if (!aud.length) throw new Error(`Audio ${format.toUpperCase()} gak tersedia buat video ini`)
    const pool = aud.filter(o => o.ext === wantExt)
    return (pool.length ? pool : aud).sort((a, b) => b.bytes - a.bytes)[0]
  }
  // mp4
  const res = Number(quality) || 1080
  const va = opts.filter(o => o.kind === 'video+audio')
  const exact = va.filter(o => o.res === res)
    .sort((a, b) => (b.fps - a.fps) || (CODEC_RANK[b.codec] || 0) - (CODEC_RANK[a.codec] || 0))[0]
  if (exact) return { option: exact, mode: 'single' }
  const voOnly = opts.filter(o => o.kind === 'video-only' && o.res === res)
    .sort((a, b) => (b.fps - a.fps) || (CODEC_RANK[b.codec] || 0) - (CODEC_RANK[a.codec] || 0))
  if (voOnly.length) {
    const ao = bestAudio(info, voOnly[0].ext)
    if (ao) return { option: voOnly[0], mode: 'mux', audio: ao }
  }
  if (va.length) {
    const below = va.filter(o => o.res <= res).sort((a, b) => b.res - a.res)[0] || va.sort((a, b) => a.res - b.res)[0]
    return { option: below, mode: 'single', degraded: true }
  }
  const anyVideo = bestVideo(info)
  if (!anyVideo) throw new Error('gak ada opsi video buat video ini')
  return { option: anyVideo, mode: 'single', degraded: true }
}

export function outName(info, o, ao, ext) {
  const lang = ao?.lang ? `-${ao.lang.split(/\s+/)[0].replace(/\W/g, '').slice(0, 10)}` : ''
  return `${safeName(info.title)} [${tagLabel(o.label)}${lang}].${ext}`
}
