import { appendFileSync, existsSync, readFileSync, renameSync, mkdirSync, statSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CONFIG_DIR = process.env.CONFIG_PATH ? dirname(process.env.CONFIG_PATH) : join(__dirname, '../config')
const LOG_PATH = process.env.LOG_PATH || join(CONFIG_DIR, 'app.log')
const MAX_FILE_BYTES = 5 * 1024 * 1024 // rotate to a single .1 backup past this size

const MAX = 500
const entries = []

// Reload recent history from disk on boot so a container restart doesn't wipe the trail.
function loadFromDisk() {
  try {
    const raw = readFileSync(LOG_PATH, 'utf8')
    const lines = raw.split('\n').filter(Boolean).slice(-MAX)
    for (const line of lines) {
      try { entries.push(JSON.parse(line)) } catch { /* skip a malformed line */ }
    }
  } catch { /* no log file yet */ }
}
loadFromDisk()

export function addLog(level, msg, data = {}) {
  const entry = { time: Date.now(), level, msg, ...data }
  entries.push(entry)
  if (entries.length > MAX) entries.shift()

  try {
    mkdirSync(CONFIG_DIR, { recursive: true })
    if (existsSync(LOG_PATH) && statSync(LOG_PATH).size > MAX_FILE_BYTES) {
      renameSync(LOG_PATH, `${LOG_PATH}.1`)
    }
    appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n')
  } catch { /* best-effort — a logging failure should never break the caller */ }
}

export function getLogs() {
  return [...entries].reverse()
}
