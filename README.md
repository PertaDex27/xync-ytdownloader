# Apa itu Yt Downloader?

Yt Downloader itu web buat ngubah link YouTube jadi file video atau audio yang bisa lo simpen. Tinggal tempel link, pilih format sama kualitas, terus unduh. Nggak perlu login atau install aplikasi kalau cuma mau pake versi webnya.

Dibikin sama **XyncTeam**. Selain lewat browser, bisa juga dijalanin di komputer sendiri lewat menu terminal atau dipake API-nya buat project lo.

**[Buka webnya di sini →](https://xync-ytdownloader.vercel.app)** · [English](README-en.md)

Penasaran tampilannya? Langsung buka webnya aja, sekalian cobain. Nggak pake screenshot di sini biar nggak beda sama tampilan yang lagi jalan, anjay.

## Bisa buat apa aja?

- Unduh audio: **MP3, M4A, dan OPUS**.
- Unduh video: **MP4**, resolusi ngikutin yang tersedia (umumnya sampai **1080p**, via snapyt).
- Cek judul, nama channel, dan thumbnail sebelum lanjut.
- Liat status proses selama nyiapin link unduhan.
- Ganti tema gelap atau terang. Di HP juga bisa.
- Jalanin menu terminal kalau lo lebih nyaman ngulik dari situ.

Pilihan kualitas itu request, bukan janji semua video bakal tersedia di kualitas itu. Sumbernya bukan 4K ya nggak mendadak jadi 4K beneran cuma gara-gara dipilih paling tinggi.

## Cara pakenya

1. Buka [web Yt Downloader](https://xync-ytdownloader.vercel.app).
2. Tempel link YouTube, terus klik **Download** buat ambil info videonya.
3. Pilih format dan kualitas yang lo butuhin.
4. Mulai konversi, tunggu sampai link filenya siap.
5. Klik **Download File** buat ngunduh hasilnya.

Link video biasa, Shorts, atau `youtu.be` bisa dipake. Kalau lagi gagal, cek link sama koneksi dulu; jangan langsung dihajar klik berkali-kali.

## Mau jalanin sendiri?

Siapin **Node.js 22 atau lebih baru** sama Git, lalu:

```sh
git clone https://github.com/PertaDex27/xync-ytdownloader.git
cd xync-ytdownloader
npm run startServerLocal
```

Buka **http://localhost:3000** di browser. Project ini nggak butuh paket npm tambahan buat jalan.

Kalau mau menu terminal:

```sh
npm run menu
```

Dari situ lo bisa ambil info video, konversi, simpen file, atau nyalain dan matiin server lokal. File yang diunduh lewat terminal disimpen di folder tempat lo ngejalanin perintahnya.

Port default-nya `3000`. Bisa diganti lewat environment variable `PORT`.

## Buat yang mau pake API

Ganti alamat di contoh ini kalau server lo jalan di tempat lain.

**Ambil info video:**

```sh
curl "http://localhost:3000/api/info?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ"
```

**Minta link MP3:**

```sh
curl "http://localhost:3000/api/download?id=dQw4w9WgXcQ&format=mp3&quality=128"
```

Respons sukses berisi `status: "ok"` dan data hasilnya. Endpoint download ngasih URL file di field `url`, bukan langsung ngirim isi file. Kalau gagal, cek field `message`.

| Parameter | Buat apa? |
|---|---|
| `url` / `id` | Link YouTube atau ID video |
| `format` | `mp3`, `mp4`, `m4a`, atau `opus`; default `mp3` |
| `quality` | Kualitas yang diminta, misalnya `128` buat MP3 atau `720` buat MP4 |
| `stream=1` | Khusus download: terima status proses lewat Server-Sent Events |

## Kalau prosesnya gagal

Project ini masih bergantung sama layanan pihak ketiga. Jadi ada kalanya proses lama, kena batas request, atau berhenti gara-gara layanan sumbernya berubah. Bukan berarti koneksi lo pasti bermasalah.

- Coba lagi nanti kalau kena rate limit, jangan spam request.
- Coba kualitas lebih rendah kalau video besar kelamaan diproses.
- Video privat, dibatasi wilayah, atau konten tertentu bisa aja nggak tersedia.
- File besar butuh ruang penyimpanan dan memori yang cukup, terutama di HP.
- Link unduhan dari layanan sumber bisa kedaluwarsa; bikin ulang kalau udah nggak bisa dibuka.

## Soal penggunaan

Pake buat konten punya lo sendiri, yang udah dapet izin, atau yang lisensinya memang ngebolehin diunduh. Bisa diunduh bukan berarti bebas diupload ulang, ya. Tetep hormatin hak kreator dan aturan layanan yang lo pake.

## Lisensi

[Apache License 2.0](LICENSE).
