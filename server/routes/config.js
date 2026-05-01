import { requireAuth } from '../middleware/auth.js'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = process.env.CONFIG_PATH || join(__dirname, '../../config/config.json')

const DEFAULT_CONFIG = {
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
  },
}

export async function getConfig() {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8')
    return JSON.parse(raw)
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
    await saveConfig(updated)
    return updated
  })

  fastify.put('/password', async (request, reply) => {
    const { currentPassword, newPassword } = request.body
    const { default: bcrypt } = await import('bcryptjs')
    const config = await getConfig()

    const valid = await bcrypt.compare(currentPassword, config.adminPasswordHash || '')
    if (!valid) return reply.status(401).send({ error: 'Current password is incorrect' })

    config.adminPasswordHash = await bcrypt.hash(newPassword, 10)
    await saveConfig(config)
    return { ok: true }
  })
}
