import { logEvent } from './sessionLog'

let _focusLossStart = null

function handleVisibility() {
  if (document.hidden) {
    _focusLossStart = performance.now()
    logEvent('focus_loss')
  } else {
    const duration = _focusLossStart != null ? performance.now() - _focusLossStart : 0
    _focusLossStart = null
    logEvent('focus_return', { duration })
  }
}

export function initFocusTracker() {
  document.addEventListener('visibilitychange', handleVisibility)
}

export function teardownFocusTracker() {
  document.removeEventListener('visibilitychange', handleVisibility)
}
