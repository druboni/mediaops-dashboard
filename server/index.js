import Fastify from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import staticFiles from '@fastify/static'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import fs from 'fs'
import authRoutes from './routes/auth.js'
import configRoutes from './routes/config.js'
import servicesRoutes from './routes/services.js'
import dashboardRoutes from './routes/dashboard.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const distPath = join(ROOT, 'dist')

const fastify = Fastify({ logger: { level: 'info' } })

await fastify.register(cors, { origin: true })

await fastify.register(jwt, {
  secret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
})

await fastify.register(authRoutes, { prefix: '/api/auth' })
await fastify.register(configRoutes, { prefix: '/api/config' })
await fastify.register(servicesRoutes, { prefix: '/api/services' })
await fastify.register(dashboardRoutes, { prefix: '/api/dashboard' })

if (fs.existsSync(distPath)) {
  await fastify.register(staticFiles, {
    root: distPath,
    prefix: '/',
    wildcard: false,
  })
  fastify.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      reply.status(404).send({ error: 'Not found' })
    } else {
      reply.sendFile('index.html')
    }
  })
} else {
  fastify.setNotFoundHandler((req, reply) => {
    reply.status(404).send({ error: 'Not found (frontend not built — run npm run build)' })
  })
}

const PORT = parseInt(process.env.PORT || '8080')
await fastify.listen({ port: PORT, host: '127.0.0.1' })
console.log(`MediaOps server running on http://localhost:${PORT}`)
