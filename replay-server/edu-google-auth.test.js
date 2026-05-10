import { describe, expect, it } from 'vitest'

import { verifyGoogleIdToken } from './edu-google-auth.js'

function unsignedGoogleishToken(payload = {}) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `header.${body}.signature`
}

describe('verifyGoogleIdToken', () => {
  it('does not trust a locally decodable Google-looking token without Google verification', async () => {
    const forgedCredential = unsignedGoogleishToken({
      sub: 'attacker',
      email: 'teacher@edu.handtyped.app',
      email_verified: true,
      aud: 'expected-client-id',
    })

    await expect(
      verifyGoogleIdToken({
        credential: forgedCredential,
        clientId: 'expected-client-id',
        fetchImpl: async () => ({
          ok: false,
          json: async () => ({}),
        }),
      }),
    ).rejects.toThrow('Google token verification failed')
  })

  it('requires the verified token audience to match the configured client id', async () => {
    await expect(
      verifyGoogleIdToken({
        credential: 'verified-by-google',
        clientId: 'expected-client-id',
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({
            sub: 'google-subject',
            email: 'teacher@edu.handtyped.app',
            email_verified: 'true',
            aud: 'different-client-id',
          }),
        }),
      }),
    ).rejects.toThrow('Google token audience mismatch')
  })
})
