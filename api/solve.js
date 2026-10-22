import { solveCap } from '../src/cap.js'

const SOLVER = 'https://check.dlsrv.online/30bb427100/'

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  try {
    const t0 = Date.now()
    const capToken = await solveCap(SOLVER)
    res.status(200).json({ status: 'ok', capToken, solvedIn: Date.now() - t0 })
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}
