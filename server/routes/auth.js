import bcrypt from 'bcryptjs'
import { getConfig, saveConfig } from './config.js'

export default async function authRoutes(fastify) {
  fastify.post('/login', async (request, reply) => {
    const { password } = request.body
    if (!password) return reply.status(400).send({ error: 'Password required' })

    const config = await getConfig()

    if (!config.adminPasswordHash) {
      const adminPassword = process.env.ADMIN_PASSWORD || 'changeme'
      config.adminPasswordHash = await bcrypt.hash(adminPassword, 10)
      await saveConfig(config)
    }

    const valid = await bcrypt.compare(password, config.adminPasswordHash)
    if (!valid) return reply.status(401).send({ error: 'Invalid password' })

    const token = fastify.jwt.sign({ role: 'admin' }, { expiresIn: '7d' })
    return { token }
  })
}
