const TRUSTED_SIGNER_HEX_RE = /^[0-9a-f]{64}$/

function normalizeSignerHex(value) {
  if (typeof value !== 'string') {
    throw new Error('Trusted signer keys must be strings')
  }

  const normalized = value.trim().toLowerCase()
  if (!TRUSTED_SIGNER_HEX_RE.test(normalized)) {
    throw new Error(`Invalid trusted signer public key: ${value}`)
  }
  return normalized
}

export function parseTrustedSignerAllowlist(input) {
  const allowlist = new Set()

  if (Array.isArray(input)) {
    for (const item of input) {
      const normalized = normalizeSignerHex(item)
      allowlist.add(normalized)
    }
    return allowlist
  }

  if (typeof input !== 'string') {
    return allowlist
  }

  for (const chunk of input.split(/[\s,]+/)) {
    const trimmed = chunk.trim()
    if (!trimmed) {
      continue
    }
    allowlist.add(normalizeSignerHex(trimmed))
  }

  return allowlist
}

export function isTrustedSigner(allowlist, signerPubkeyHex) {
  if (!(allowlist instanceof Set)) {
    return false
  }

  try {
    return allowlist.has(normalizeSignerHex(signerPubkeyHex))
  } catch {
    return false
  }
}
