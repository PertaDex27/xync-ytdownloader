// xync-proxy — Cloudflare Worker buat nerusin request Vercel -> snapyt.app
// biar yang nembak snapyt itu IP Cloudflare, bukan IP AWS-nya Vercel.
//
// Setup (dashboard Cloudflare):
//   1. Workers & Pages -> Create -> Worker -> paste file ini -> Deploy
//   2. Settings -> Variables and Secrets -> tambah SECRET:  XYNC_KEY = <string acak panjang>
//      (opsional) ALLOWED_HOSTS = snapyt.app   (dipisah koma, subdomain otomatis ikut)
//   3. Cek di browser:  https://<worker-lu>.workers.dev/__test?key=<XYNC_KEY>
//   4. Di Vercel set env:  SNAPYT_WORKER=https://<worker-lu>.workers.dev
//                          SNAPYT_WORKER_KEY=<XYNC_KEY yang sama>   -> Redeploy
//
// Protokol:  <METHOD> https://<worker>/?u=<url target ter-encode>
//            header  x-xync-key: <XYNC_KEY>
// Method, body, dan header diterusin; response (status, header, Set-Cookie, body stream) dibalikin apa adanya.
// Header tambahan di response: x-final-url (URL akhir setelah redirect), x-xync-worker: 1

const DEFAULT_ALLOWED = 'snapyt.app'

// Header yang gak boleh / gak perlu diterusin ke upstream
const DROP = new Set([
  'host', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-connection',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length',
  'x-xync-key', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host',
  'x-real-ip', 'forwarded', 'true-client-ip', 'cdn-loop', 'x-vercel-id',
])

function fail(status, message, extra = {}) {
  return new Response(JSON.stringify({ error: message, ...extra }), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-xync-worker': '1',
      'x-xync-worker-error': '1',
    },
  })
}

function safeEqual(a, b) {
  const enc = new TextEncoder()
  const ba = enc.encode(a)
  const bb = enc.encode(b)
  if (ba.byteLength !== bb.byteLength) return false
  return crypto.subtle.timingSafeEqual(ba, bb)
}

function hostAllowed(host, allowed) {
  host = host.toLowerCase()
  return allowed.some(a => host === a || host.endsWith(`.${a}`))
}

// Cek cepet: worker bisa buka snapyt apa kena challenge Cloudflare juga?
async function selfTest() {
  const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36'
  const started = Date.now()
  try {
    const r = await fetch('https://www.snapyt.app/id/', {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
      },
    })
    const body = await r.text()
    const nonce = /var videoDownloader\s*=\s*\{[^}]*"nonce":"([0-9a-f]+)"/.test(body)
    const challenged = r.headers.get('cf-mitigated') === 'challenge' || /Just a moment|challenge-platform/i.test(body) && !nonce
    return new Response(JSON.stringify({
      ok: r.ok && nonce,
      status: r.status,
      nonceFound: nonce,
      challenged,
      cfRay: r.headers.get('cf-ray'),
      ms: Date.now() - started,
      verdict: r.ok && nonce
        ? 'MANTAP: worker bisa buka snapyt, tinggal set env di Vercel'
        : 'GAGAL: snapyt juga nolak worker ini (kemungkinan challenge Cloudflare ke request Worker)',
    }, null, 2), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
  } catch (err) {
    return fail(502, `selftest gagal: ${err.message}`)
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url)

    if (!env.XYNC_KEY) return fail(500, 'XYNC_KEY belum di-set di Settings -> Variables and Secrets worker')
    const given = req.headers.get('x-xync-key') || url.searchParams.get('key') || ''
    if (!given || !safeEqual(given, env.XYNC_KEY)) return fail(401, 'key salah / gak ada')

    if (url.pathname === '/__test') return selfTest()

    const raw = url.searchParams.get('u')
    if (!raw) return fail(400, 'parameter ?u= (url target) kosong')
    let target
    try { target = new URL(raw) } catch { return fail(400, 'url target gak valid') }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') return fail(400, 'cuma http/https')

    const allowed = String(env.ALLOWED_HOSTS || DEFAULT_ALLOWED)
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    if (!hostAllowed(target.hostname, allowed)) {
      return fail(403, `host ${target.hostname} gak ada di ALLOWED_HOSTS`, { allowed })
    }

    const headers = new Headers()
    for (const [k, v] of req.headers) {
      const lk = k.toLowerCase()
      if (DROP.has(lk) || lk.startsWith('cf-')) continue
      headers.set(k, v)
    }

    const init = { method: req.method, headers, redirect: 'follow' }
    if (req.method !== 'GET' && req.method !== 'HEAD') init.body = await req.arrayBuffer()

    let up
    try {
      up = await fetch(target.toString(), init)
    } catch (err) {
      return fail(502, `worker gak bisa nyambung ke ${target.hostname}: ${err.message}`)
    }

    const out = new Headers(up.headers) // Set-Cookie ganda tetep kebawa
    out.set('x-final-url', up.url || target.toString())
    out.set('x-xync-worker', '1')
    return new Response(up.body, { status: up.status, statusText: up.statusText, headers: out })
  },
}
