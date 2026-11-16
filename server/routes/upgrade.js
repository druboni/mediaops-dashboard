import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { requireAuth } from '../middleware/auth.js'
import { getConfig } from './config.js'
import { addLog } from '../logBuffer.js'
import { trackReplacement } from '../plexAddedAt.js'

// "Upgrade to 4K" on a movie or show. The library's Ultra-HD profiles allow
// only 2160p but have upgrades off, so moving a title with a 1080p file onto
// one finds nothing to do. Instead this keeps a "4K Upgrade" profile in each
// *arr: a copy of Ultra-HD (same language custom formats) with upgrades on and
// the cutoff at its lowest 2160p quality, so the first 4K file ends it. The
// title moves onto it and gets a search; the *arr swaps the 1080p file out
// when the 4K one imports, so there's no gap. The previous profile is kept in
// upgrade-4k.json so the upgrade can be cancelled.

const __dirname = dirname(fileURLToPath(import.meta.url))
const CONFIG_DIR = process.env.CONFIG_PATH ? dirname(process.env.CONFIG_PATH) : join(__dirname, '../../config')
const STATE_PATH = join(CONFIG_DIR, 'upgrade-4k.json')
export const UPGRADE_PROFILE = '4K Upgrade'

const KINDS = { movie: { app: 'radarr', path: 'movie' }, series: { app: 'sonarr', path: 'series' } }

function loadState() {
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')) } catch { return {} }
}
function saveState(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true })
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))
}

const arr = (svc) => {
  const base = svc.url.replace(/\/$/, '')
  return async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(`${base}/api/v3${path}`, {
      method,
      headers: { 'X-Api-Key': svc.apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw Object.assign(new Error(`${method} ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`), { status: 502 })
    const text = await res.text()
    return text ? JSON.parse(text) : null
  }
}

const is2160 = (name) => /2160p/i.test(name ?? '')
// A profile item is a quality or a group of them.
const itemQualities = (item) => (item.quality ? [item.quality] : (item.items ?? []).map((i) => i.quality))

/** The 4K Upgrade profile's id, creating it from the Ultra-HD profile the first time. */
async function ensureUpgradeProfile(call) {
  const profiles = await call('/qualityprofile')
  const existing = profiles.find((p) => p.name === UPGRADE_PROFILE)
  if (existing) return existing
  const base = profiles.find((p) => p.name === 'Ultra-HD')
    ?? profiles.find((p) => {
      const allowed = p.items.filter((i) => i.allowed).flatMap(itemQualities)
      return allowed.length && allowed.every((q) => is2160(q.name))
    })
  if (!base) throw Object.assign(new Error('No 2160p-only quality profile to copy (expected one named Ultra-HD)'), { status: 409 })
  // Items run lowest to highest, so the first allowed 2160p one is the lowest.
  const lowest = base.items.find((i) => i.allowed && itemQualities(i).some((q) => is2160(q.name)))
  const { id, ...copy } = base
  return call('/qualityprofile', {
    method: 'POST',
    body: { ...copy, name: UPGRADE_PROFILE, upgradeAllowed: true, cutoff: lowest.id ?? lowest.quality.id },
  })
}

export default async function upgradeRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth)

  fastify.post('/:kind/:id', async (request, reply) => {
    const kind = KINDS[request.params.kind]
    const id = Number(request.params.id)
    if (!kind || !Number.isInteger(id)) return reply.status(400).send({ error: 'Invalid item' })
    const svc = (await getConfig()).services[kind.app]
    if (!svc?.enabled) return reply.status(400).send({ error: `${kind.app} not enabled` })
    const call = arr(svc)
    try {
      const profile = await ensureUpgradeProfile(call)
      const item = await call(`/${kind.path}/${id}`)
      const state = loadState()
      const key = `${kind.app}:${id}`
      if (item.qualityProfileId !== profile.id) {
        state[key] = { previousProfileId: item.qualityProfileId, title: item.title, startedAt: new Date().toISOString() }
        saveState(state)
        await call(`/${kind.path}/${id}`, { method: 'PUT', body: { ...item, qualityProfileId: profile.id } })
      }
      await call('/command', {
        method: 'POST',
        body: kind.app === 'radarr' ? { name: 'MoviesSearch', movieIds: [id] } : { name: 'SeriesSearch', seriesId: id },
      })
      // The 4K files replace old ones; keep them off Plex's Recently Added like other replacements.
      if (kind.app === 'radarr') {
        trackReplacement({ app: 'radarr', movieId: id, title: `${item.title} (4K)` })
      } else {
        for (const s of item.seasons ?? []) {
          if (s.statistics?.episodeFileCount) trackReplacement({ app: 'sonarr', seriesId: id, seasonNumber: s.seasonNumber, title: `${item.title} S${s.seasonNumber} (4K)` })
        }
      }
      addLog('info', `[upgrade] ${item.title}: moved to "${UPGRADE_PROFILE}" and searching for 4K`, { service: kind.app })
      return { ok: true, profile: profile.name }
    } catch (err) {
      addLog('error', `[upgrade] ${kind.app} ${id}: ${err.message}`, { service: kind.app })
      return reply.status(err.status ?? 502).send({ error: err.message })
    }
  })

  // Put the title back on the profile it had before.
  fastify.delete('/:kind/:id', async (request, reply) => {
    const kind = KINDS[request.params.kind]
    const id = Number(request.params.id)
    if (!kind || !Number.isInteger(id)) return reply.status(400).send({ error: 'Invalid item' })
    const svc = (await getConfig()).services[kind.app]
    if (!svc?.enabled) return reply.status(400).send({ error: `${kind.app} not enabled` })
    const call = arr(svc)
    const state = loadState()
    const key = `${kind.app}:${id}`
    const saved = state[key]
    if (!saved) return reply.status(404).send({ error: 'No 4K upgrade to cancel for this title' })
    try {
      const item = await call(`/${kind.path}/${id}`)
      await call(`/${kind.path}/${id}`, { method: 'PUT', body: { ...item, qualityProfileId: saved.previousProfileId } })
      delete state[key]
      saveState(state)
      addLog('info', `[upgrade] ${item.title}: 4K upgrade cancelled, back on its previous profile`, { service: kind.app })
      return { ok: true }
    } catch (err) {
      return reply.status(err.status ?? 502).send({ error: err.message })
    }
  })
}
