const DEFAULT_UPLOAD_RATE_LIMIT_COUNT = 20
const DEFAULT_UPLOAD_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function normalizeClientIp(ip) {
  if (typeof ip !== 'string') {
    return 'unknown'
  }

  const trimmed = ip.trim()
  return trimmed.length > 0 ? trimmed.toLowerCase() : 'unknown'
}

function logEvent(logger, level, event) {
  const line = JSON.stringify(event)
  if (logger && typeof logger[level] === 'function') {
    logger[level](line)
    return
  }

  if (level === 'warn' && logger && typeof logger.log === 'function') {
    logger.log(line)
    return
  }

  if (level === 'info' && logger && typeof logger.log === 'function') {
    logger.log(line)
    return
  }

  if (level === 'warn') {
    console.warn(line)
    return
  }

  console.log(line)
}

export function resolveReplayUploadRateLimit(config = {}, env = process.env) {
  const count = parsePositiveInteger(
    config.uploadRateLimitCount ?? env.REPLAY_UPLOAD_RATE_LIMIT_COUNT,
    DEFAULT_UPLOAD_RATE_LIMIT_COUNT,
  )
  const windowMs = parsePositiveInteger(
    config.uploadRateLimitWindowMs ?? env.REPLAY_UPLOAD_RATE_LIMIT_WINDOW_MS,
    DEFAULT_UPLOAD_RATE_LIMIT_WINDOW_MS,
  )

  return { count, windowMs }
}

export function createReplayGuardrails({
  uploadRateLimitCount = DEFAULT_UPLOAD_RATE_LIMIT_COUNT,
  uploadRateLimitWindowMs = DEFAULT_UPLOAD_RATE_LIMIT_WINDOW_MS,
  logger = console,
  serverName = 'replay-server',
} = {}) {
  const buckets = new Map()
  const stats = {
    total_upload_attempts: 0,
    accepted_uploads: 0,
    rejected_uploads: 0,
    rate_limited_uploads: 0,
    last_success_at: null,
    last_failure_at: null,
    last_failure_reason: null,
    last_failure_ip: null,
  }

  function cleanupBucket(bucket, nowMs) {
    while (bucket.length > 0 && nowMs - bucket[0] >= uploadRateLimitWindowMs) {
      bucket.shift()
    }
  }

  function checkUploadRateLimit(clientIp, nowMs = Date.now()) {
    const key = normalizeClientIp(clientIp)
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = []
      buckets.set(key, bucket)
    }

    cleanupBucket(bucket, nowMs)
    if (bucket.length >= uploadRateLimitCount) {
      const oldest = bucket[0] ?? nowMs
      return {
        allowed: false,
        retryAfterMs: Math.max(1_000, uploadRateLimitWindowMs - (nowMs - oldest)),
        currentCount: bucket.length,
        limit: uploadRateLimitCount,
      }
    }

    bucket.push(nowMs)
    return {
      allowed: true,
      currentCount: bucket.length,
      limit: uploadRateLimitCount,
    }
  }

  function recordUploadAttempt({ ok, reason = null, ip = 'unknown', sessionId = null }) {
    const now = new Date().toISOString()
    const normalizedIp = normalizeClientIp(ip)
    stats.total_upload_attempts += 1

    if (ok) {
      stats.accepted_uploads += 1
      stats.last_success_at = now
    } else {
      stats.rejected_uploads += 1
      stats.last_failure_at = now
      stats.last_failure_reason = reason
      stats.last_failure_ip = normalizedIp
      if (reason === 'rate_limited') {
        stats.rate_limited_uploads += 1
      }
    }

    logEvent(logger, ok ? 'info' : 'warn', {
      event: 'replay.upload',
      server: serverName,
      ok,
      reason,
      ip: normalizedIp,
      session_id: sessionId,
      timestamp: now,
      totals: { ...stats },
    })
  }

  function snapshotHealth({
    replayOnly = true,
    trustedSignerSource = 'missing',
    trustedSignerCount = 0,
  } = {}) {
    return {
      ok: true,
      replay_only: replayOnly,
      trusted_signer_source: trustedSignerSource,
      trusted_signer_count: trustedSignerCount,
      rate_limit: {
        count: uploadRateLimitCount,
        window_ms: uploadRateLimitWindowMs,
      },
      uploads: { ...stats },
    }
  }

  return {
    checkUploadRateLimit,
    recordUploadAttempt,
    snapshotHealth,
  }
}
