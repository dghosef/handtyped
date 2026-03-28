let _startTime = Date.now()
let _timerInterval = null
let _currentWords = 0

const GOAL_KEY = 'humanproof_word_goal'

export function initUI() {
  _startTime = Date.now()
  _timerInterval = setInterval(_tick, 1000)
  _initGoalUI()
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
  _currentWords = words
  _set('word-count', `${words.toLocaleString()} word${words !== 1 ? 's' : ''}`)
  _set('char-count', `${chars.toLocaleString()} chars`)
  _set('page-count', `Page 1 of ${pages}`)
  _set('reading-time', `~${mins} min read`)
  _updateGoalProgress(words)
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

// ── Word goal ────────────────────────────────────────────────────────────────

function _getGoal() {
  try {
    const v = localStorage.getItem(GOAL_KEY)
    const n = v ? parseInt(v, 10) : 0
    return n > 0 ? n : 0
  } catch (_) {
    return 0
  }
}

function _setGoal(n) {
  try {
    if (n > 0) localStorage.setItem(GOAL_KEY, String(n))
    else localStorage.removeItem(GOAL_KEY)
  } catch (_) {}
}

function _initGoalUI() {
  const setBtn    = document.getElementById('word-goal-set-btn')
  const inputWrap = document.getElementById('word-goal-input-wrap')
  const input     = document.getElementById('word-goal-input')
  const okBtn     = document.getElementById('word-goal-ok')
  const cancelBtn = document.getElementById('word-goal-cancel')
  const clearBtn  = document.getElementById('word-goal-clear')

  if (!setBtn) return  // DOM not available (e.g. unit test env)

  function showSetForm() {
    if (inputWrap) inputWrap.classList.add('visible')
    if (setBtn) setBtn.style.display = 'none'
    if (input) { input.value = ''; input.focus() }
  }

  function hideSetForm() {
    if (inputWrap) inputWrap.classList.remove('visible')
    if (setBtn) setBtn.style.display = ''
  }

  function commitGoal() {
    const v = input ? parseInt(input.value, 10) : 0
    if (v > 0) {
      _setGoal(v)
      _updateGoalProgress(_currentWords)
    }
    hideSetForm()
  }

  setBtn.addEventListener('click', showSetForm)

  if (okBtn) okBtn.addEventListener('click', commitGoal)

  if (input) {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); commitGoal() }
      if (e.key === 'Escape') { hideSetForm() }
    })
  }

  if (cancelBtn) cancelBtn.addEventListener('click', hideSetForm)

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      _setGoal(0)
      _updateGoalProgress(_currentWords)
    })
  }

  // Restore saved goal on startup
  _updateGoalProgress(_currentWords)
}

function _updateGoalProgress(words) {
  const goal = _getGoal()
  const progress  = document.getElementById('word-goal-progress')
  const label     = document.getElementById('word-goal-label')
  const bar       = document.getElementById('word-goal-bar')
  const setBtn    = document.getElementById('word-goal-set-btn')
  const inputWrap = document.getElementById('word-goal-input-wrap')

  if (!progress) return

  if (goal <= 0) {
    progress.classList.remove('visible')
    if (setBtn) setBtn.style.display = ''
    return
  }

  // Hide the "Goal" button when a goal is active (unless input form is open)
  if (setBtn && inputWrap && !inputWrap.classList.contains('visible')) {
    setBtn.style.display = 'none'
  }

  const pct = Math.min(100, Math.round((words / goal) * 100))
  const done  = pct >= 100
  const close = !done && pct >= 90

  if (label) {
    label.textContent = `${words.toLocaleString()} / ${goal.toLocaleString()} (${pct}%)`
    label.className = done ? 'goal-done' : (close ? 'goal-close' : '')
  }

  if (bar) {
    bar.style.width = `${pct}%`
    bar.className = done ? 'goal-done' : (close ? 'goal-close' : '')
  }

  progress.classList.add('visible')
}

export function teardownUI() {
  if (_timerInterval) clearInterval(_timerInterval)
}
