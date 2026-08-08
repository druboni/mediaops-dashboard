import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'

// Key is derived from JWT_SECRET so no extra required env var — if you rotate
// JWT_SECRET, previously-encrypted values fail closed to '' rather than throwing
// (see decryptValue), so services just show as needing their key re-entered.
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production'
const KEY = scryptSync(SECRET, 'mediaops-config-v1', 32)
const PREFIX = 'enc:v1:'

export function encryptValue(plain) {
  if (!plain) return plain
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', KEY, iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return PREFIX + Buffer.concat([iv, tag, enc]).toString('base64')
}

// Passes through anything that isn't our ciphertext format — this is what
// lets pre-encryption config.json files keep working with no migration step.
export function decryptValue(value) {
  if (!value || !value.startsWith(PREFIX)) return value
  try {
    const raw = Buffer.from(value.slice(PREFIX.length), 'base64')
    const iv = raw.subarray(0, 12)
    const tag = raw.subarray(12, 28)
    const enc = raw.subarray(28)
    const decipher = createDecipheriv('aes-256-gcm', KEY, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
  } catch {
    return '' // wrong key (e.g. JWT_SECRET rotated) or corrupted — fail closed
  }
}
