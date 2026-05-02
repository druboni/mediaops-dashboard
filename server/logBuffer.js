const MAX = 300
const entries = []

export function addLog(level, msg, data = {}) {
  entries.push({ time: Date.now(), level, msg, ...data })
  if (entries.length > MAX) entries.shift()
}

export function getLogs() {
  return [...entries].reverse()
}
