/**
 * Run async tasks with a concurrency limit.
 * @param {Array<() => Promise>} tasks - Array of thunks returning promises
 * @param {number} limit - Max concurrent tasks
 * @returns {Promise<Array>} Results in order
 */
export async function runWithConcurrency(tasks, limit) {
  const results = new Array(tasks.length)
  let nextIndex = 0

  async function worker() {
    while (nextIndex < tasks.length) {
      const idx = nextIndex++
      results[idx] = await tasks[idx]()
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker())
  await Promise.all(workers)
  return results
}
