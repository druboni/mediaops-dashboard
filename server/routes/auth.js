export default async function authRoutes(fastify) {
  fastify.post('/login', async () => {
    const token = fastify.jwt.sign({ role: 'admin' }, { expiresIn: '30d' })
    return { token }
  })
}
