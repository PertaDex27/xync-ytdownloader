# CapSolver — How It Works & Specifications

Full documentation for the **Cap** (proof-of-work) captcha solver used in this project. Detailed enough to rebuild the solver from scratch — just hand this file to another dev/AI if needed.

Related files:

| File | What it does |
|---|---|
| `src/cap.js` | The brain — from challenge all the way to `capToken` |
| `src/pow-worker.js` | Parallel workers for brute-forcing PoW  |
| `api/solve.js` | Wraps everything as an HTTP endpoint (`{status, capToken, solvedIn}`) |
| `src/engine.js` | Uses `capToken` for session & download |

---

## 1. High-Level Flow

```
POST /challenge    receive challenge (token + task)
solve the task     solutions (nonce / y / instr)
POST /redeem       receive capToken
```

Solver endpoints (referred to as `SOLVER`, in this project `https://check.dlsrv.online/30bb427100/`):

- `POST {SOLVER}challenge` → JSON challenge
- `POST {SOLVER}redeem` body `{ token, solutions, instr? }` → `{ success: true, token: "<capToken>" }`

---

## 2. Required Headers

Requests to the solver **MUST** carry browser-like headers — otherwise you get a **403**.

```
User-Agent: Mozilla/5.0 (Linux; Android 10; K) ... Chrome/152.0.0.0 ... OPR/102.0.0.0
Accept: */*
Accept-Language: en-US,en;q=0.9
Origin: https://embed.dlsrv.online
Referer: https://embed.dlsrv.online/
sec-ch-ua: "OperaMobile";v="102", "Opera";v="137", "Chromium";v="152", " Not A;Brand";v="99"
sec-ch-ua-mobile: ?1
sec-ch-ua-platform: "Android"
Sec-Fetch-Site: cross-site
Sec-Fetch-Mode: cors
Sec-Fetch-Dest: empty
```

>  Missing `Origin`/`Referer`/client hints → response is **Blocked**.
> Challenge rate limit: **~10 req/min per IP** — don't spam it!

---

## 3. Two Challenge Formats

### Format 1 (default, no `format` field / not 2)

```json
{
  "token": "abc123...",
  "challenge": { "c": 4, "s": 16, "d": 8 }
}
```

Generate **c pairs (salt, target)**, `i = 1..c`:

```
salt_i   = prngHex(token + String(i), s)
target_i = prngHex(token + String(i) + "d", d)
```

`solutions` = array of nonces (numbers), same order as the pairs:

```json
[184213, 9932, 421178, 60213]
```

### Format 2 (`format: 2`, `challenges: [...]`)

```json
{ "token": "...", "format": 2, "challenges": [ { "protocol": "sha256-pow", "payload": {...} }, ... ] }
```

`solutions` = object keyed by index, value depends on protocol:

| Protocol | Payload | `solutions[i]` |
|---|---|---|
| `sha256-pow` | `{ salt, target }` | `{ nonce: <number> }` |
| `rsw` | `{ N, x, t }` | `{ y: "<hex>" }` |
| `instrumentation` | `{ blob }` | `{ instr: { i, state, ts } }` |

Any other protocol → error `unsupported challenge protocol`.

### Extra `instr` Field

If the challenge response has an `instrumentation` field (outside the format), also include:

```json
body.instr = { i, state, ts }
```

---

## 4. Core Algorithms

### `fnvHash(str)` — FNV-1 32-bit hash

```js
function fnvHash(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)
  }
  return h >>> 0
}
```

### `prngHex(seed, len)` — xorshift PRNG from seed, hex output

```js
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
```

### `solvePow(salt, target)` — SHA-256 brute-force

Find `nonce` (0, 1, 2, ...) such that `SHA256(salt + String(nonce))` has a bit-prefix matching `target` (hex):

- `bits = 4 * target.length`, `fullBytes = floor(bits / 8)`, `extraBits = bits % 8`
- `mask = extraBits > 0 ? (255 << (8 - extraBits)) & 255 : 0`
- If the hex target length is odd, pad with `target + "0"` before buffering

>  Optimization: use `crypto.hash('sha256', data, 'buffer')` on Node ≥ 21, fallback to `createHash`. Reuse the buffer every iteration to avoid per-iteration allocations.

### `solveRsw(payload)` — repeated squaring

```
N = BigInt("0x" + payload.N)
n = BigInt("0x" + payload.x)
// repeat payload.t times:
n = (n * n) % N
y = n.toString(16)  // no 0x prefix
```

### `runInstrumentation(blobB64)` — forge `instr` object

1. `zlib.inflateRawSync(Buffer.from(blobB64, 'base64'))` → obfuscated JS code
2. Regex extract nonce: `/nonce:\s*"([0-9a-f]+)"/i` → value `i`
3. Regex extract script tail → wrap & run in `vm.runInNewContext` with minimal DOM stub (5s timeout)
4. Return: `{ i: nonce, state: <script return value>, ts: Date.now() }`

> Send `state` as-is — don't manually clone/serialize it.

---

## 5. PoW Parallelization

Format 1 can have many pairs — handled concurrently via `worker_threads`:

- `SharedArrayBuffer` + `Atomics.add` for task distribution across workers
- Worker count = `min(pair count, CPU count)`
- Worker error → terminate all → **sequential fallback**

---

## 6. API Contract

```
GET /api/solve
```

Success:
```json
{ "status": "ok", "capToken": "....", "solvedIn": 5012 }
```

Error:
```json
{ "status": "error", "message": "..." }
```

> ⏱ Local solve time ±5 seconds (2 cores), may vary based on pair count.

---

## 7. Remote Mode (Optional)

- URL from env `CAPSOLVER_URL` / `config.json` key `capsolver`
- `GET <url>` → `{ "capToken": "..." }`
- If remote fails or isn't set → automatically falls back to local solve

---

## 8. Usage in Downloader (`engine.js`)

1. `POST {BASE}/api/verify` body `{ capToken }` → `{ token: "<JWT>" }` *(expires ±5 min, bound to IP)*
2. `POST {BASE}/api/session/touch` body `{ videoId }` — **REQUIRED** before download
3. `POST {BASE}/api/v3/download` body `{ videoId, format, quality }` → `{ job }`
4. `GET {BASE}/api/v3/progress?job=<job>` poll every **2 seconds** → `{ progress, done, url }`
5. Download from result URL (`https://*.savenow.to/api/v2/download/<hex>`)

Important status codes:

| Code | Meaning | Action |
|---|---|---|
| 403 | Wrong headers / capToken | Fix headers & re-solve |
| 401/403 steps 2-4 | JWT expired/invalid | Reset session, re-verify |
| 429 on progress | Rate limited | Keep polling |
| `"Session not ready"` | Touch not yet processed | Wait 2s, retry |

---

## 9. Rebuild Checklist

- [ ] Full browser headers (UA + sec-ch-ua + Origin/Referer + Sec-Fetch)
- [ ] `fnvHash` + `prngHex` exactly as above
- [ ] `solvePow` SHA-256 brute-force with bit-prefix mask
- [ ] Format 1: pairs from `prngHex`, solutions as array
- [ ] Format 2: handle `sha256-pow` / `rsw` / `instrumentation`
- [ ] `instr` forged via `vm` + DOM stub, state sent as-is
- [ ] Parallel workers + sequential fallback
- [ ] `redeem` body `{ token, solutions }` + `instr` if present
