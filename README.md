# CapSolver — Cara Kerja & Spesifikasi

Dokumentasi lengkap solver captcha **Cap** (proof-of-work) yang dipake project ini. Isinya cukup detail buat nge-build ulang solver dari nol — tinggal kasih file ini ke AI/dev lain kalo butuh bikin CapSolver lagi.

Struktur file yang berhubungan:

| File | Isi |
|---|---|
| `src/cap.js` | Otak solver: challenge → solve → redeem → `capToken` |
| `src/pow-worker.js` | Worker paralel buat brute-force PoW |
| `api/solve.js` | Bungkus jadi endpoint HTTP (`{status, capToken, solvedIn}`) |
| `src/engine.js` | Pemakaian `capToken` buat session & download |

---

## 1. Alur besar

```
POST /challenge  ──►  dapat challenge (token + tugas)
solve tugasnya   ──►  solutions (nonce / y / instr)
POST /redeem     ──►  dapat capToken
```

Endpoint solver (selanjutnya disebut `SOLVER`, di project ini `https://check.dlsrv.online/30bb427100/`):

- `POST {SOLVER}challenge` → JSON challenge
- `POST {SOLVER}redeem` body `{ token, solutions, instr? }` → `{ success: true, token: "<capToken>" }`

## 2. Header wajib (403 kalau salah)

Request ke solver HARUS bawa header kayak browser beneran:

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

Tanpa `Origin`/`Referer`/client hints → respon `Blocked`. Ada rate limit challenge sekitar **10x per menit** per IP — jangan spam `challenge`.

## 3. Dua format challenge

### Format 1 (default, `format` tidak ada / bukan 2)

```json
{
  "token": "abc123...",
  "challenge": { "c": 4, "s": 16, "d": 8 }
}
```

Bikin **c pasangan (salt, target)**, `i = 1..c`:

```
salt_i   = prngHex(token + String(i), s)      // hex, panjang s
target_i = prngHex(token + String(i) + "d", d) // hex, panjang d
```

`solutions` = **array** nonce (angka), urut sama kayak pasangan:

```json
[184213, 9932, 421178, 60213]
```

### Format 2 (`format: 2`, `challenges: [...]`)

```json
{ "token": "...", "format": 2, "challenges": [ { "protocol": "sha256-pow", "payload": {...} }, ... ] }
```

`solutions` = **object** key-index, value tergantung protocol:

| protocol | payload | isi solutions[i] |
|---|---|---|
| `sha256-pow` | `{ salt, target }` | `{ nonce: <angka> }` |
| `rsw` | `{ N, x, t }` | `{ y: "<hex>" }` |
| `instrumentation` | `{ blob }` | `{ instr: { i, state, ts } }` |

Protocol lain → error `unsupported challenge protocol`.

### `instr` tambahan

Kalo response challenge punya field `instrumentation` (di luar format), bikin juga:

```json
body.instr = { i, state, ts }
```

## 4. Algoritma inti

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

Cari `nonce` (0, 1, 2, ...) sedemikian sehingga:

```
SHA256(salt + String(nonce))   // nonce desimal, TANPA pemisah
```

prefix-nya **bit-prefix match** sama `target` (hex):

- `bits = 4 * target.length`, `fullBytes = floor(bits / 8)`, `extraBits = bits % 8`
- `mask = extraBits > 0 ? (255 << (8 - extraBits)) & 255 : 0`
- byte `0..fullBytes-1` harus identik sama `targetBytes`
- sisa bit (`extraBits`): `(hash[fullBytes] & mask) === (targetBytes[fullBytes] & mask)`

Kalo `target` panjang hex-nya ganjil, pad `target + "0"` sebelum dijadiin buffer. Return value = **angka nonce** (nanti di payload redeem ditaruh apa adanya).

Optimasi: hash dipake `crypto.hash('sha256', data, 'buffer')` kalo ada (Node ≥ 21), fallback `createHash`. Salt + nonce digit ditulis ke buffer yang di-reuse (`buf.write(salt)`, lalu digit desimal nonce ditulis belakang lalu dibalik) — biar gak alokasi buffer tiap iterasi.

### `solveRsw(payload)` — repeated squaring (timelock)

```
N = BigInt("0x" + payload.N)
n = BigInt("0x" + payload.x)
ulangi payload.t kali: n = (n * n) % N
y = n.toString(16)   // TANPA prefix 0x
```

### `runInstrumentation(blobB64)` — forge objek `instr`

1. `zlib.inflateRawSync(Buffer.from(blobB64, 'base64'))` → kode JS (obfuscated).
2. Dari kode, regex ambil nonce: `/nonce:\s*"([0-9a-f]+)"/i` → nilai `i`.
3. Regex ambil bagian ekor skrip yang nge-return state:

   ```
   /blocked:\s*true\s*\},\s*'\*'\);return;\}([\s\S]*?)return (\w+);\}\)\(\);/
   ```

   `tail[1]` = badan fungsi, `tail[2]` = nama variabel hasil.
4. Bungkus jadi `(function(){${tail[1]}\nreturn ${tail[2]};})()` terus jalankan di **`vm.runInNewContext`** dengan sandbox:

   ```js
   { document: <domStub>, navigator: { userAgent: UA }, parseInt, Date }
   ```

   `domStub` minimal: `document.createElement()` & `document.body` yang ngasih node dengan `children`, `parentNode`, `style`, `innerText` (get/set), `appendChild`, `removeChild`, `lastElementChild`. Timeout 5 detik.
5. Hasilnya:

   ```js
   { i: nonce, state: <hasil return skrip>, ts: Date.now() }
   ```

   `state` (biasanya objek berisi 4 angka) dikirim **apa adanya** — jangan di-clone/serialize manual, identitas objeknya dipertahankan.

## 5. Paralelisasi PoW (`pow-worker.js`)

Format 1 bisa punya banyak pasangan — dikerjain bareng pake `worker_threads`:

- `counter = new Int32Array(new SharedArrayBuffer(4))` + `Atomics.add(counter, 0, 1)` buat bagi tugas
- jumlah worker = `min(jumlah pasangan, jumlah CPU)`
- `workerData: { pairs, counter }`, tiap worker loop: ambil index → `solvePow` → `postMessage({ i, nonce })`
- kalo ada error di worker → terminate semua → **fallback sequential** (solve satu-satu)

## 6. Kontrak API `api/solve.js`

```
GET /api/solve
```

```json
{ "status": "ok", "capToken": "....", "solvedIn": 5012 }
```

atau kalo gagal:

```json
{ "status": "error", "message": "..." }
```

Waktu solve lokal ± 5 detik (2 core), bisa lebih lama tergantung jumlah pasangan.

## 7. Mode remote (opsional)

Kalo ada server CapSolver lain, bisa dipake duluan sebelum solve lokal:

- URL-nya dari env `CAPSOLVER_URL` / `config.json` key `capsolver`
- `GET <url>` → `{ "capToken": "..." }`
- kalo remote gagal / gak ada → otomatis fallback solve lokal

## 8. Pemakaian di downloader (`engine.js`)

`capToken` ditukar ke backend downloader buat dapetin session JWT:

1. `POST {BASE}/api/verify` body `{ capToken }` → `{ token: "<JWT>" }`
   - JWT expired ± **5 menit**, ke-bind **IP** + `uaf = sha256(UA).slice(0,16)`
   - `BASE` = `https://embed.dlsrv.online`
2. `POST {BASE}/api/session/touch` body `{ videoId }` **WAJIB** sebelum download — kalo nggak, error `"Session not ready. Please try again."`
3. `POST {BASE}/api/v3/download` body `{ videoId, format, quality }` → `{ job }`
4. `GET {BASE}/api/v3/progress?job=<job>` poll tiap **2 detik** → `{ progress, done, url }`
5. `url` hasil = `https://*.savenow.to/api/v2/download/<hex>` — `content-disposition: attachment`, CORS `access-control-allow-origin: *`, tanpa `content-length`

Status code penting:

| Kode | Arti | Aksi |
|---|---|---|
| 403 | header/capToken salah | cek header & solve ulang |
| 401/403 di step 2-4 | JWT expired / invalid | reset session, verify ulang |
| 429 di progress | kena rate limit | lanjut poll |
| `"Session not ready"` | touch belum keburu | tunggu 2 detik, retry |

## 9. Checklist bikin ulang solver

- [ ] Header browser lengkap (UA + sec-ch-ua + Origin/Referer + Sec-Fetch)
- [ ] `fnvHash` + `prngHex` persis kayak di atas
- [ ] `solvePow` brute-force SHA-256 dengan bit-prefix mask
- [ ] Format 1: pasangan dari `prngHex(token+i, s)` & `prngHex(token+i+"d", d)`, solutions array
- [ ] Format 2: handle `sha256-pow` / `rsw` / `instrumentation`
- [ ] `instr` forge via `vm` + DOM stub, state dikirim apa adanya
- [ ] Paralel worker + fallback sequential
- [ ] `redeem` body `{ token, solutions }` (+ `instr` kalo ada), return `out.token`
