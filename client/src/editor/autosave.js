import { getLog, getSessionId } from './sessionLog'

let _timer = null

export function startAutosave(intervalMs = 30000) {
  _timer = setInterval(async () => {
    const id = getSessionId()
    const log = getLog()
    if (!id || !log.length) return
    try {
      await fetch(`/api/sessions/${id}/autosave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ log })
      })
    } catch (e) {
      console.warn('Autosave failed', e)
    }
  }, intervalMs)
}

export function stopAutosave() {
  if (_timer) clearInterval(_timer)
  _timer = null
}
