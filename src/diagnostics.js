const MAX_BYTES = 65536

export async function captureResponse(res, url, secrets = []) {
  const chunks = []
  let size = 0
  let truncated = false
  if (res.body) {
    const reader = res.body.getReader()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        const remaining = MAX_BYTES - size
        chunks.push(value.subarray(0, remaining))
        size += Math.min(value.length, remaining)
        if (value.length > remaining) {
          truncated = true
          break
        }
      }
    } finally {
      if (truncated) await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  let body = null
  try { body = JSON.parse(raw) } catch {}
  let safe = raw
  for (const secret of [...secrets, body?.token, body?.capToken]) {
    if (typeof secret === 'string' && secret.length) safe = safe.replaceAll(secret, '[REDACTED]')
  }
  safe = safe.replace(/("(?:[\w-]*token|authorization|cookie|set-cookie|password|secret|api[_-]?key)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[REDACTED]"')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
  const endpoint = new URL(url)
  return {
    body,
    diagnostic: {
      source: 'upstream',
      url: endpoint.origin + endpoint.pathname,
      status: res.status,
      statusText: res.statusText,
      capturedAt: new Date().toISOString(),
      headers: Object.fromEntries(['content-type', 'x-request-id', 'x-vercel-id', 'cf-ray', 'retry-after'].flatMap(name => {
        const value = res.headers.get(name)
        return value ? [[name, value]] : []
      })),
      body: safe,
      truncated,
      redacted: true,
    },
  }
}

export function errorPayload(err) {
  return {
    message: err.message || 'server error',
    ...(err.diagnostic ? { diagnostic: err.diagnostic } : {}),
  }
}
