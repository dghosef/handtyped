// Word count, session timer, dark mode, status bar updates

let _startTime = Date.now()
let _timerInterval = null

export function initUI() {
  _startTime = Date.now()
  _timerInterval = setInterval(updateTimer, 1000)

  document.getElementById('btn-dark').addEventListener('click', () => {
    document.body.classList.toggle('dark')
  })
}

export function updateWordCount(text) {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  document.getElementById('word-count').textContent = `${words} word${words !== 1 ? 's' : ''}`
}

export function updateKeystrokeCount(count) {
  document.getElementById('keystroke-count').textContent = `${count} keystrokes`
}

export function setSaveStatus(msg) {
  document.getElementById('save-status').textContent = msg
}

function updateTimer() {
  const elapsed = Math.floor((Date.now() - _startTime) / 1000)
  const m = String(Math.floor(elapsed / 60)).padStart(2, '0')
  const s = String(elapsed % 60).padStart(2, '0')
  document.getElementById('timer').textContent = `${m}:${s}`
}

export function teardownUI() {
  if (_timerInterval) clearInterval(_timerInterval)
}
