import { requireAuth } from '../middleware/auth.js'
import { getConfig } from './config.js'
import { reclaimTargets } from './media.js'
import { encoderServer, sidecar, filesFor, CQ_PRESETS, encodeSweep, startBatch, publicBatches, dismissBatch } from '../encode.js'

// GPU re-encode (see server/encode.js and scripts/encode-sidecar.py).
//   GET    /status           is an encoder configured, and its jobs
//   POST   /preview          { items } → the files they cover, with warnings
//   POST   /queue            { items, cq?: { movie, tv } } → queue every file
//   POST   /jobs/:id/cancel
//   DELETE /jobs/:id         forget a finished job
// `items` are Reclaim candidates: { proxyBase, arrId, unit, seasonNumber? }.

const MAX_FILES = 500

async function resolveItems(config, server, items) {
  if (!Array.isArray(items) || !items.length) throw Object.assign(new Error('items required'), { status: 400 })
  const targets = reclaimTargets(config)
  const out = []
  const errors = []
  for (const item of items) {
    const target = targets.find((t) => t.proxyBase === item.proxyBase)
    if (!target || !Number.isInteger(Number(item.arrId))) { errors.push(`Unknown item ${item.proxyBase}:${item.arrId}`); continue }
    try {
      for (const f of await filesFor({ arrId: Number(item.arrId), seasonNumber: item.unit === 'season' ? item.seasonNumber : null }, target, server)) {
        out.push({ ...f, proxyBase: target.proxyBase, arrId: Number(item.arrId) })
      }
    } catch (err) {
      errors.push(err.message)
    }
  }
  return { files: out.slice(0, MAX_FILES), truncated: out.length > MAX_FILES, errors }
}

const validCq = (n, fallback) => (Number.isInteger(Number(n)) && Number(n) >= 15 && Number(n) <= 40 ? Number(n) : fallback)

export default async function encodeRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth)

  fastify.get('/status', async () => {
    const config = await getConfig()
    const server = encoderServer(config)
    if (!server) return { configured: false, presets: CQ_PRESETS }
    try {
      const data = await sidecar(server, '/jobs')
      return { configured: true, reachable: true, server: server.name, presets: CQ_PRESETS, batches: publicBatches(), ...data }
    } catch (err) {
      return { configured: true, reachable: false, server: server.name, presets: CQ_PRESETS, error: err.message, jobs: [], batches: publicBatches() }
    }
  })

  // Every re-encode ever (the sidecar's history.jsonl), with totals.
  fastify.get('/history', async (request, reply) => {
    const server = encoderServer(await getConfig())
    if (!server) return reply.status(400).send({ error: 'No encoder configured' })
    try {
      return await sidecar(server, '/history', { timeout: 20000 })
    } catch (err) {
      return reply.status(502).send({ error: err.message })
    }
  })

  fastify.post('/preview', async (request, reply) => {
    const config = await getConfig()
    const server = encoderServer(config)
    if (!server) return reply.status(400).send({ error: 'No encoder configured' })
    try {
      return await resolveItems(config, server, request.body?.items)
    } catch (err) {
      return reply.status(err.status ?? 502).send({ error: err.message })
    }
  })

  fastify.post('/queue', async (request, reply) => {
    const config = await getConfig()
    const server = encoderServer(config)
    if (!server) return reply.status(400).send({ error: 'No encoder configured' })
    const cq = { movie: validCq(request.body?.cq?.movie, CQ_PRESETS.movie), tv: validCq(request.body?.cq?.tv, CQ_PRESETS.tv) }
    let resolved
    try {
      resolved = await resolveItems(config, server, request.body?.items)
    } catch (err) {
      return reply.status(err.status ?? 502).send({ error: err.message })
    }
    let queued = 0
    const errors = [...resolved.errors]
    const jobIds = [], labels = []
    for (const f of resolved.files) {
      try {
        const job = await sidecar(server, '/jobs', {
          method: 'POST',
          body: { path: f.path, cq: cq[f.kind], label: f.label, meta: { proxyBase: f.proxyBase, arrId: f.arrId, kind: f.kind } },
        })
        queued += 1
        if (job?.id) { jobIds.push(job.id); labels.push(f.label) }
      } catch (err) {
        errors.push(`${f.label}: ${err.message}`)
      }
    }
    const batch = startBatch(jobIds, labels)
    return { queued, errors, truncated: resolved.truncated, batch: batch?.id ?? null }
  })

  fastify.post('/batches/:id/dismiss', async (request) => {
    dismissBatch(request.params.id)
    return { ok: true }
  })

  fastify.post('/jobs/:id/cancel', async (request, reply) => {
    const server = encoderServer(await getConfig())
    if (!server) return reply.status(400).send({ error: 'No encoder configured' })
    if (!/^[0-9a-f-]{36}$/.test(request.params.id)) return reply.status(400).send({ error: 'Bad id' })
    try {
      return await sidecar(server, `/jobs/${request.params.id}/cancel`, { method: 'POST' })
    } catch (err) {
      return reply.status(502).send({ error: err.message })
    }
  })

  fastify.delete('/jobs/:id', async (request, reply) => {
    const server = encoderServer(await getConfig())
    if (!server) return reply.status(400).send({ error: 'No encoder configured' })
    if (!/^[0-9a-f-]{36}$/.test(request.params.id)) return reply.status(400).send({ error: 'Bad id' })
    try {
      // Make sure MediaOps has done its rescan before the job is forgotten.
      await encodeSweep()
      return await sidecar(server, `/jobs/${request.params.id}`, { method: 'DELETE' })
    } catch (err) {
      return reply.status(502).send({ error: err.message })
    }
  })
}
