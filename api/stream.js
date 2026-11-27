import { handleStream } from '../src/streamProxy.js'

export default async function handler(req, res) {
  try {
    return await handleStream(req, res)
  } catch (err) {
    res.statusCode = 500
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ status: 'error', message: err.message }))
  }
}
