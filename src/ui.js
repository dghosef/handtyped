let _currentWords = 0

export function initUI() {}

export function updateDocStats(text) {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  const chars = text.length
  const pages = Math.max(1, Math.ceil(words / 250))
  const mins = Math.max(1, Math.ceil(words / 200))
  _currentWords = words
  _set('char-count', `${chars.toLocaleString()} chars`)
  _set('page-count', `Page 1 of ${pages}`)
  _set('reading-time', `~${mins} min read`)
}

export function setSaveStatus(msg) {
  _set('save-status', msg)
  _set('tb-save-status', msg)
}

// kept for backward compat (editor.js still imports it)
export function updateWordCount() {}

function _set(id, text) {
  const el = document.getElementById(id)
  if (el) el.textContent = text
}

export function teardownUI() {}
