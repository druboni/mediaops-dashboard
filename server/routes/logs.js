import { requireAuth } from '../middleware/auth.js'
import { getLogs } from '../logBuffer.js'

export default async function logsRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth)

  fastify.get('/', async () => getLogs())
}
