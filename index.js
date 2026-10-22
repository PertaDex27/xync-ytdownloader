import readline from 'node:readline'
import fs from 'node:fs'
import path from 'node:path'
import { startServer, stopServer, serverPort } from './src/server.js'
import { convert, normalizeFormat, normalizeQuality, getCapsolverUrl, setCapsolverUrl, extractVideoId, fetchMeta, FORMATS } from './src/engine.js'

const E = '\x1b['
const reset = `${E}0m`
const bold = `${E}1m`
const dim = `${E}2m`
const rgb = (r, g, b) => `${E}38;2;${r};${g};${b}m`
const red = `${E}31m`
const green = `${E}32m`
const yellow = `${E}33m`
const cyan = `${E}36m`
const white = `${E}37m`
const gray = `${E}90m`

const BANNER_ROWS = [
  '██╗  ██╗ ██╗   ██╗ ███╗   ██╗  ██████╗  ████████╗ ███████╗  █████╗   ███╗   ███╗',
  '╚██╗██╔╝ ╚██╗ ██╔╝ ████╗  ██║ ██╔════╝  ╚══██╔══╝ ██╔════╝ ██╔══██╗  ████╗ ████║',
  ' ╚███╔╝   ╚████╔╝  ██╔██╗ ██║ ██║          ██║    █████╗   ███████║  ██╔████╔██║',
  ' ██╔██╗    ╚██╔╝   ██║╚██╗██║ ██║          ██║    ██╔══╝   ██╔══██║  ██║╚██╔╝██║',
  '██╔╝ ██╗    ██║    ██║ ╚████║ ╚██████╗     ██║    ███████╗ ██║  ██║  ██║ ╚═╝ ██║',
  '╚═╝  ╚═╝    ╚═╝    ╚═╝  ╚═══╝  ╚═════╝     ╚═╝    ╚══════╝ ╚═╝  ╚═╝  ╚═╝     ╚═╝',
]

const SUBTITLE = 'YT DL API - V1.0 • © XyncTeam'

const MENU = [
  { key: '1', label: 'Start API Server', icon: '▶' },
  { key: '2', label: 'Stop API Server', icon: '■' },
  { key: '3', label: 'Cek Info Video', icon: 'ℹ' },
  { key: '4', label: 'Download / Convert', icon: '⬇' },
  { key: '5', label: 'Set CapSolver URL', icon: '⚙' },
  { key: '6', label: 'Keluar', icon: '✕' },
]

let selected = 0
let serverOn = false
let busy = false
let promptMode = false

function gradientLine(text) {
  const width = BANNER_ROWS[0].length
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === ' ') { out += ' '; continue }
    const t = i / (width - 1)
    const r = Math.round(34 + (168 - 34) * t)
    const g = Math.round(211 + (85 - 211) * t)
    const b = Math.round(238 + (247 - 238) * t)
    out += `${rgb(r, g, b)}${ch}`
  }
  return out + reset
}

function padCenter(text, width) {
  return ' '.repeat(Math.max(0, Math.floor((width - text.length) / 2)))
}

function render() {
  console.clear()
  const width = BANNER_ROWS[0].length
  for (const row of BANNER_ROWS) console.log(gradientLine(row))
  console.log(`${padCenter(SUBTITLE, width)}${gray}${bold}YT DL API - ${reset}${yellow}${bold}V1.0${reset}${gray} • ${reset}${gray}© ${reset}${cyan}${bold}XyncTeam${reset}`)
  console.log()
  const status = serverOn
    ? `${green}${bold} ● API ONLINE  ${reset}${gray}http://localhost:${serverPort()}${reset}`
    : `${red}${bold} ● API OFFLINE ${reset}${gray}ketuk Start API Server${reset}`
  const solver = getCapsolverUrl()
    ? `${cyan}${bold} ● SOLVER REMOTE${reset}`
    : `${yellow}${bold} ● SOLVER LOCAL ${reset}`
  console.log(`  STATUS   ${status}`)
  console.log(`  SOLVER   ${solver}`)
  console.log()
  MENU.forEach((item, i) => {
    const active = i === selected
    const icon = active ? `${green}${bold}${item.icon}${reset}` : `${gray}${item.icon}${reset}`
    const num = active ? `${green}${bold}[${item.key}]${reset}` : `${gray}[${item.key}]${reset}`
    const label = active
      ? `${E}48;2;40;20;60m${E}38;2;120;255;190m${bold} ${item.label} ${reset}`
      : ` ${white}${item.label}${reset}`
    console.log(`   ${icon} ${num} ${label}`)
  })
  console.log()
  console.log(`   ${gray}↑↓ geser  •  ENTER pilih  •  1-6 shortcut  •  Ctrl+C keluar${reset}`)
  console.log()
}

function barLine(frac, label, extra) {
  const w = 24
  const filled = Math.round(Math.max(0, Math.min(1, frac)) * w)
  process.stdout.write(`\r   ${label} ${cyan}${'█'.repeat(filled)}${gray}${'░'.repeat(w - filled)}${reset} ${white}${Math.round(frac * 100)}%${reset} ${gray}${extra}${reset}${E}K`)
}

function spinnerStart(text) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  const t0 = Date.now()
  let i = 0
  let msg = text
  let frac = null
  const timer = setInterval(() => {
    const secs = ((Date.now() - t0) / 1000).toFixed(0)
    if (frac === null) {
      process.stdout.write(`\r   ${cyan}${frames[i++ % frames.length]}${reset} ${msg} ${gray}(${secs}s)${reset}${E}K`)
    } else {
      barLine(frac, msg, `(${secs}s)`)
    }
  }, 80)
  return {
    update(t, f) { msg = t; if (f !== undefined) frac = f === null ? null : f },
    stop() {
      clearInterval(timer)
      process.stdout.write(`\r${E}K`)
    },
  }
}

function fmtSize(n) {
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

function qualityLabel(format, q) {
  if (format === 'mp4') {
    if (q === '2160') return '2160p (4K)'
    if (q === '1440') return '1440p (2K)'
    if (q === '1080') return '1080p (FHD)'
    if (q === '720') return '720p (HD)'
    return `${q}p`
  }
  return `${q}kbps`
}

function safeName(title, format) {
  const base = title.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'download'
  return `${base}.${format}`
}

async function downloadToFile(url, fileName) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`unduh file gagal: HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length')) || 0
  const outPath = path.join(process.cwd(), fileName)
  const file = fs.createWriteStream(outPath)
  let received = 0
  let lastPaint = 0
  let tick = 0
  const t0 = Date.now()
  const w = 12
  try {
    for await (const chunk of res.body) {
      received += chunk.length
      file.write(chunk)
      const now = Date.now()
      if (now - lastPaint > 120) {
        lastPaint = now
        const secs = (now - t0) / 1000
        const speed = fmtSize(Math.round(received / Math.max(secs, 0.001)))
        if (total > 0) {
          barLine(received / total, '⬇  unduh', `${fmtSize(received)}/${fmtSize(total)}  ${speed}/s`)
        } else {
          const pos = tick++ % w
          const cells = Array.from({ length: w }, (_, i) => (i - pos + w) % w < 3 ? '█' : '░').join('')
          process.stdout.write(`\r   ⬇  unduh ${cyan}${cells}${reset} ${white}${fmtSize(received)}${reset} ${gray}${speed}/s${reset}${E}K`)
        }
      }
    }
    await new Promise(r => file.end(r))
  } catch (err) {
    file.destroy()
    fs.unlink(outPath, () => {})
    throw err
  }
  if (total > 0) barLine(1, '⬇  unduh', `${fmtSize(received)}/${fmtSize(total)}`)
  else process.stdout.write(`\r${E}K   ${green}${'█'.repeat(w)}${reset} ${white}${fmtSize(received)}${reset}`)
  process.stdout.write('\n')
  return { outPath, size: received }
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

function ask(question) {
  promptMode = true
  return new Promise(resolve => {
    rl.question(`   ${cyan}?${reset} ${question} `, ans => {
      promptMode = false
      resolve(ans.trim())
    })
  })
}

function waitEnter() {
  promptMode = true
  return new Promise(resolve => {
    rl.question(`\n   ${gray}Tekan ENTER untuk balik ke menu...${reset}`, () => {
      promptMode = false
      resolve()
    })
  })
}

async function doInfo() {
  const input = await ask('Masukin link YouTube:')
  const spin = spinnerStart('Ambil info video...')
  try {
    const videoId = extractVideoId(input)
    if (!videoId) throw new Error('link/ID youtube-nya gak valid')
    const meta = await fetchMeta(videoId)
    spin.stop()
    console.log(`   ${green}${bold}✔ Ketemu!${reset}`)
    console.log(`   ${gray}ID    ${reset}: ${white}${videoId}${reset}`)
    console.log(`   ${gray}Judul ${reset}: ${yellow}${meta.title}${reset}`)
    console.log(`   ${gray}Author${reset}: ${white}${meta.author || '-'}${reset}`)
    console.log(`   ${gray}Thumb ${reset}: ${dim}${meta.thumbnail}${reset}`)
  } catch (err) {
    spin.stop()
    console.log(`   ${red}${bold}✘ Gagal:${reset} ${red}${err.message}${reset}`)
  }
  await waitEnter()
}

async function doDownload() {
  const input = await ask('Masukin link YouTube:')
  const videoId = extractVideoId(input)
  if (!videoId) {
    console.log(`   ${red}${bold}✘ Gagal:${reset} ${red}link/ID youtube-nya gak valid${reset}`)
    return waitEnter()
  }
  console.log(`   ${gray}Format:${reset} ${white}[1]${reset} mp3   ${white}[2]${reset} mp4   ${white}[3]${reset} m4a   ${white}[4]${reset} opus`)
  const fIn = await ask('Pilih format [1]:')
  const format = normalizeFormat(({ 1: 'mp3', 2: 'mp4', 3: 'm4a', 4: 'opus' })[fIn] || 'mp3')
  const list = FORMATS[format]
  console.log(`   ${gray}Quality ${format}:${reset} ${list.map((q, i) => `${white}[${i + 1}]${reset} ${qualityLabel(format, q)}`).join('   ')}`)
  const qIn = await ask(`Pilih quality [${format === 'mp4' ? '1080' : list[0]}]:`)
  const picked = list[Number(qIn) - 1] || list.find(q => q === qIn) || null
  const quality = normalizeQuality(format, picked)

  const spin = spinnerStart('Nyiapin sesi & captcha...')
  const t0 = Date.now()
  let result
  try {
    const fileUrl = await convert(videoId, format, quality, (msg, frac) => spin.update(msg, frac))
    const meta = await fetchMeta(videoId)
    result = { fileUrl, meta }
  } catch (err) {
    spin.stop()
    console.log(`   ${red}${bold}✘ Gagal:${reset} ${red}${err.message}${reset}`)
    return waitEnter()
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  spin.stop()
  console.log(`   ${green}${bold}✔ Beres dalam ${secs} detik!${reset}`)
  console.log(`   ${gray}Judul ${reset}: ${yellow}${result.meta.title}${reset}`)
  console.log(`   ${gray}Format${reset}: ${white}${format} ${qualityLabel(format, quality)}${reset}`)
  console.log(`   ${gray}URL   ${reset}: ${cyan}${bold}${result.fileUrl}${reset}`)
  console.log()
  console.log(`   ${gray}Mau gimana?${reset} ${white}[1]${reset} Download langsung ke file   ${white}[2]${reset} Lewat link aja (manual)`)
  const mode = await ask('Pilih [1]:')
  if (mode === '2') {
    console.log(`   ${green}${bold}✔ Link siap${reset} ${gray}tinggal paste di browser / download manager${reset}`)
    return waitEnter()
  }
  try {
    const fileName = safeName(result.meta.title, format)
    console.log(`   ${gray}File   ${reset}: ${white}${fileName}${reset}`)
    const { outPath, size } = await downloadToFile(result.fileUrl, fileName)
    console.log(`   ${green}${bold}✔ Tersimpan${reset} ${gray}:${reset} ${white}${outPath}${reset} ${gray}(${fmtSize(size)})${reset}`)
  } catch (err) {
    console.log(`   ${red}${bold}✘ Gagal:${reset} ${red}${err.message}${reset}`)
  }
  await waitEnter()
}

async function doStartServer() {
  const spin = spinnerStart('Nyalain API server...')
  try {
    await startServer()
    serverOn = true
    spin.stop()
    console.log(`   ${green}${bold}✔ Server jalan di http://localhost:${serverPort()}${reset}`)
    console.log(`   ${gray}Web UI   ${reset}: ${cyan}http://localhost:${serverPort()}/${reset}`)
    console.log(`   ${gray}Endpoint ${reset}: ${white}/api/info  /api/download${reset}`)
  } catch (err) {
    spin.stop()
    console.log(`   ${red}${bold}✘ Gagal:${reset} ${red}${err.message}${reset}`)
  }
  await waitEnter()
}

async function doStopServer() {
  const ok = await stopServer()
  serverOn = false
  console.log(ok
    ? `   ${yellow}${bold}■ Server dimatiin${reset}`
    : `   ${gray}Server emang lagi gak jalan${reset}`)
  await waitEnter()
}

async function doSetSolver() {
  const cur = getCapsolverUrl()
  console.log(cur
    ? `   ${gray}CapSolver sekarang:${reset} ${cyan}${cur}${reset}`
    : `   ${gray}CapSolver sekarang:${reset} ${yellow}LOCAL (solve di device ini)${reset}`)
  console.log(`   ${gray}Isi URL CapSolver buat mindahin beban solve ke server.${reset}`)
  const url = await ask('URL CapSolver (kosongkan buat LOCAL):')
  const clean = url.replace(/\/+$/, '')
  if (clean && !/^https?:\/\//.test(clean)) {
    console.log(`   ${red}${bold}✘ Gagal:${reset} ${red}URL harus http(s)://...${reset}`)
    return waitEnter()
  }
  setCapsolverUrl(clean)
  console.log(clean
    ? `   ${green}${bold}✔ CapSolver remote aktif${reset}`
    : `   ${yellow}${bold}■ Balik ke mode LOCAL${reset}`)
  await waitEnter()
}

async function runSelected() {
  busy = true
  try {
    if (selected === 0) await doStartServer()
    else if (selected === 1) await doStopServer()
    else if (selected === 2) await doInfo()
    else if (selected === 3) await doDownload()
    else if (selected === 4) await doSetSolver()
    else {
      await stopServer()
      console.log(`\n   ${cyan}${bold}Dadah!${reset} ${gray}~ XyncTeam${reset}\n`)
      process.exit(0)
    }
  } finally {
    busy = false
    render()
  }
}

readline.emitKeypressEvents(process.stdin)
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.on('keypress', (str, key = {}) => {
  if (promptMode || busy) return
  if (key.ctrl && key.name === 'c') {
    stopServer().then(() => {
      console.log(`\n   ${cyan}${bold}Dadah!${reset} ${gray}~ XyncTeam${reset}\n`)
      process.exit(0)
    })
    return
  }
  if (key.name === 'up') { selected = (selected + MENU.length - 1) % MENU.length; render() }
  else if (key.name === 'down') { selected = (selected + 1) % MENU.length; render() }
  else if (key.name === 'return' || key.name === 'enter') runSelected()
  else if (/^[1-6]$/.test(str)) { selected = Number(str) - 1; render() }
})

render()
