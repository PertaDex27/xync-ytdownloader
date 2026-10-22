import { spawn } from 'node:child_process'
import { startServer, serverPort } from './src/server.js'

const port = serverPort()

startServer()
  .then(() => {
    const url = `http://localhost:${port}`
    console.log(`web jalan di ${url}`)
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
    try { spawn(opener, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref() } catch {}
  })
  .catch(err => {
    console.error(`gagal jalan: ${err.message}`)
    process.exit(1)
  })
