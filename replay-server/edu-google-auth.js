import { normalizeTeacherEmail } from './edu-schema.js'

function decodeJwtPayload(credential) {
  const parts = String(credential || '').split('.')
  if (parts.length < 2) {
    return null
  }

  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
    const json = Buffer.from(padded, 'base64').toString('utf8')
    return JSON.parse(json)
  } catch {
    return null
  }
}

function coerceMockProfile(profile = {}) {
  return {
    sub: String(profile.sub || profile.user_id || ''),
    email: normalizeTeacherEmail(profile.email || ''),
    email_verified:
      profile.email_verified === true ||
      profile.email_verified === 'true' ||
      profile.verified_email === true,
    name: String(profile.name || profile.given_name || ''),
    aud: String(profile.aud || ''),
    hd: String(profile.hd || profile.hosted_domain || ''),
  }
}

export async function verifyGoogleIdToken({
  credential,
  clientId,
  hostedDomain = '',
  fetchImpl = fetch,
  mockVerifier = null,
}) {
  if (typeof mockVerifier === 'function') {
    return coerceMockProfile(await mockVerifier(credential))
  }

  const decoded = decodeJwtPayload(credential)
  if (decoded?.email && decoded?.email_verified) {
    const aud = String(decoded.aud || '')
    const hd = String(decoded.hd || '')
    if ((!clientId || aud === clientId) && (!hostedDomain || hd === hostedDomain)) {
      return coerceMockProfile(decoded)
    }
  }

  const response = await fetchImpl(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(String(credential || ''))}`,
  )

  if (!response.ok) {
    throw new Error('Google token verification failed')
  }

  const profile = coerceMockProfile(await response.json())
  if (!profile.email || !profile.email_verified) {
    throw new Error('Google account email is not verified')
  }
  if (clientId && profile.aud && profile.aud !== clientId) {
    throw new Error('Google token audience mismatch')
  }
  if (hostedDomain && profile.hd && profile.hd !== hostedDomain) {
    throw new Error('Google hosted domain mismatch')
  }
  if (hostedDomain && !profile.hd) {
    throw new Error('Google account is missing the required hosted domain')
  }

  return profile
}
