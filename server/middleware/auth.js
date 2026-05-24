export async function requireAuth(request, reply) {
  // Routes can opt out of auth (e.g. image proxy endpoints that <img> tags call
  // without Authorization headers) by setting config: { skipAuth: true }
  if (request.routeOptions?.config?.skipAuth) return
  try {
    await request.jwtVerify()
  } catch {
    reply.status(401).send({ error: 'Unauthorized' })
  }
}
