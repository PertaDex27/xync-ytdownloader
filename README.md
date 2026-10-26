# CapSolver — Cara Kerja & Spesifikasi

Dokumentasi lengkap solver captcha **Cap** (proof-of-work) yang dipake di project ini. Cukup detail buat lo bikin ulang dari nol — tinggal lempar file ini ke dev/AI lain kalau perlu.

Struktur file yang berhubungan:

| File | Fungsinya |
|---|---|
| `src/cap.js` | Otaknya — dari challenge sampe dapet `capToken` |
| `src/pow-worker.js` | Worker paralel buat brute-force PoW  |
| `api/solve.js` | Dibungkus jadi endpoint HTTP (`{status, capToken, solvedIn}`) |
| `src/engine.js` | Pake `capToken` buat session & download |

---

## 1. Alur Besarnya

```
POST /challenge    dapet challenge (token + tugas)
solve tugasnya     solutions (nonce / y / instr)
POST /redeem       dapet capToken
```

Endpoint solver (selanjutnya disebut `SOLVER`, di project ini `https://check.dlsrv.online/30bb427100/`):

- `POST {SOLVER}challenge` → JSON challenge
- `POST {SOLVER}redeem` body `{ token, solutions, instr? }` → `{ success: true, token: "<capToken>" }`

---

## 2. Header Wajib

Request ke solver **HARUS** bawa header kayak browser beneran — kalau nggak, kena **403**.

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

>  Tanpa `Origin`/`Referer`/client hints → respon **Blocked**.
> Rate limit challenge: **~10x/menit per IP** — jangan sampe spam!

---

## 3. Dua Format Challenge

### Format 1 (default, `format` tidak ada / bukan 2)

```json
{
  "token": "abc123...",
  "challenge": { "c": 4, "s": 16, "d": 8 }
}
```

Bikin **c pasangan (salt, target)**, `i = 1..c`:

```
salt_i   = prngHex(token + String(i), s)
target_i = prngHex(token + String(i) + "d", d)
```

`solutions` = array nonce (angka), urut sama kayak pasangan:

```json
[184213, 9932, 421178, 60213]
```

### Format 2 (`format: 2`, `challenges: [...]`)

```json
{ "token": "...", "format": 2, "challenges": [ { "protocol": "sha256-pow", "payload": {...} }, ... ] }
```

`solutions` = object key-index, value tergantung protocol:

| Protocol | Payload | `solutions[i]` |
|---|---|---|
| `sha256-pow` | `{ salt, target }` | `{ nonce: <angka> }` |
| `rsw` | `{ N, x, t }` | `{ y: "<hex>" }` |
| `instrumentation` | `{ blob }` | `{ instr: { i, state, ts } }` |

Protocol lain → error `unsupported challenge protocol`.

### Field `instr` Tambahan

Kalau response challenge punya field `instrumentation` (di luar format), tambahin juga:

```json
body.instr = { i, state, ts }
```

---

## 4. Algoritma Inti

### `fnvHash(str)` — hash FNV-1 32-bit

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

### `prngHex(seed, len)` — PRNG xorshift dari seed, output hex

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

### `solvePow(salt, target)` — brute-force SHA-256

Cari `nonce` (0, 1, 2, ...) biar `SHA256(salt + String(nonce))` prefix-nya bit-prefix match sama `target` (hex):

- `bits = 4 * target.length`, `fullBytes = floor(bits / 8)`, `extraBits = bits % 8`
- `mask = extraBits > 0 ? (255 << (8 - extraBits)) & 255 : 0`
- Kalau panjang hex-nya ganjil, pad `target + "0"` dulu

>  Optimasi: pake `crypto.hash('sha256', data, 'buffer')` kalau Node ≥ 21, fallback ke `createHash`. Buffer di-reuse tiap iterasi biar gak boros alokasi.

### `solveRsw(payload)` — repeated squaring

```
N = BigInt("0x" + payload.N)
n = BigInt("0x" + payload.x)
// ulang payload.t kali:
n = (n * n) % N
y = n.toString(16)  // tanpa prefix 0x
```

### `runInstrumentation(blobB64)` — forge objek `instr`

1. `zlib.inflateRawSync(Buffer.from(blobB64, 'base64'))` → kode JS obfuscated
2. Regex ambil nonce: `/nonce:\s*"([0-9a-f]+)"/i` → nilai `i`
3. Regex ambil tail skrip → bungkus & run di `vm.runInNewContext` dengan DOM stub minimal (timeout 5 detik)
4. Output: `{ i: nonce, state: <hasil return>, ts: Date.now() }`

> `state` dikirim apa adanya — jangan di-clone/serialize manual.

---

## 5. Paralelisasi PoW

Format 1 bisa punya banyak pasangan — dikerjain bareng pake `worker_threads`:

- `SharedArrayBuffer` + `Atomics.add` buat bagi tugas antar worker
- Jumlah worker = `min(jumlah pasangan, jumlah CPU)`
- Error di worker → terminate semua → **fallback sequential**

---

## 6. API Contract

```
GET /api/solve
```

Sukses:
```json
{ "status": "ok", "capToken": "....", "solvedIn": 5012 }
```

Gagal:
```json
{ "status": "error", "message": "..." }
```

> ⏱ Waktu solve lokal ±5 detik (2 core), bisa lebih tergantung jumlah pasangan.

---

## 7. Mode Remote (Opsional)

- URL dari env `CAPSOLVER_URL` / `config.json` key `capsolver`
- `GET <url>` → `{ "capToken": "..." }`
- Kalau remote gagal / gak ada → otomatis fallback solve lokal

---

## 8. Pemakaian di Downloader (`engine.js`)

1. `POST {BASE}/api/verify` body `{ capToken }` → `{ token: "<JWT>" }` *(expired ±5 menit, ke-bind IP)*
2. `POST {BASE}/api/session/touch` body `{ videoId }` — **WAJIB** sebelum download
3. `POST {BASE}/api/v3/download` body `{ videoId, format, quality }` → `{ job }`
4. `GET {BASE}/api/v3/progress?job=<job>` poll tiap **2 detik** → `{ progress, done, url }`
5. Download dari URL hasil (`https://*.savenow.to/api/v2/download/<hex>`)

Status code penting:

| Kode | Artinya | Aksinya |
|---|---|---|
| 403 | Header/capToken salah | Cek header & solve ulang |
| 401/403 step 2-4 | JWT expired/invalid | Reset session, verify ulang |
| 429 di progress | Rate limit | Lanjut poll aja |
| `"Session not ready"` | Touch belum keproses | Tunggu 2 det, retry |

---

## 9. Checklist Bikin Ulang

- [ ] Header browser lengkap (UA + sec-ch-ua + Origin/Referer + Sec-Fetch)
- [ ] `fnvHash` + `prngHex` persis kayak di atas
- [ ] `solvePow` brute-force SHA-256 dengan bit-prefix mask
- [ ] Format 1: pasangan dari `prngHex`, solutions array
- [ ] Format 2: handle `sha256-pow` / `rsw` / `instrumentation`
- [ ] `instr` forge via `vm` + DOM stub, state dikirim apa adanya
- [ ] Paralel worker + fallback sequential
- [ ] `redeem` body `{ token, solutions }` + `instr` kalau ada
