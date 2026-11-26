import crypto from 'node:crypto'
import vm from 'node:vm'
import zlib from 'node:zlib'

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

export function solvePow(salt, target, { deadline = Date.now() + 30000, maxNonce = 50000000 } = {}) {
  validatePow({ salt, target })
  const bits = 4 * target.length
  const fullBytes = Math.floor(bits / 8)
  const extraBits = bits % 8
  const padded = target.length % 2 === 0 ? target : `${target}0`
  const targetBytes = Buffer.from(padded, 'hex')
  const mask = extraBits > 0 ? (255 << (8 - extraBits)) & 255 : 0
  const saltLen = Buffer.byteLength(salt)
  const buf = Buffer.allocUnsafe(saltLen + 16)
  buf.write(salt, 0, 'utf8')
  for (let nonce = 0; nonce < maxNonce; nonce++) {
    if (nonce % 1024 === 0 && Date.now() >= deadline) throw new Error('cap solve timed out')
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
  throw new Error('cap PoW work limit exceeded')
}

function solveRsw(payload, deadline) {
  const N = BigInt(`0x${payload.N}`)
  let n = BigInt(`0x${payload.x}`)
  const rounds = payload.t
  for (let i = 0; i < rounds; i++) {
    if (i % 1024 === 0 && Date.now() >= deadline) throw new Error('cap solve timed out')
    n = (n * n) % N
  }
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
    navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36 OPR/102.0.0.0' },
  }
}

function runInstrumentation(blobB64) {
  const compressed = Buffer.from(blobB64, 'base64')
  const code = zlib.inflateRawSync(compressed, { maxOutputLength: 1048576 }).toString('utf-8')
  const nonce = code.match(/nonce:\s*"([0-9a-f]+)"/i)?.[1] || ''
  const tail = code.match(/blocked:\s*true\s*\},\s*'\*'\);return;\}([\s\S]*?)return (\w+);\}\)\(\);/)
  if (!tail) throw new Error('instr payload shape changed')
  const script = `JSON.stringify((function(){
    const { document, navigator } = (${makeDomStub.toString()})();
    const state = (function(){${tail[1]}\nreturn ${tail[2]};})();
    return { i: ${JSON.stringify(nonce)}, state, ts: Date.now() };
  })())`
  const json = vm.runInNewContext(script, {}, {
    timeout: 1000,
    contextCodeGeneration: { strings: false, wasm: false },
  })
  if (json.length > 262144) throw new Error('cap instrumentation result too large')
  return JSON.parse(json)
}

const fail = message => { throw new Error(`cap invalid challenge: ${message}`) }
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max
const hex = (value, max) => text(value, max) && /^[0-9a-f]+$/i.test(value)

function format1Integer(value, field, max) {
  const normalized = typeof value === 'string' && /^\d{1,10}$/.test(value) ? Number(value) : value
  if (!integer(normalized, 1, max)) {
    const received = typeof normalized === 'number' && Number.isFinite(normalized) ? normalized : typeof value
    fail(`format 1 ${field} must be an integer from 1 to ${max} (received ${received})`)
  }
  return normalized
}

function validatePow(payload) {
  if (!payload || !text(payload.salt, 4096) || !hex(payload.target, 64)) fail('invalid PoW payload')
}

function validateTask(task) {
  const p = task?.payload
  if (task?.protocol === 'sha256-pow') return validatePow(p)
  if (task?.protocol === 'rsw') {
    if (!p || !hex(p.N, 1024) || BigInt(`0x${p.N}`) <= 1n || !hex(p.x, 1024) || !integer(p.t, 0, 10000000)) fail('invalid RSW payload')
    return
  }
  if (task?.protocol === 'instrumentation') {
    if (!p || !text(p.blob, 262144) || !/^[A-Za-z0-9+/]+={0,2}$/.test(p.blob)) fail('invalid instrumentation blob')
    return
  }
  fail('unsupported challenge protocol')
}

export function prepareChallenge(data) {
  if (!data || !text(data.token, 8192)) fail('missing token')
  let tasks
  if (data.format === 2) {
    if (!Array.isArray(data.challenges) || !integer(data.challenges.length, 1, 64)) fail('invalid task count')
    tasks = data.challenges
  } else if (data.format === undefined || data.format === 1) {
    const c = data.challenge
    if (!c || typeof c !== 'object' || Array.isArray(c)) fail('missing format 1 challenge object')
    const count = format1Integer(c.c, 'c (task count)', 4096)
    const saltLength = format1Integer(c.s, 's (salt length)', 4096)
    const difficulty = format1Integer(c.d, 'd (target length)', 64)
    if (count * (saltLength + difficulty) > 1048576) fail('format 1 generated tasks exceed 1 MiB')
    tasks = Array.from({ length: count }, (_, i) => ({
      protocol: 'sha256-pow', payload: {
        salt: prngHex(`${data.token}${i + 1}`, saltLength),
        target: prngHex(`${data.token}${i + 1}d`, difficulty),
      },
    }))
  } else fail('unsupported format')
  tasks.forEach(validateTask)
  if (data.instrumentation !== undefined) {
    const extra = { protocol: 'instrumentation', payload: { blob: data.instrumentation } }
    validateTask(extra)
    tasks = [...tasks, extra]
  }
  return tasks
}

export function solveTask(task, options) {
  validateTask(task)
  if (task.protocol === 'sha256-pow') return { nonce: solvePow(task.payload.salt, task.payload.target, options) }
  if (task.protocol === 'rsw') return { y: solveRsw(task.payload, options.deadline) }
  return { instr: runInstrumentation(task.payload.blob) }
}
