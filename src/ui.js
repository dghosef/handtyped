let _startTime = Date.now()
let _timerInterval = null

export function initUI() {
  _startTime = Date.now()
  _timerInterval = setInterval(_tick, 1000)
}

function _tick() {
  const elapsed = Math.floor((Date.now() - _startTime) / 1000)
  const m = String(Math.floor(elapsed / 60)).padStart(2, '0')
  const s = String(elapsed % 60).padStart(2, '0')
  _set('timer', `${m}:${s}`)
}

export function updateDocStats(text) {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  const chars = text.length
  const pages = Math.max(1, Math.ceil(words / 250))
  const mins = Math.max(1, Math.ceil(words / 200))
  _set('word-count', `${words.toLocaleString()} word${words !== 1 ? 's' : ''}`)
  _set('char-count', `${chars.toLocaleString()} chars`)
  _set('page-count', `Page 1 of ${pages}`)
  _set('reading-time', `~${mins} min read`)
}

export function updateKeystrokeCount(count) {
  _set('keystroke-count', `${count.toLocaleString()} keystrokes`)
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

export function teardownUI() {
  if (_timerInterval) clearInterval(_timerInterval)
}
