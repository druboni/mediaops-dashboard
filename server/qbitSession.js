// Shared qBittorrent session cache — used by both dashboard.js and downloads.js
// Prevents hammering the login endpoint when multiple routes poll qBit frequently.

let cache = { url: null, sid: null, expires: 0 }

export function parseQbitCreds(userpass) {
  const sep = (userpass || '').indexOf(':')
  return sep > -1
    ? { username: userpass.slice(0, sep), password: userpass.slice(sep + 1) }
    : { username: 'admin', password: userpass || '' }
}

export async function getQbitSid(url, userpass) {
  if (cache.url === url && cache.sid && Date.now() < cache.expires) {
    return cache.sid
  }
  const { username, password } = parseQbitCreds(userpass)
  const res = await fetch(`${url}/api/v2/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': url,
      'Referer': `${url}/`,
    },
    body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
    signal: AbortSignal.timeout(5000),
  })
  // qBit 4.x: 200 + "Ok." body = success, "Fails." = wrong creds
  // qBit 5.x: 204 No Content = success, 401 = wrong creds / banned
  if (res.status === 204) {
    // success — fall through to SID extraction
  } else if (res.status === 200) {
    const text = await res.text()
    if (text.trim() !== 'Ok.') throw new Error('qBittorrent auth failed — check credentials')
  } else {
    throw new Error(`qBittorrent auth failed — check credentials (HTTP ${res.status})`)
  }
  const sid = res.headers.get('set-cookie')?.match(/SID=([^;]+)/)?.[1]
  if (!sid) throw new Error('No session cookie returned from qBittorrent')
  cache = { url, sid, expires: Date.now() + 55 * 60 * 1000 }
  return sid
}

export function clearQbitSid() {
  cache = { url: null, sid: null, expires: 0 }
}
