import crypto from 'node:crypto'
import vm from 'node:vm'
import zlib from 'node:zlib'
import os from 'node:os'
import { Worker } from 'node:worker_threads'

const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36 OPR/102.0.0.0'

const headers = {
  'User-Agent': UA,
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://embed.dlsrv.online',
  'Referer': 'https://embed.dlsrv.online/',
  'sec-ch-ua': '"OperaMobile";v="102", "Opera";v="137", "Chromium";v="152", " Not A;Brand";v="99"',
  'sec-ch-ua-mobile': '?1',
  'sec-ch-ua-platform': '"Android"',
  'Sec-Fetch-Site': 'cross-site',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Dest': 'empty',
}

function fnvHash(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)
  }
  return h >>> 0
}

function prngHex(seed, len) {
  let h = fnvHash(seed)
  let out = ''
  while (out.length < len) {
    h ^= h << 13
    h ^= h >>> 17
    h = (h ^= h << 5) >>> 0
    out += h.toString(16).padStart(8, '0')
  }
  return out.substring(0, len)
}

const hashOneShot = typeof crypto.hash === 'function'
  ? data => crypto.hash('sha256', data, 'buffer')
  : data => crypto.createHash('sha256').update(data).digest()

export function solvePow(salt, target) {
  const bits = 4 * target.length
  const fullBytes = Math.floor(bits / 8)
  const extraBits = bits % 8
  const padded = target.length % 2 === 0 ? target : `${target}0`
  const targetBytes = Buffer.from(padded, 'hex')
  const mask = extraBits > 0 ? (255 << (8 - extraBits)) & 255 : 0
  const saltLen = Buffer.byteLength(salt)
  const buf = Buffer.allocUnsafe(saltLen + 16)
  buf.write(salt, 0, 'ascii')
  for (let nonce = 0; ; nonce++) {
    let p = saltLen
    let n = nonce
    do {
      buf[p++] = 48 + (n % 10)
      n = Math.floor(n / 10)
    } while (n)
    for (let i = saltLen, j = p - 1; i < j; i++, j--) {
      const tmp = buf[i]
      buf[i] = buf[j]
      buf[j] = tmp
    }
    const hash = hashOneShot(buf.subarray(0, p))
    let ok = true
    for (let i = 0; i < fullBytes; i++) {
      if (hash[i] !== targetBytes[i]) { ok = false; break }
    }
    if (ok && extraBits > 0 && (hash[fullBytes] & mask) !== (targetBytes[fullBytes] & mask)) ok = false
    if (ok) return nonce
  }
}

function solveRsw(payload) {
  const N = BigInt(`0x${payload.N}`)
  let n = BigInt(`0x${payload.x}`)
  const rounds = 0 | payload.t
  for (let i = 0; i < rounds; i++) n = (n * n) % N
  return n.toString(16)
}

function makeDomStub() {
  const el = () => {
    const node = {
      children: [],
      parentNode: null,
      style: {},
      _text: '',
      get innerText() { return this._text },
      set innerText(v) { this._text = String(v) },
      appendChild(child) {
        child.parentNode = this
        this.children.push(child)
        return child
      },
      removeChild(child) {
        const i = this.children.indexOf(child)
        if (i >= 0) this.children.splice(i, 1)
        child.parentNode = null
        return child
      },
      get lastElementChild() { return this.children[this.children.length - 1] || null },
    }
    return node
  }
  return {
    document: { createElement: () => el(), body: el() },
    navigator: { userAgent: UA },
  }
}

function runInstrumentation(blobB64) {
  const compressed = Buffer.from(blobB64, 'base64')
  const code = zlib.inflateRawSync(compressed).toString('utf-8')
  const nonce = code.match(/nonce:\s*"([0-9a-f]+)"/i)?.[1] || ''
  const tail = code.match(/blocked:\s*true\s*\},\s*'\*'\);return;\}([\s\S]*?)return (\w+);\}\)\(\);/)
  if (!tail) throw new Error('instr payload shape changed')
  const stub = makeDomStub()
  const sandbox = {
    document: stub.document,
    navigator: stub.navigator,
    parseInt,
    Date,
  }
  const script = `(function(){${tail[1]}\nreturn ${tail[2]};})()`
  const state = vm.runInNewContext(script, sandbox, { timeout: 5000 })
  return { i: nonce, state, ts: Date.now() }
}

function buildFormat1Pairs(token, challenge) {
  const pairs = []
  for (let i = 1; i <= challenge.c; i++) {
    pairs.push([prngHex(`${token}${i}`, challenge.s), prngHex(`${token}${i}d`, challenge.d)])
  }
  return pairs
}

function solvePowSequential(pairs, onStatus) {
  const total = pairs.length
  return pairs.map(([salt, target], i) => {
    onStatus(`Nyelesein captcha Cap... ${i + 1}/${total}`, (i + 1) / total)
    return solvePow(salt, target)
  })
}

function solvePowParallel(pairs, onStatus) {
  return new Promise((resolve, reject) => {
    const total = pairs.length
    const size = Math.max(1, Math.min(total, os.cpus().length))
    const counter = new Int32Array(new SharedArrayBuffer(4))
    const results = new Array(total)
    const workers = []
    let done = 0

    const finish = () => {
      for (const w of workers) w.terminate()
      resolve(results)
    }

    for (let w = 0; w < size; w++) {
      let worker
      try {
        worker = new Worker(new URL('./pow-worker.js', import.meta.url), { workerData: { pairs, counter } })
      } catch (err) {
        for (const w2 of workers) w2.terminate()
        return reject(err)
      }
      worker.on('message', ({ i, nonce }) => {
        results[i] = nonce
        done++
        onStatus(`Nyelesein captcha Cap... ${done}/${total}`, done / total)
        if (done === total) finish()
      })
      worker.on('error', err => {
        for (const w2 of workers) w2.terminate()
        reject(err)
      })
      workers.push(worker)
    }
  })
}

async function solvePowBatch(pairs, onStatus) {
  try {
    return await solvePowParallel(pairs, onStatus)
  } catch {
    return solvePowSequential(pairs, onStatus)
  }
}

export async function solveCap(apiEndpoint, onStatus = () => {}) {
  const base = apiEndpoint.endsWith('/') ? apiEndpoint : `${apiEndpoint}/`
  onStatus('Ambil challenge captcha...')
  const res = await fetch(`${base}challenge`, { method: 'POST', headers })
  const data = await res.json()
  if (data.error) throw new Error(`cap challenge: ${data.error}`)

  let solutions
  if (data.format === 2 && Array.isArray(data.challenges)) {
    solutions = {}
    const total = data.challenges.length
    for (let i = 0; i < total; i++) {
      const c = data.challenges[i]
      onStatus(`Nyelesein captcha Cap... ${i + 1}/${total}`, (i + 1) / total)
      if (c.protocol === 'sha256-pow') solutions[i] = { nonce: solvePow(c.payload.salt, c.payload.target) }
      else if (c.protocol === 'rsw') solutions[i] = { y: solveRsw(c.payload) }
      else if (c.protocol === 'instrumentation') solutions[i] = { instr: runInstrumentation(c.payload.blob) }
      else throw new Error(`unsupported challenge protocol: ${c?.protocol}`)
    }
  } else {
    const pairs = buildFormat1Pairs(data.token, data.challenge)
    solutions = await solvePowBatch(pairs, onStatus)
  }

  onStatus('Verifikasi captcha...')
  const body = { token: data.token, solutions }
  if (data.instrumentation) body.instr = runInstrumentation(data.instrumentation)

  const redeem = await fetch(`${base}redeem`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const out = await redeem.json()
  if (!out.success) throw new Error(`cap redeem: ${out.error || JSON.stringify(out)}`)
  return out.token
}
