export function safeJsonLines(raw) {
  return String(raw || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

export function parseKeydowns(raw) {
  return safeJsonLines(raw)
    .filter((entry) => entry.type === 'down' && typeof entry.t === 'number')
    .sort((a, b) => a.t - b.t)
}

export function dedupeHistory(items) {
  return items.filter((entry, index) => {
    if (index === 0) return true
    const prev = items[index - 1]
    return prev.t !== entry.t || prev.text !== entry.text
  })
}

export function getDurationFromKeydowns(keyEvents) {
  if (keyEvents.length < 2) return 0
  return Math.max(0, Math.round((keyEvents[keyEvents.length - 1].t - keyEvents[0].t) / 1e6))
}

export function getDurationFromHistory(entries) {
  if (entries.length < 2) return 0
  return Math.max(0, entries[entries.length - 1].t - entries[0].t)
}

function normalizeHistoryEntries(entries) {
  const normalized = entries.map((entry) => ({
    t: Math.max(0, Number(entry?.t) || 0),
    text: typeof entry?.text === 'string' ? entry.text : '',
  }))

  const firstContentIndex = normalized.findIndex((entry) => entry.text !== '')
  if (firstContentIndex === -1) {
    return [{ t: 0, text: '' }]
  }

  const needsShift = normalized[firstContentIndex].t <= 0
  const shifted = normalized.map((entry, index) => {
    if (index < firstContentIndex) return entry
    return {
      ...entry,
      t: needsShift ? entry.t + 1 : entry.t,
    }
  })

  if (shifted[0].text === '') {
    return shifted
  }

  return [{ t: 0, text: '' }, ...shifted]
}

export function buildSyntheticHistory(finalText, keyEvents) {
  const chars = Array.from(finalText || '')
  if (chars.length === 0) {
    return [{ t: 0, text: '' }]
  }

  const totalDuration =
    getDurationFromKeydowns(keyEvents) || Math.max(chars.length * 45, 1000)
  const usableTimes = keyEvents.length
    ? keyEvents.map((event) => Math.max(0, Math.round((event.t - keyEvents[0].t) / 1e6)))
    : chars.map((_, idx) =>
        Math.round((idx / Math.max(chars.length - 1, 1)) * totalDuration),
      )

  const snapshots = [{ t: 0, text: '' }]
  for (let i = 0; i < chars.length; i++) {
    const fallbackTime = Math.round(((i + 1) / chars.length) * totalDuration)
    snapshots.push({
      t: usableTimes[Math.min(i, usableTimes.length - 1)] ?? fallbackTime,
      text: chars.slice(0, i + 1).join(''),
    })
  }

  return normalizeHistoryEntries(dedupeHistory(snapshots))
}

export function parseHistory(session, keydowns = []) {
  const raw = Array.isArray(session?.doc_history) ? session.doc_history : []
  const parsed = []
  let currentText = ''

  raw
    .slice()
    .sort((a, b) => (Number(a?.t) || 0) - (Number(b?.t) || 0))
    .forEach((entry) => {
      if (!entry || typeof entry !== 'object') return

      if (typeof entry.text === 'string') {
        currentText = entry.text
        parsed.push({
          t: Number(entry.t) || 0,
          text: currentText,
        })
        return
      }

      if (Number.isInteger(entry.pos) && typeof entry.ins === 'string') {
        const chars = Array.from(currentText)
        const pos = Math.max(0, Math.min(chars.length, Number(entry.pos)))
        const del = typeof entry.del === 'string'
          ? Array.from(entry.del).length
          : Math.max(0, Number(entry.del) || 0)
        chars.splice(pos, del, ...Array.from(entry.ins))
        currentText = chars.join('')
        parsed.push({
          t: Number(entry.t) || 0,
          text: currentText,
        })
      }
    })

  if (parsed.length === 0) {
    return buildSyntheticHistory(session?.doc_text || '', keydowns)
  }

  const finalText = session?.doc_text || parsed[parsed.length - 1]?.text || ''
  if (parsed[parsed.length - 1]?.text !== finalText) {
    parsed.push({
      t: parsed[parsed.length - 1]?.t || 0,
      text: finalText,
    })
  }

  return normalizeHistoryEntries(dedupeHistory(parsed))
}

export function findHistoryIndex(history, elapsedMs) {
  if (!history.length) return 0
  let low = 0
  let high = history.length - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (history[mid].t <= elapsedMs) {
      low = mid
    } else {
      high = mid - 1
    }
  }
  return low
}
