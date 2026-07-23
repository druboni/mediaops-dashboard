import multipart from '@fastify/multipart'
import { getConfig } from './config.js'

const PLEX_COLOR = 0xe5a00d

function discordPayloadFor(metadata) {
  let title, subtitle

  if (metadata.type === 'episode') {
    title = metadata.grandparentTitle || 'Unknown Show'
    const season = String(metadata.parentIndex ?? 0).padStart(2, '0')
    const episode = String(metadata.index ?? 0).padStart(2, '0')
    subtitle = `S${season}E${episode}${metadata.title ? ` · ${metadata.title}` : ''}`
  } else if (metadata.type === 'track') {
    title = metadata.grandparentTitle || 'Unknown Artist'
    subtitle = [metadata.parentTitle, metadata.title].filter(Boolean).join(' · ')
  } else {
    title = metadata.title || 'Unknown Title'
    subtitle = metadata.year ? `(${metadata.year})` : ''
  }

  return {
    embeds: [{
      title: 'New addition to Plex',
      description: `**${title}**${subtitle ? `\n${subtitle}` : ''}`,
      color: PLEX_COLOR,
      timestamp: new Date().toISOString(),
    }],
  }
}

export default async function webhookRoutes(fastify) {
  await fastify.register(multipart)

  // Plex POSTs multipart/form-data with a "payload" field (JSON string) to this URL.
  // No JWT here — Plex Media Server can't authenticate with our app; the random
  // secret in the path is what keeps this endpoint from being guessable.
  fastify.post('/plex/:secret', async (request, reply) => {
    const config = await getConfig()
    const notif = config.notifications

    if (request.params.secret !== notif.webhookSecret) return reply.status(404).send()
    if (!notif.plexAddedEnabled || !notif.discordWebhookUrl) return reply.status(200).send()

    // Plex's own webhook client sometimes sends the "payload" part with a filename
    // attribute, which makes busboy classify it as type "file" instead of "field" —
    // accept either shape, and drain any other file parts (e.g. "thumb") we skip.
    let payloadJson = null
    for await (const part of request.parts()) {
      if (part.fieldname !== 'payload') {
        if (part.file) part.file.resume()
        continue
      }
      payloadJson = part.type === 'file' ? (await part.toBuffer()).toString('utf8') : part.value
    }
    if (!payloadJson) return reply.status(400).send()

    let event
    try {
      event = JSON.parse(payloadJson)
    } catch {
      return reply.status(400).send()
    }

    if (event.event !== 'library.new') return reply.status(200).send()

    try {
      await fetch(notif.discordWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(discordPayloadFor(event.Metadata || {})),
        signal: AbortSignal.timeout(8000),
      })
    } catch (err) {
      fastify.log.error({ err }, 'Failed to forward Plex webhook to Discord')
    }

    return reply.status(200).send()
  })
}
