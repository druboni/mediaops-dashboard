import { readdir, mkdir, writeFile, unlink, stat } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { getConfig } from './routes/config.js'
import { addLog } from './logBuffer.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BACKUP_DIR = process.env.BACKUP_DIR || join(__dirname, '../config/backups')

const INTERVAL_MS = 7 * 24 * 60 * 60 * 1000 // weekly
const KEEP = 8
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000 // check every 6h so a missed week catches up quickly

async function latestBackupAge() {
  try {
    const files = (await readdir(BACKUP_DIR)).filter((f) => f.startsWith('auto-') && f.endsWith('.json'))
    if (files.length === 0) return Infinity
    const stats = await Promise.all(files.map((f) => stat(join(BACKUP_DIR, f))))
    const newest = Math.max(...stats.map((s) => s.mtimeMs))
    return Date.now() - newest
  } catch {
    return Infinity
  }
}

async function pruneOld() {
  const files = (await readdir(BACKUP_DIR)).filter((f) => f.startsWith('auto-') && f.endsWith('.json'))
  if (files.length <= KEEP) return
  const withTimes = await Promise.all(
    files.map(async (f) => ({ f, mtime: (await stat(join(BACKUP_DIR, f))).mtimeMs }))
  )
  withTimes.sort((a, b) => a.mtime - b.mtime)
  const toDelete = withTimes.slice(0, withTimes.length - KEEP)
  for (const { f } of toDelete) await unlink(join(BACKUP_DIR, f))
}

async function runBackupIfDue() {
  await mkdir(BACKUP_DIR, { recursive: true })
  const age = await latestBackupAge()
  if (age < INTERVAL_MS) return

  const config = await getConfig()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const path = join(BACKUP_DIR, `auto-${stamp}.json`)
  await writeFile(path, JSON.stringify(config, null, 2))
  await pruneOld()
  addLog('info', `[autoBackup] wrote ${path}`, { service: 'system' })
}

export function startAutoBackup() {
  runBackupIfDue().catch((err) => addLog('warn', `[autoBackup] failed: ${err.message}`, { service: 'system' }))
  setInterval(() => {
    runBackupIfDue().catch((err) => addLog('warn', `[autoBackup] failed: ${err.message}`, { service: 'system' }))
  }, CHECK_EVERY_MS)
}

export { BACKUP_DIR }
