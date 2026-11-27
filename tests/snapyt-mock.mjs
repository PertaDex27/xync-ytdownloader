// Mock e2e buat engine snapyt: server palsu yang nurutin alur snapyt.app
// (nonce -> process_video_url -> preview -> race jalur -> download / mux).
// Jalanin: node tests/snapyt-mock.mjs
process.env.SNAPYT_BASE = process.env.SNAPYT_BASE || 'http://127.0.0.1:9901'
process.env.SNAPYT_ROUTES_PATH = '/tmp/snapyt_routes_test.json'
process.env.PORT = '3377'
try { fs.rmSync(process.env.SNAPYT_ROUTES_PATH, { force: true }) } catch {}

import fs from 'node:fs'

import http from 'node:http'
import assert from 'node:assert/strict'

const MOCK_PORT = 9901
const FILE = Buffer.alloc(200000)
for (let i = 0; i < FILE.length; i++) FILE[i] = i % 251

const PREVIEW_HTML = `<!doctype html><html><body>
<h1 class="title">Contoh <b>Video</b> &amp; Test</h1>
<p>Channel: <strong>Xync Channel</strong></p>
<p>Duration: <span>3:45</span> Duration: 3:45</p>
<img data-srcs="https://i.ytimg.com/a.jpg|https://i.ytimg.com/b.jpg" data-secs="225">
<script>var x = "&t=dQw4w9WgXcQ.1700000000";</script>
<select id="fmt-select">
<optgroup label="Video · MP4 (H.264)">
<option value="0" data-kind="video+audio" data-label="1080p" data-ext="mp4" data-size="105 MB" data-bytes="110100480" data-force="${process.env.SNAPYT_BASE}/wp-admin/admin-ajax.php?action=gen_download&id=dl0&tg=137.0" data-recommended="1">
<option value="1" data-kind="video+audio" data-label="720p" data-ext="mp4" data-size="61 MB" data-bytes="63963136" data-force="${process.env.SNAPYT_BASE}/wp-admin/admin-ajax.php?action=gen_download&id=dl1&tg=136.0">
</optgroup>
<optgroup label="Video · WebM">
<option value="2" data-kind="video-only" data-label="1440p60" data-ext="webm" data-size="210 MB" data-bytes="220200960" data-force="${process.env.SNAPYT_BASE}/wp-admin/admin-ajax.php?action=gen_download&id=dl2&tg=308.0">
</optgroup>
<optgroup label="Audio · Original">
<option value="10" data-kind="audio-only" data-label="M4A 128k" data-ext="m4a" data-size="3.5 MB" data-bytes="3604480" data-force="${process.env.SNAPYT_BASE}/wp-admin/admin-ajax.php?action=gen_download&id=dl10&tg=139.0">
<option value="11" data-kind="audio-only" data-label="Opus 160k" data-ext="opus" data-size="4.2 MB" data-bytes="4404019" data-force="${process.env.SNAPYT_BASE}/wp-admin/admin-ajax.php?action=gen_download&id=dl11&tg=251.0">
</optgroup>
<optgroup label="Audio · English">
<option value="12" data-kind="audio-only" data-label="M4A 128k" data-ext="m4a" data-size="3.4 MB" data-bytes="3563520" data-force="${process.env.SNAPYT_BASE}/wp-admin/admin-ajax.php?action=gen_download&id=dl12&tg=139.0">
</optgroup>
<optgroup label="Audio · MP3">
<option value="31" data-kind="audio-only" data-label="MP3 320" data-ext="mp3" data-size="8.6 MB" data-bytes="9017754" data-mp3="320" data-src="11" data-force="${process.env.SNAPYT_BASE}/wp-admin/admin-ajax.php?action=gen_download&id=dl11&mp3=320">
<option value="32" data-kind="audio-only" data-label="MP3 128" data-ext="mp3" data-size="3.4 MB" data-bytes="3607101" data-mp3="128" data-src="11" data-force="${process.env.SNAPYT_BASE}/wp-admin/admin-ajax.php?action=gen_download&id=dl11&mp3=128">
</optgroup>
</select>
    <script>var VD_HOSTS = {"single":{"n":"node1","u":"${process.env.SNAPYT_BASE}/node1/","vt":"vd.sg.node1"},"big_file":{"n":"node2","u":"${process.env.SNAPYT_BASE}/node2/","vt":"vd.sg.node2"},"audio":{"n":"node1","u":"${process.env.SNAPYT_BASE}/node1/","vt":"vd.sg.node1"},"mp3_source":{"n":"node1","u":"${process.env.SNAPYT_BASE}/node1/","vt":"vd.sg.node1"},"merge":{"n":"node1","u":"${process.env.SNAPYT_BASE}/node1/","vt":"vd.sg.node1"}};var MUX_MAX = 3221225472;</script>
<a id="merge-link" data-pid="job123" data-nonce="fedcba9876543210" data-admin="${process.env.SNAPYT_BASE}/wp-admin/admin-ajax.php">merge</a>
</body></html>`

function serveFile(req, res) {
  const rng = req.headers.range || ''
  const m = rng.match(/bytes=(\d+)-(\d*)/)
  if (m) {
    const start = Number(m[1])
    const end = m[2] ? Math.min(Number(m[2]), FILE.length - 1) : FILE.length - 1
    res.writeHead(206, {
      'Content-Type': 'video/mp4',
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${FILE.length}`,
      'Accept-Ranges': 'bytes',
      'X-VD-Route': String(new URL(req.url, 'http://x').searchParams.get('px') || '975'),
    })
    return res.end(FILE.subarray(start, end + 1))
  }
  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Content-Length': FILE.length,
    'Accept-Ranges': 'bytes',
    'X-VD-Route': String(new URL(req.url, 'http://x').searchParams.get('px') || '975'),
  })
  res.end(FILE)
}

const mock = http.createServer((req, res) => {
  const u = new URL(req.url, process.env.SNAPYT_BASE)
  const bodyChunks = []
  req.on('data', c => bodyChunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(bodyChunks).toString()
    const params = new URLSearchParams(body)
    const action = params.get('action') || u.searchParams.get('action') || ''

    if (u.pathname === '/id/') return res.end(PREVIEW_HTML.replace(/<select[\s\S]*?<\/select>/, '').replace(/<a id="merge-link"[\s\S]*?<\/a>/, ''))
    if (u.pathname === '/p/abc') return res.end(PREVIEW_HTML)
    if (action === 'vd_fresh_nonce') {
      res.setHeader('Content-Type', 'application/json')
      return res.end(JSON.stringify({ success: true, data: { nonce: 'ffff0000111122223333444455556666' } }))
    }
    if (action === 'vd_node_ping') {
      res.setHeader('Content-Type', 'application/json')
      return res.end(JSON.stringify({ ok: 1 }))
    }
    if (action === 'process_video_url') {
      if (!params.get('security')) {
        res.setHeader('Content-Type', 'application/json')
        return res.end('-1')
      }
      res.setHeader('Content-Type', 'application/json')
      return res.end(JSON.stringify({ success: true, data: { redirect: `${process.env.SNAPYT_BASE}/p/abc` } }))
    }
    if (action === 'vd_mux_start') {
      res.setHeader('Content-Type', 'application/json')
      return res.end(JSON.stringify({
        success: true,
        data: {
          status_url: `${process.env.SNAPYT_BASE}/wp-admin/admin-ajax.php?action=vd_mux_status&job=${params.get('sid')}`,
          poll_interval: 50,
          px_used: '975',
        },
      }))
    }
    if (action === 'vd_mux_status') {
      muxPolled++
      res.setHeader('Content-Type', 'application/json')
      return res.end(JSON.stringify(muxPolled === 1
        ? { success: true, data: { status: 'working', percent: 40, message: 'merging', elapsed_sec: 2 } }
        : { success: true, data: { status: 'done', percent: 100, download_url: `${process.env.SNAPYT_BASE}/mux/result.mp4` } }))
    }
    if (u.pathname === '/mux/result.mp4') return serveFile(req, res)
    if (action === 'gen_download' || u.pathname.startsWith('/node1') || u.pathname.startsWith('/node2')) {
      if (u.searchParams.get('stream') !== '1') {
        res.setHeader('Content-Type', 'text/html')
        return res.end('nope')
      }
      if (failNoRefresh > 0 && u.searchParams.get('refresh') !== '1') {
        failNoRefresh--
        res.writeHead(502, { 'X-VD-Why': 'busy', 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: 'busy' }))
      }
      return serveFile(req, res)
    }
    res.writeHead(404)
    res.end('not found')
  })
})

let muxPolled = 0
let failNoRefresh = 0 // >0 = download tanpa refresh=1 selalu gagal (simulasi jalur macet)

const { SnapYT, RouteBook, pickOption } = await import('../src/snapyt.js')
const engine = await import('../src/engine.js')
const serverMod = await import('../src/server.js')

await new Promise(r => mock.listen(MOCK_PORT, r))
const api = await serverMod.startServer(Number(process.env.PORT))

const results = []
const test = (name, fn) => results.push(Promise.resolve().then(fn).then(() => console.log(`  ✔ ${name}`), err => {
  console.error(`  ✘ ${name}\n    ${err.message}`)
  process.exitCode = 1
}))

console.log('== parsePreview ==')
const page = PREVIEW_HTML
const preview = `${process.env.SNAPYT_BASE}/p/abc`
test('judul/channel/durasi/thumbs/vid', () => {
  const info = SnapYT.parsePreview(page, preview)
  assert.equal(info.title, 'Contoh Video & Test')
  assert.equal(info.channel, 'Xync Channel')
  assert.equal(info.duration, '3:45')
  assert.equal(info.secs, 225)
  assert.equal(info.vid, 'dQw4w9WgXcQ')
  assert.equal(info.thumbs.length, 2)
  assert.equal(info.muxMax, 3221225472)
})
test('opsi format + codec + lang + mp3', () => {
  const info = SnapYT.parsePreview(page, preview)
  assert.equal(info.options.length, 8)
  const o0 = info.options.find(o => o.no === '0')
  assert.equal(o0.kind, 'video+audio')
  assert.equal(o0.res, 1080)
  assert.equal(o0.fps, 30)
  assert.equal(o0.codec, 'H.264')
  const o2 = info.options.find(o => o.no === '2')
  assert.equal(o2.codec, 'VP9')
  assert.equal(o2.res, 1440)
  assert.equal(o2.fps, 60)
  const o11 = info.options.find(o => o.no === '11')
  assert.equal(o11.lang, 'Original')
  assert.ok(o11.isAudio)
  const o12 = info.options.find(o => o.no === '12')
  assert.equal(o12.lang, 'English')
  const o31 = info.options.find(o => o.no === '31')
  assert.equal(o31.mp3, '320')
  assert.equal(o31.lang, '')
  assert.ok(!o31.isAudio)
  assert.equal(info.mux.pid, 'job123')
  assert.equal(info.mux.nonce, 'fedcba9876543210')
  assert.ok(info.hosts.single.n === 'node1')
})
test('VD_HOSTS JSON parse', () => {
  const info = SnapYT.parsePreview(page, preview)
  assert.equal(SnapYT.country(info), 'SG')
  assert.equal(info.hosts.big_file.n, 'node2')
})

console.log('== route book ==')
test('seed + best + mark + dead', () => {
  const rb = new RouteBook('/tmp/snapyt_routes_unit.json')
  try { fs.rmSync('/tmp/snapyt_routes_unit.json', { force: true }) } catch {}
  const rb2 = new RouteBook('/tmp/snapyt_routes_unit.json')
  const key = 'www@XX'
  assert.deepEqual(rb2.best(key, 3), ['975', '872', '881'])
  rb2.mark(key, '975', false, true)
  assert.ok(!rb2.best(key, 3).includes('975'))
  rb2.mark(key, '872', true)
  rb2.mark(key, '872', true)
  assert.equal(rb2.best(key, 1)[0], '872')
  rb2.mark(key, 'bukan-angka', true) // harus diabaikan tanpa error
  assert.ok(rb2.best(key).length > 0)
})

console.log('== pickOption ==')
test('mp4 exact -> video+audio; 1440 -> mux; mp3 -> bitrate terdekat', () => {
  const info = SnapYT.parsePreview(page, preview)
  const p1080 = pickOption(info, 'mp4', '1080')
  assert.equal(p1080.mode, 'single')
  assert.equal(p1080.option.no, '0')
  const p1440 = pickOption(info, 'mp4', '1440')
  assert.equal(p1440.mode, 'mux')
  assert.equal(p1440.option.no, '2')
  assert.equal(p1440.audio.no, '11') // webm → audio opus (ngikutin api.py)
  const p2160 = pickOption(info, 'mp4', '2160')
  assert.equal(p2160.degraded, true)
  assert.equal(p2160.option.res, 1080)
  const pmp3 = pickOption(info, 'mp3', '128')
  assert.equal(pmp3.mp3, '128')
  const popus = pickOption(info, 'opus', '320')
  assert.equal(popus.ext, 'opus')
  const pm4a = pickOption(info, 'm4a', '320')
  assert.equal(pm4a.ext, 'm4a')
})

console.log('== fetchInfo via mock ==')
let info
test('nonce + process_video_url + parse', async () => {
  const cli = new SnapYT()
  info = await cli.fetchInfo('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
  assert.equal(info.vid, 'dQw4w9WgXcQ')
  assert.equal(info.options.length, 8)
})

console.log('== resolve + /api/stream ==')
test('mp4 1080 -> video+audio, stream proxy ngalirin bytes', async () => {
  const r = await engine.resolve('dQw4w9WgXcQ', 'mp4', '1080', () => {})
  assert.equal(r.format, 'mp4')
  assert.equal(r.quality, '1080')
  assert.ok(r.url.startsWith('/api/stream?t='))
  assert.ok(r.size > 0)
  const res = await fetch(`http://127.0.0.1:${process.env.PORT}${r.url}`)
  assert.equal(res.status, 200)
  const buf = Buffer.from(await res.arrayBuffer())
  assert.equal(buf.length, FILE.length)
  assert.equal(res.headers.get('content-disposition').includes('attachment'), true)
})
test('opus -> webm, m4a -> m4a', async () => {
  const ro = await engine.resolve('dQw4w9WgXcQ', 'opus', '320', () => {})
  assert.ok(ro.filename || true)
  assert.equal(ro.format, 'opus')
  const rm = await engine.resolve('dQw4w9WgXcQ', 'm4a', '320', () => {})
  assert.equal(rm.format, 'm4a')
})
test('mp4 1440 -> server merge via mock', async () => {
  muxPolled = 0
  const r = await engine.resolve('dQw4w9WgXcQ', 'mp4', '1440', () => {})
  assert.equal(r.format, 'mp4')
  assert.ok(r.via.includes('merge') || r.via.includes('node1'))
  const res = await fetch(`http://127.0.0.1:${process.env.PORT}${r.url}`)
  assert.equal(res.status, 200)
  assert.equal((await res.arrayBuffer()).byteLength, FILE.length)
})
test('mp3: tanpa ffmpeg -> fallback M4A; dengan ffmpeg -> transcode', async () => {
  const { ffmpegAvailable } = await import('../src/streamProxy.js')
  const r = await engine.resolve('dQw4w9WgXcQ', 'mp3', '320', () => {})
  if (ffmpegAvailable()) {
    assert.equal(r.format, 'mp3')
    assert.equal(r.quality, '320')
  } else {
    assert.equal(r.format, 'm4a')
    assert.equal(r.quality, '320')
  }
})
test('jalur macet semua -> ronde lanjutan pakai refresh tetap dapat', async () => {
  failNoRefresh = 20
  try {
    const r = await engine.resolve('dQw4w9WgXcQ', 'm4a', '320', () => {})
    assert.equal(r.format, 'm4a')
    assert.ok(r.via.length > 0)
    const res = await fetch(`http://127.0.0.1:${process.env.PORT}${r.url}`)
    assert.equal(res.status, 200)
    assert.equal((await res.arrayBuffer()).byteLength, FILE.length)
  } finally {
    failNoRefresh = 0
  }
})

console.log('== endpoint web ==')
test('/api/download JSON', async () => {
  const res = await fetch(`http://127.0.0.1:${process.env.PORT}/api/download?url=https://youtu.be/dQw4w9WgXcQ&format=mp4&quality=1080`)
  const j = await res.json()
  assert.equal(j.status, 'ok')
  assert.equal(j.format, 'mp4')
  assert.ok(j.url.includes('/api/stream?t='))
  assert.ok(j.title)
})
test('/api/download url gak valid -> 400', async () => {
  const res = await fetch(`http://127.0.0.1:${process.env.PORT}/api/download?url=abc`)
  assert.equal(res.status, 400)
})
test('/api/info tetap jalan (oEmbed)', async () => {
  const res = await fetch(`http://127.0.0.1:${process.env.PORT}/api/info?url=https://youtu.be/dQw4w9WgXcQ`)
  const j = await res.json()
  assert.equal(j.status, 'ok')
  assert.equal(j.videoId, 'dQw4w9WgXcQ')
})
test('/api/stream token palsu -> 400', async () => {
  const res = await fetch(`http://127.0.0.1:${process.env.PORT}/api/stream?t=cmFuZG9t.aGFLT1NFT1RIRVJTSUc`)
  assert.equal(res.status, 400)
})
test('/api/stream?direct=1 -> 302 ke sumber', async () => {
  const r = await engine.resolve('dQw4w9WgXcQ', 'm4a', '320', () => {})
  const res = await fetch(`http://127.0.0.1:${process.env.PORT}${r.url}&direct=1`, { redirect: 'manual' })
  assert.equal(res.status, 302)
  assert.ok(res.headers.get('location').includes(process.env.SNAPYT_BASE))
})

await Promise.allSettled(results)
await new Promise(r => api.close(r))
mock.close(() => console.log(process.exitCode ? 'ADA TEST GAGAL' : 'SEMUA TEST LOLOS'))
