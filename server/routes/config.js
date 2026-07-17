import { requireAuth } from '../middleware/auth.js'
import { readFile, writeFile, mkdir, readdir, stat } from 'fs/promises'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'

const BACKUP_DIR = process.env.BACKUP_DIR || join(dirname(fileURLToPath(import.meta.url)), '../../config/backups')

const __dirname = dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = process.env.CONFIG_PATH || join(__dirname, '../../config/config.json')

const DEFAULT_CONFIG = {
  links: [],
  autoDeleteAfterImport: false,
  services: {
    plex:        { enabled: false, url: '', apiKey: '' },
    sonarr:      { enabled: false, url: '', apiKey: '' },
    radarr:      { enabled: false, url: '', apiKey: '' },
    lidarr:      { enabled: false, url: '', apiKey: '' },
    bazarr:      { enabled: false, url: '', apiKey: '' },
    overseerr:   { enabled: false, url: '', apiKey: '' },
    prowlarr:    { enabled: false, url: '', apiKey: '' },
    jackett:     { enabled: false, url: '', apiKey: '' },
    qbittorrent: { enabled: false, url: '', apiKey: '' },
    nzbget:      { enabled: false, url: '', apiKey: '' },
    huntarr:     { enabled: false, url: '', apiKey: '' },
    requestrr:   { enabled: false, url: '', apiKey: '' },
    tautulli:    { enabled: false, url: '', apiKey: '' },
  },
}

export async function getConfig() {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8')
    const saved = JSON.parse(raw)
    // Merge with defaults so new top-level fields (e.g. links) and new
    // service entries are present even on configs created before they existed.
    return {
      ...structuredClone(DEFAULT_CONFIG),
      ...saved,
      services: { ...DEFAULT_CONFIG.services, ...(saved.services ?? {}) },
    }
  } catch {
    return structuredClone(DEFAULT_CONFIG)
  }
}

export async function saveConfig(config) {
  await mkdir(dirname(CONFIG_PATH), { recursive: true })
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2))
}

export default async function configRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth)

  fastify.get('/', async () => {
    return getConfig()
  })

  fastify.put('/', async (request) => {
    const current = await getConfig()
    const updated = { ...current, services: request.body.services }
    if (Array.isArray(request.body.links)) updated.links = request.body.links
    if (typeof request.body.autoDeleteAfterImport === 'boolean')
      updated.autoDeleteAfterImport = request.body.autoDeleteAfterImport
    await saveConfig(updated)
    return updated
  })

  // Download the full config as a backup file
  fastify.get('/backup', async (request, reply) => {
    const config = await getConfig()
    const stamp = new Date().toISOString().slice(0, 10)
    reply
      .header('Content-Type', 'application/json')
      .header('Content-Disposition', `attachment; filename="mediaops-config-${stamp}.json"`)
    return config
  })

  // Restore config from an uploaded backup
  fastify.post('/restore', async (request, reply) => {
    const body = request.body
    if (!body || typeof body !== 'object' || !body.services || typeof body.services !== 'object')
      return reply.status(400).send({ error: 'Invalid backup file: missing services' })

    // Merge onto defaults so a backup from an older version still gets new fields
    const restored = {
      ...structuredClone(DEFAULT_CONFIG),
      ...body,
      services: { ...DEFAULT_CONFIG.services, ...body.services },
    }
    await saveConfig(restored)
    return { ok: true }
  })

  // List automatic weekly backups (most recent first)
  fastify.get('/backups', async () => {
    try {
      const files = (await readdir(BACKUP_DIR)).filter((f) => f.startsWith('auto-') && f.endsWith('.json'))
      const withStats = await Promise.all(
        files.map(async (f) => {
          const s = await stat(join(BACKUP_DIR, f))
          return { name: f, size: s.size, createdAt: s.mtime.toISOString() }
        })
      )
      withStats.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      return withStats
    } catch {
      return []
    }
  })

  fastify.put('/password', async (request, reply) => {
    const { currentPassword, newPassword } = request.body
    const { default: bcrypt } = await import('bcryptjs')
    const config = await getConfig()

    if (!newPassword || newPassword.length < 8)
      return reply.status(400).send({ error: 'New password must be at least 8 characters' })
    const valid = await bcrypt.compare(currentPassword, config.adminPasswordHash || '')
    if (!valid) return reply.status(401).send({ error: 'Current password is incorrect' })

    config.adminPasswordHash = await bcrypt.hash(newPassword, 10)
    await saveConfig(config)
    return { ok: true }
  })
}
