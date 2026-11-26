import { parentPort, workerData } from 'node:worker_threads'
import { solvePow } from './cap.js'

const { pairs, counter } = workerData

for (;;) {
  const i = Atomics.add(counter, 0, 1)
  if (i >= pairs.length) break
  parentPort.postMessage({ i, nonce: solvePow(pairs[i][0], pairs[i][1]) })
}
