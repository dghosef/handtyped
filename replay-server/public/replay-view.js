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

export function makeStrictlyIncreasingTimeline(items) {
  const normalized = []
  let lastT = -Infinity

  for (const entry of items) {
    const rawT = Number(entry?.t)
    const t = Number.isFinite(rawT) ? rawT : 0
    const nextT = t <= lastT ? lastT + 1 : t
    normalized.push({
      ...entry,
      t: nextT,
    })
    lastT = nextT
  }

  return normalized
}

export function getDurationFromKeydowns(keyEvents) {
  if (keyEvents.length < 2) return 0
  return Math.max(0, Math.round((keyEvents[keyEvents.length - 1].t - keyEvents[0].t) / 1e6))
}

export function getDurationFromHistory(entries) {
  if (!entries.length) return 0
  return Math.max(0, Number(entries[entries.length - 1].t) || 0)
}

export function getRawDurationFromHistory(entries) {
  if (!entries.length) return 0

  for (let i = entries.length - 1; i >= 0; i--) {
    const rawT = Number(entries[i]?.raw_t)
    if (Number.isFinite(rawT) && rawT >= 0) {
      return rawT
    }
  }

  return getDurationFromHistory(entries)
}

export function getElapsedRawTime(entries, index) {
  if (!Array.isArray(entries) || index < 0 || index >= entries.length) {
    return 0
  }

  const rawT = Number(entries[index]?.raw_t)
  if (Number.isFinite(rawT) && rawT >= 0) {
    return rawT
  }

  return Math.max(0, Number(entries[index]?.t) || 0)
}

export function compressIdleGaps(history, maxGapMs = 5000) {
  if (!Array.isArray(history) || history.length === 0) return []

  const normalizedMaxGap = Math.max(1, Number(maxGapMs) || 0)
  const compressed = []
  let previousRawT = 0
  let currentCompressedT = 0

  for (let i = 0; i < history.length; i++) {
    const entry = history[i]
    const rawT = Math.max(0, Number(entry?.t) || 0)

    if (i === 0) {
      currentCompressedT = Math.min(rawT, normalizedMaxGap)
    } else {
      const rawGap = Math.max(0, rawT - previousRawT)
      currentCompressedT += Math.min(rawGap, normalizedMaxGap)
    }

    compressed.push({
      ...entry,
      raw_t: rawT,
      t: currentCompressedT,
    })

    previousRawT = rawT
  }

  return makeStrictlyIncreasingTimeline(dedupeHistory(compressed))
}

export function buildRhythmSamples(history, keyEvents = []) {
  if (Array.isArray(history) && history.length > 1) {
    const samples = []
    for (let i = 1; i < history.length; i++) {
      const prev = history[i - 1]?.text || ''
      const next = history[i]?.text || ''
      const diff = Math.abs(Array.from(next).length - Array.from(prev).length)
      const t = Math.max(0, Number(history[i]?.t) || 0)
      if (diff > 0 || next !== prev) {
        samples.push({
          t,
          weight: Math.max(1, diff),
        })
      }
    }
    if (samples.length > 0) {
      return samples
    }
  }

  if (keyEvents.length > 0) {
    return keyEvents.map((event) => ({
      t: Math.max(0, Math.round((event.t - keyEvents[0].t) / 1e6)),
      weight: 1,
    }))
  }

  return []
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

  return makeStrictlyIncreasingTimeline(dedupeHistory(snapshots))
}

export function documentWithAttribution(text, url) {
  const trimmed = String(text || '').replace(/[ \t]+$/, '')
  const attributionUrl = String(url || '').trim()
  const attribution = `This document was handtyped. See the replay [here](${attributionUrl})`
  return trimmed ? `${trimmed}\n\n${attribution}` : attribution
}

export function downloadFilenameForDocument(documentName, fallbackText) {
  const explicitName = String(documentName || '').trim()
  if (explicitName) {
    return explicitName.endsWith('.md')
      ? explicitName
      : `${explicitName.replace(/\.[^.]+$/, '')}.md`
  }

  const firstLine = String(fallbackText || '')
    .split('\n')
    .find(Boolean)
  const stem = String(firstLine || 'handtyped-document')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'handtyped-document'
  return `${stem}.md`
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

  return makeStrictlyIncreasingTimeline(dedupeHistory(parsed))
}

export function findHistoryIndex(history, elapsedMs) {
  if (!history.length) return -1
  if (elapsedMs < history[0].t) return -1
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
