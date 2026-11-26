import { parentPort, workerData } from 'node:worker_threads'
import { solveTask } from './cap-protocol.js'

const { tasks, counter, deadline, maxNonce } = workerData

try {
  for (;;) {
    const i = Atomics.add(counter, 0, 1)
    if (i >= tasks.length) break
    parentPort.postMessage({ i, result: solveTask(tasks[i], { deadline, maxNonce }) })
  }
} catch (err) {
  parentPort.postMessage({ error: err.message || 'cap task failed' })
}
