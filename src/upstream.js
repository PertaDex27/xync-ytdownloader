// Semua request ke snapyt lewat sini.
// Kalau env SNAPYT_WORKER di-set, request diterusin lewat Cloudflare Worker (worker/xync-proxy.js)
// biar yang nembak snapyt IP Cloudflare, bukan IP server (Vercel/AWS) yang kena challenge.

export function workerConfig() {
  return {
    url: (process.env.SNAPYT_WORKER || '').trim().replace(/\/+$/, ''),
    key: (process.env.SNAPYT_WORKER_KEY || '').trim(),
  }
}

export const usingWorker = () => Boolean(workerConfig().url)

export async function upstreamFetch(url, init = {}) {
  const { url: worker, key } = workerConfig()
  if (!worker) return fetch(url, init)

  const headers = new Headers(init.headers || {})
  headers.set('x-xync-key', key)
  const { dispatcher, ...rest } = init // proxy (SNAPYT_PROXY) gak dipake kalau lewat worker
  const res = await fetch(`${worker}/?u=${encodeURIComponent(url)}`, { ...rest, headers, redirect: 'follow' })

  if (res.headers.get('x-xync-worker-error')) {
    let msg = ''
    try { msg = (await res.json()).error } catch {}
    throw new Error(`worker cloudflare nolak (HTTP ${res.status}): ${msg || 'unknown'} — cek SNAPYT_WORKER / SNAPYT_WORKER_KEY`)
  }
  if (!res.headers.get('x-xync-worker')) {
    throw new Error(`SNAPYT_WORKER (${new URL(worker).host}) bukan worker xync-proxy (HTTP ${res.status})`)
  }

  // biar kode lain tetep lihat URL asli, bukan URL worker
  Object.defineProperty(res, 'url', { value: res.headers.get('x-final-url') || url })
  return res
}
