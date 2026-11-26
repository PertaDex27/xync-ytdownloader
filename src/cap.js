import os from 'node:os'
import { Worker } from 'node:worker_threads'
import { prepareChallenge } from './cap-protocol.js'
export { solvePow } from './cap-protocol.js'

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

let active = 0

function positive(value, fallback, name, max) {
  const n = value ?? fallback
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`cap invalid option: ${name}`)
  return n
}

async function requestJson(url, body, signal, requestTimeoutMs) {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)])
  const res = await fetch(url, {
    method: 'POST', redirect: 'error', signal: requestSignal,
    headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!res.ok) {
    await res.body?.cancel()
    const err = new Error(`cap ${url.pathname.split('/').pop()}: HTTP ${res.status}${res.status === 429 ? ' (rate limited; try later)' : ''}`)
    err.status = res.status
    throw err
  }
  const chunks = []
  let size = 0
  try {
    for await (const chunk of res.body) {
      size += chunk.length
      if (size > 1048576) throw new Error('cap response too large')
      chunks.push(chunk)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (err) {
    if (err instanceof SyntaxError) throw new Error('cap upstream returned invalid JSON')
    throw err
  }
}

async function solveTasks(tasks, onStatus, { signal, deadline, maxWorkers, maxNonce }) {
  signal.throwIfAborted()
  const counter = new Int32Array(new SharedArrayBuffer(4))
  const results = new Array(tasks.length)
  const seen = new Set()
  const workers = []
  let abort
  try {
    return await new Promise((resolve, reject) => {
      let settled = false
      const fail = err => { if (!settled) { settled = true; reject(err) } }
      abort = () => fail(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      const count = Math.min(tasks.length, maxWorkers, os.availableParallelism?.() || os.cpus().length || 1)
      for (let w = 0; w < count; w++) {
        if (settled) break
        let worker
        try {
          worker = new Worker(new URL('./pow-worker.js', import.meta.url), {
            workerData: { tasks, counter, deadline, maxNonce },
            resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
          })
        } catch (err) {
          fail(new Error('cap worker could not start', { cause: err }))
          break
        }
        workers.push(worker)
        worker.on('message', message => {
          if (settled) return
          const { i, result, error } = message
          if (error) return fail(new Error(error))
          if (!Number.isInteger(i) || i < 0 || i >= tasks.length || seen.has(i) || !result) return fail(new Error('cap invalid worker result'))
          seen.add(i)
          results[i] = result
          try { onStatus(`Nyelesein captcha Cap... ${seen.size}/${tasks.length}`, seen.size / tasks.length) }
          catch (err) { return fail(err) }
          if (seen.size === tasks.length) { settled = true; resolve(results) }
        })
        worker.on('error', err => fail(new Error('cap worker failed', { cause: err })))
        worker.on('exit', code => {
          if (!settled && (code !== 0 || workers.every(w => w.threadId === -1))) fail(new Error('cap worker exited before completion'))
        })
      }
    })
  } finally {
    signal.removeEventListener('abort', abort)
    await Promise.allSettled(workers.map(worker => worker.terminate()))
  }
}

export async function solveCap(apiEndpoint, onStatus = () => {}, options = {}) {
  const timeoutMs = positive(options.timeoutMs, 45000, 'timeoutMs', 300000)
  const requestTimeoutMs = positive(options.requestTimeoutMs, 10000, 'requestTimeoutMs', 60000)
  const maxWorkers = positive(options.maxWorkers, 2, 'maxWorkers', 4)
  const maxNonce = positive(options.maxNonce, 50000000, 'maxNonce', Number.MAX_SAFE_INTEGER)
  const base = new URL(apiEndpoint.endsWith('/') ? apiEndpoint : `${apiEndpoint}/`)
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('cap invalid endpoint')
  if (active >= 2) throw new Error('cap solver busy; try later')
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(options.signal ? [options.signal] : [])])
  signal.throwIfAborted()
  const deadline = Date.now() + timeoutMs
  active++
  try {
    onStatus('Ambil challenge captcha...')
    const data = await requestJson(new URL('challenge', base), null, signal, requestTimeoutMs)
    if (data?.error) throw new Error('cap challenge rejected by upstream')
    const tasks = prepareChallenge(data)
    const results = await solveTasks(tasks, onStatus, { signal, deadline, maxWorkers, maxNonce })
    const hasExtra = data.instrumentation !== undefined
    const count = tasks.length - (hasExtra ? 1 : 0)
    const solutions = data.format === 2
      ? Object.fromEntries(results.slice(0, count).map((result, i) => [i, result]))
      : results.slice(0, count).map(result => result.nonce)
    const body = { token: data.token, solutions }
    if (hasExtra) body.instr = results.at(-1).instr
    signal.throwIfAborted()
    onStatus('Verifikasi captcha...')
    const out = await requestJson(new URL('redeem', base), body, signal, requestTimeoutMs)
    if (out?.success !== true || typeof out.token !== 'string' || !out.token.trim() || out.token.length > 16384) throw new Error('cap redeem rejected or missing token')
    return out.token
  } catch (err) {
    if (signal.aborted) {
      if (signal.reason?.name === 'TimeoutError') throw new Error('cap solve timed out', { cause: err })
      throw signal.reason
    }
    if (err.name === 'TimeoutError') throw new Error('cap upstream request timed out', { cause: err })
    throw err
  } finally {
    active--
  }
}
