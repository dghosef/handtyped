let _log = []
let _sessionId = null
let _sessionStart = null

export function initSession() {
  _log = []
  _sessionId = crypto.randomUUID()
  _sessionStart = performance.now()
  return _sessionId
}

export function getSessionId() { return _sessionId }
export function getLog() { return _log }
export function getSessionDurationMs() { return performance.now() - (_sessionStart ?? performance.now()) }

export function logTransaction({ position, deletedText, insertedText, surroundingBefore, surroundingAfter }) {
  _log.push({
    type: 'transaction',
    timestamp: performance.now(),
    position,
    deleted_text: deletedText,
    inserted_text: insertedText,
    surrounding_before: surroundingBefore,
    surrounding_after: surroundingAfter
  })
}

export function logEvent(type, extra = {}) {
  _log.push({ type, timestamp: performance.now(), ...extra })
}
