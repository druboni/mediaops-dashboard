// Shared qBittorrent session cache — used by both dashboard.js and downloads.js
// Prevents hammering the login endpoint when multiple routes poll qBit frequently.
// One session per qBittorrent URL: with two instances (main + MAM) a single
// shared slot made each one log the other out on every poll.
//
// Cookie name changed in qBit 5.x: was "SID", now "QBT_SID_{port}"
// We capture the full "name=value" pair and send it verbatim in Cookie headers.

const sessions = new Map() // url → { cookie, expires }

export function parseQbitCreds(userpass) {
  const sep = (userpass || '').indexOf(':')
  return sep > -1
    ? { username: userpass.slice(0, sep), password: userpass.slice(sep + 1) }
    : { username: 'admin', password: userpass || '' }
}

async function doLogin(url, userpass) {
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
    // success — fall through to cookie extraction
  } else if (res.status === 200) {
    const text = await res.text()
    if (text.trim() !== 'Ok.') throw new Error('qBittorrent auth failed — check credentials')
  } else {
    throw new Error(`qBittorrent auth failed — check credentials (HTTP ${res.status})`)
  }
  // Extract full "Name=Value" from Set-Cookie (works for both SID= and QBT_SID_8080=)
  const cookie = res.headers.get('set-cookie')?.match(/^([^;]+)/)?.[1]
  if (!cookie) throw new Error('No session cookie returned from qBittorrent')
  sessions.set(url, { cookie, expires: Date.now() + 55 * 60 * 1000 })
  return cookie
}

export async function getQbitCookie(url, userpass) {
  const s = sessions.get(url)
  if (s && Date.now() < s.expires) return s.cookie
  return doLogin(url, userpass)
}

// Called when a request using the cached cookie gets a 403/Forbidden —
// clears the stale cookie and logs in fresh.
export async function refreshQbitCookie(url, userpass) {
  sessions.delete(url)
  return doLogin(url, userpass)
}

// Legacy alias — kept so any future callers don't break
export const getQbitSid = getQbitCookie

export function clearQbitCookie(url) {
  if (url) sessions.delete(url)
  else sessions.clear()
}
