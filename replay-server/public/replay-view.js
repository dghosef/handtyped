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

export function getReplayOriginWallMs(session) {
  const explicitOrigin = Number(session?.replay_origin_wall_ms)
  if (Number.isFinite(explicitOrigin) && explicitOrigin > 0) {
    return explicitOrigin
  }

  const startWallNs = Number(session?.start_wall_ns)
  if (Number.isFinite(startWallNs) && startWallNs > 0) {
    return Math.floor(startWallNs / 1e6)
  }

  const createdAt = Date.parse(session?.created_at || '')
  return Number.isFinite(createdAt) ? createdAt : null
}

export function formatAbsoluteReplayTime(session, elapsedMs) {
  const origin = getReplayOriginWallMs(session)
  if (!Number.isFinite(origin)) {
    return 'Unknown time'
  }

  const offsetMinutes = Number(session?.recorded_timezone_offset_minutes)
  const normalizedOffset = Number.isFinite(offsetMinutes) ? offsetMinutes : 0
  const shifted = new Date(origin + Math.max(0, Number(elapsedMs) || 0) + normalizedOffset * 60_000)
  const month = shifted.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })
  const day = shifted.getUTCDate()
  const year = shifted.getUTCFullYear()
  let hours = shifted.getUTCHours()
  const minutes = String(shifted.getUTCMinutes()).padStart(2, '0')
  const seconds = String(shifted.getUTCSeconds()).padStart(2, '0')
  const meridiem = hours >= 12 ? 'PM' : 'AM'
  hours = hours % 12 || 12

  const offsetSign = normalizedOffset >= 0 ? '+' : '-'
  const absoluteOffset = Math.abs(normalizedOffset)
  const offsetHours = String(Math.floor(absoluteOffset / 60)).padStart(2, '0')
  const offsetMins = String(absoluteOffset % 60).padStart(2, '0')
  const timezone = session?.recorded_timezone
    ? `${session.recorded_timezone} (UTC${offsetSign}${offsetHours}:${offsetMins})`
    : `UTC${offsetSign}${offsetHours}:${offsetMins}`

  return `${month} ${day}, ${year}, ${hours}:${minutes}:${seconds} ${meridiem} ${timezone}`
}

export function getFocusStateAtElapsedMs(focusEvents, elapsedMs) {
  const events = Array.isArray(focusEvents)
    ? focusEvents.slice().sort((a, b) => (Number(a?.t) || 0) - (Number(b?.t) || 0))
    : []
  const target = Math.max(0, Number(elapsedMs) || 0)
  let state = 'active'

  for (const event of events) {
    const t = Math.max(0, Number(event?.t) || 0)
    if (t > target) break
    if (event?.state === 'active' || event?.state === 'inactive') {
      state = event.state
    }
  }

  return state
}

export function parseFocusEvents(session) {
  const raw = Array.isArray(session?.focus_events) ? session.focus_events : []

  return raw
    .map((entry) => {
      const t = Number(entry?.t)
      const state = entry?.state
      if (!Number.isFinite(t) || t < 0 || (state !== 'active' && state !== 'inactive')) {
        return null
      }
      return { t, state }
    })
    .filter(Boolean)
    .sort((a, b) => a.t - b.t)
}

export function compressedTimeForRawMs(history, rawMs) {
  const rawTarget = Math.max(0, Number(rawMs) || 0)
  if (!Array.isArray(history) || history.length === 0) {
    return rawTarget
  }

  let previousRaw = 0
  let previousCompressed = 0

  for (const entry of history) {
    const entryRawCandidate = Number(entry?.raw_t)
    const entryRaw = Number.isFinite(entryRawCandidate)
      ? Math.max(0, entryRawCandidate)
      : Math.max(0, Number(entry?.t) || 0)
    const entryCompressed = Math.max(0, Number(entry?.t) || 0)

    if (rawTarget <= entryRaw) {
      const rawSpan = Math.max(0, entryRaw - previousRaw)
      const compressedSpan = Math.max(0, entryCompressed - previousCompressed)
      if (rawSpan === 0) {
        return previousCompressed
      }
      const pct = Math.max(0, Math.min(1, (rawTarget - previousRaw) / rawSpan))
      return previousCompressed + compressedSpan * pct
    }

    previousRaw = entryRaw
    previousCompressed = entryCompressed
  }

  return previousCompressed + Math.max(0, rawTarget - previousRaw)
}

export function buildInactiveSpans(focusEvents, history, totalDuration) {
  const total = Math.max(0, Number(totalDuration) || 0)
  const rawTotal = getRawDurationFromHistory(history)
  const events = Array.isArray(focusEvents)
    ? focusEvents.slice().sort((a, b) => (Number(a?.t) || 0) - (Number(b?.t) || 0))
    : []
  const spans = []
  let inactiveStart = null

  for (const event of events) {
    if (event.state === 'inactive') {
      inactiveStart = inactiveStart ?? event.t
      continue
    }

    if (event.state === 'active' && inactiveStart !== null) {
      const start = Math.max(0, Math.min(total, compressedTimeForRawMs(history, inactiveStart)))
      const end = Math.max(0, Math.min(total, compressedTimeForRawMs(history, event.t)))
      if (end > start) {
        spans.push({ start, end, rawStart: inactiveStart, rawEnd: event.t })
      }
      inactiveStart = null
    }
  }

  if (inactiveStart !== null) {
    const start = Math.max(0, Math.min(total, compressedTimeForRawMs(history, inactiveStart)))
    if (total > start) {
      spans.push({ start, end: total, rawStart: inactiveStart, rawEnd: rawTotal })
    }
  }

  return spans
}

export function buildTimelineGapMarkers(history, maxGapMs = 5000) {
  const normalizedMaxGap = Math.max(1, Number(maxGapMs) || 0)
  if (!Array.isArray(history) || history.length < 2) {
    return []
  }

  const markers = []
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1]
    const next = history[i]
    const prevRaw = getElapsedRawTime(history, i - 1)
    const nextRaw = getElapsedRawTime(history, i)
    const rawGap = Math.max(0, nextRaw - prevRaw)
    if (rawGap > normalizedMaxGap) {
      markers.push({
        start: Math.max(0, Number(prev?.t) || 0),
        end: Math.max(0, Number(next?.t) || 0),
        rawStart: prevRaw,
        rawEnd: nextRaw,
      })
    }
  }

  return markers
}

export function buildFocusSegments(focusEvents, history, totalDuration) {
  const total = Math.max(0, Number(totalDuration) || 0)
  const rawTotal = getRawDurationFromHistory(history)
  const events = Array.isArray(focusEvents)
    ? focusEvents.slice().sort((a, b) => (Number(a?.t) || 0) - (Number(b?.t) || 0))
    : []
  const segments = []
  let state = 'active'
  let rawStart = 0

  for (const event of events) {
    const rawEnd = Math.max(0, Math.min(rawTotal, Number(event?.t) || 0))
    if (rawEnd > rawStart) {
      const start = Math.max(0, Math.min(total, compressedTimeForRawMs(history, rawStart)))
      const end = Math.max(0, Math.min(total, compressedTimeForRawMs(history, rawEnd)))
      if (end > start) {
        segments.push({ state, start, end, rawStart, rawEnd })
      }
    }
    if (event?.state === 'active' || event?.state === 'inactive') {
      state = event.state
      rawStart = rawEnd
    }
  }

  if (rawTotal > rawStart) {
    const start = Math.max(0, Math.min(total, compressedTimeForRawMs(history, rawStart)))
    const end = total
    if (end > start) {
      segments.push({ state, start, end, rawStart, rawEnd: rawTotal })
    }
  }

  return segments
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

function keyEventElapsedMs(event, replayOriginWallMs, fallbackOriginNs) {
  const rawT = Number(event?.t)
  if (!Number.isFinite(rawT)) {
    return null
  }

  if (Number.isFinite(replayOriginWallMs) && replayOriginWallMs > 0) {
    if (rawT >= 1e12) {
      return Math.max(0, Math.round((rawT / 1e6) - replayOriginWallMs))
    }
    return Math.max(0, Math.round(rawT - replayOriginWallMs))
  }

  if (Number.isFinite(fallbackOriginNs) && fallbackOriginNs > 0 && rawT >= fallbackOriginNs) {
    return Math.max(0, Math.round((rawT - fallbackOriginNs) / 1e6))
  }

  return Math.max(0, Math.round(rawT))
}

function buildOperationTimes(operationCount, startT, endT, keydownTimes = []) {
  if (operationCount <= 0) {
    return []
  }

  const normalizedStart = Math.max(0, Number(startT) || 0)
  const normalizedEnd = Math.max(normalizedStart, Number(endT) || 0)
  const usableKeydowns = keydownTimes
    .map((time) => Math.max(normalizedStart, Math.min(normalizedEnd, Number(time) || 0)))
    .filter((time) => Number.isFinite(time))

  if (!usableKeydowns.length) {
    return Array.from({ length: operationCount }, (_, index) => {
      if (normalizedEnd === normalizedStart) {
        return normalizedStart + index + 1
      }
      const pct = (index + 1) / operationCount
      return Math.round(normalizedStart + ((normalizedEnd - normalizedStart) * pct))
    })
  }

  if (usableKeydowns.length === 1) {
    return Array.from({ length: operationCount }, () => usableKeydowns[0])
  }

  return Array.from({ length: operationCount }, (_, index) => {
    if (operationCount === 1) {
      return usableKeydowns[usableKeydowns.length - 1]
    }

    const scaledIndex = (index * (usableKeydowns.length - 1)) / (operationCount - 1)
    const lowerIndex = Math.floor(scaledIndex)
    const upperIndex = Math.min(usableKeydowns.length - 1, Math.ceil(scaledIndex))
    const pct = scaledIndex - lowerIndex
    return Math.round(
      usableKeydowns[lowerIndex] +
      ((usableKeydowns[upperIndex] - usableKeydowns[lowerIndex]) * pct),
    )
  })
}

function buildTransitionSteps(previousText, nextText, startT, endT, keydownTimes = []) {
  const previousChars = Array.from(String(previousText || ''))
  const nextChars = Array.from(String(nextText || ''))
  let prefix = 0

  while (
    prefix < previousChars.length &&
    prefix < nextChars.length &&
    previousChars[prefix] === nextChars[prefix]
  ) {
    prefix += 1
  }

  let previousSuffix = previousChars.length
  let nextSuffix = nextChars.length
  while (
    previousSuffix > prefix &&
    nextSuffix > prefix &&
    previousChars[previousSuffix - 1] === nextChars[nextSuffix - 1]
  ) {
    previousSuffix -= 1
    nextSuffix -= 1
  }

  const removals = Math.max(0, previousSuffix - prefix)
  const insertions = nextChars.slice(prefix, nextSuffix)
  const operationCount = removals + insertions.length
  if (operationCount === 0) {
    return []
  }

  const currentChars = previousChars.slice()
  const steps = []
  const operationTimes = buildOperationTimes(operationCount, startT, endT, keydownTimes)
  let operationIndex = 0

  for (let i = 0; i < removals; i += 1) {
    currentChars.splice(prefix, 1)
    steps.push({
      t: operationTimes[operationIndex] ?? Math.max(0, Number(endT) || 0),
      text: currentChars.join(''),
    })
    operationIndex += 1
  }

  for (let i = 0; i < insertions.length; i += 1) {
    currentChars.splice(prefix + i, 0, insertions[i])
    steps.push({
      t: operationTimes[operationIndex] ?? Math.max(0, Number(endT) || 0),
      text: currentChars.join(''),
    })
    operationIndex += 1
  }

  return steps
}

export function buildCharacterReplayHistory(history, keyEvents = [], options = {}) {
  if (!Array.isArray(history) || history.length === 0) {
    return []
  }

  const replayOriginWallMs = Number(options?.replayOriginWallMs)
  const fallbackOriginNs = Number(options?.startWallNs)
  const keydownTimes = Array.isArray(keyEvents)
    ? keyEvents
      .map((event) => keyEventElapsedMs(event, replayOriginWallMs, fallbackOriginNs))
      .filter((time) => Number.isFinite(time))
      .sort((a, b) => a - b)
    : []
  const steps = []
  let previousText = ''
  let previousT = 0
  let keydownIndex = 0

  for (const entry of history) {
    const nextText = String(entry?.text || '')
    const nextT = Math.max(0, Number(entry?.t) || 0)
    while (keydownIndex < keydownTimes.length && keydownTimes[keydownIndex] < previousT) {
      keydownIndex += 1
    }

    let keydownEndIndex = keydownIndex
    while (keydownEndIndex < keydownTimes.length && keydownTimes[keydownEndIndex] <= nextT) {
      keydownEndIndex += 1
    }

    const transitionSteps = buildTransitionSteps(
      previousText,
      nextText,
      previousT,
      nextT,
      keydownTimes.slice(keydownIndex, keydownEndIndex),
    )

    if (transitionSteps.length) {
      steps.push(...transitionSteps)
    } else if (!steps.length || steps[steps.length - 1]?.text !== nextText) {
      steps.push({ t: nextT, text: nextText })
    }

    previousText = nextText
    previousT = nextT
    keydownIndex = keydownEndIndex
  }

  if (!steps.length) {
    return [{ t: previousT, text: previousText }]
  }

  return makeStrictlyIncreasingTimeline(dedupeHistory(steps))
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

export function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function toAttributedChars(text, insertedAtMs) {
  return Array.from(String(text || '')).map((char) => ({ char, insertedAtMs }))
}

function applyDeltaEntry(currentText, entry) {
  if (!Number.isInteger(entry?.pos) || typeof entry?.ins !== 'string') {
    return null
  }
  const chars = Array.from(String(currentText || ''))
  const pos = Math.max(0, Math.min(chars.length, Number(entry.pos)))
  const delCount = typeof entry.del === 'string'
    ? Array.from(entry.del).length
    : Math.max(0, Number(entry.del) || 0)
  chars.splice(pos, delCount, ...Array.from(entry.ins))
  return chars.join('')
}

function applyLegacyHistoryEntry(currentText, entry) {
  if (typeof entry?.text !== 'string') {
    return null
  }
  const op = String(entry?.op || '').toLowerCase()
  if (!op || op === 'replace' || op === 'snapshot' || op === 'set') {
    return entry.text
  }
  if (op === 'insert') {
    return `${String(currentText || '')}${entry.text}`
  }
  return entry.text
}

function nextHistoryText(currentText, entry) {
  if (!entry || typeof entry !== 'object') {
    return null
  }
  if (typeof entry.text === 'string' && !entry.op) {
    return entry.text
  }
  return applyDeltaEntry(currentText, entry) ?? applyLegacyHistoryEntry(currentText, entry)
}

function historyEntryTime(entry, fallbackT) {
  const rawT = Number(entry?.t)
  if (Number.isFinite(rawT) && rawT >= 0) {
    return rawT
  }
  return fallbackT
}

export function latestTextFromHistory(session = {}) {
  const raw = Array.isArray(session?.doc_history) ? session.doc_history : []
  let currentText = ''
  let sawHistory = false

  raw.forEach((entry) => {
    const nextText = nextHistoryText(currentText, entry)
    if (typeof nextText !== 'string') {
      return
    }
    currentText = nextText
    sawHistory = true
  })

  if (sawHistory) {
    return currentText
  }
  return String(session?.doc_text || '')
}

function renderPlainTextHtml(markdown) {
  const text = String(markdown || '')
  if (!text) return ''

  return text
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

function getSafeMarkedRenderer() {
  const markedApi = globalThis?.marked
  if (!markedApi?.parse || typeof markedApi.Renderer !== 'function') {
    return null
  }

  const renderer = new markedApi.Renderer()
  renderer.html = (token) => {
    if (typeof token === 'string') {
      return escapeHtml(token)
    }

    return escapeHtml(token?.text || token?.raw || '')
  }

  return { markedApi, renderer }
}

export function renderMarkdownToHtml(markdown) {
  const source = String(markdown || '')
  if (!source) return ''

  const markedState = getSafeMarkedRenderer()
  if (!markedState) {
    return renderPlainTextHtml(source)
  }

  try {
    return markedState.markedApi.parse(source, {
      async: false,
      gfm: true,
      breaks: false,
      headerIds: false,
      mangle: false,
      renderer: markedState.renderer,
    })
  } catch {
    return renderPlainTextHtml(source)
  }
}

function findCursorHost(root) {
  let node = root?.lastElementChild || null
  const descendTags = new Set([
    'BLOCKQUOTE',
    'LI',
    'OL',
    'PRE',
    'TABLE',
    'TBODY',
    'TD',
    'TH',
    'THEAD',
    'TR',
    'UL',
  ])

  while (node && descendTags.has(node.tagName) && node.lastElementChild) {
    node = node.lastElementChild
  }

  return node || root
}

export function renderMarkdownInto(container, markdown, options = {}) {
  if (!container) return

  const { cursorEl = null, showCursor = false } = options
  container.innerHTML = renderMarkdownToHtml(markdown)

  if (!cursorEl) return

  if (!showCursor) {
    cursorEl.remove()
    return
  }

  const host = findCursorHost(container)
  host.appendChild(cursorEl)
}

export function buildAttributedDocument(session = {}) {
  const history = Array.isArray(session?.doc_history) ? session.doc_history : []
  const originWallMs = getReplayOriginWallMs(session)
  const sortedHistory = history
    .slice()
    .sort((a, b) => historyEntryTime(a, 0) - historyEntryTime(b, 0))

  let chars = []
  let latestRawT = 0

  const absoluteFromRawT = (rawT) => {
    const normalizedRawT = Math.max(0, Number(rawT) || 0)
    latestRawT = Math.max(latestRawT, normalizedRawT)
    return Number.isFinite(originWallMs) ? originWallMs + normalizedRawT : null
  }

  const applySnapshot = (nextText, rawT) => {
    const nextChars = Array.from(String(nextText || ''))
    const previousChars = chars.map((entry) => entry.char)
    let prefix = 0

    while (
      prefix < previousChars.length &&
      prefix < nextChars.length &&
      previousChars[prefix] === nextChars[prefix]
    ) {
      prefix += 1
    }

    let previousSuffix = previousChars.length
    let nextSuffix = nextChars.length
    while (
      previousSuffix > prefix &&
      nextSuffix > prefix &&
      previousChars[previousSuffix - 1] === nextChars[nextSuffix - 1]
    ) {
      previousSuffix -= 1
      nextSuffix -= 1
    }

    chars = [
      ...chars.slice(0, prefix),
      ...toAttributedChars(nextChars.slice(prefix, nextSuffix).join(''), absoluteFromRawT(rawT)),
      ...chars.slice(previousSuffix),
    ]
  }

  for (const entry of sortedHistory) {
    const rawT = Math.max(0, historyEntryTime(entry, latestRawT + 1))
    const nextText = nextHistoryText(chars.map((item) => item.char).join(''), entry)

    if (typeof nextText === 'string') {
      if (applyDeltaEntry(chars.map((item) => item.char).join(''), entry) != null && !entry.op) {
        const pos = Math.max(0, Math.min(chars.length, Number(entry.pos)))
        const delCount = typeof entry.del === 'string'
          ? Array.from(entry.del).length
          : Math.max(0, Number(entry.del) || 0)
        chars.splice(pos, delCount, ...toAttributedChars(entry.ins, absoluteFromRawT(rawT)))
      } else {
        applySnapshot(nextText, rawT)
      }
    }
  }

  const finalText = String(session?.doc_text || latestTextFromHistory(session) || '')
  if (chars.map((entry) => entry.char).join('') !== finalText) {
    applySnapshot(finalText, latestRawT)
  }

  const insertedAtValues = chars
    .map((entry) => entry.insertedAtMs)
    .filter((value) => Number.isFinite(value))

  return {
    text: chars.map((entry) => entry.char).join(''),
    chars,
    originWallMs,
    firstInsertedAtMs: insertedAtValues.length ? Math.min(...insertedAtValues) : originWallMs,
    lastInsertedAtMs: insertedAtValues.length ? Math.max(...insertedAtValues) : originWallMs,
  }
}

export function renderInsertedRangeHtml(attributedDocument, startMs, endMs, className = 'insert-highlight') {
  return renderInsertedRangesHtml(attributedDocument, [{ startMs, endMs }], className)
}

export function renderInsertedRangesHtml(attributedDocument, ranges = [], className = 'insert-highlight') {
  const chars = Array.isArray(attributedDocument?.chars) ? attributedDocument.chars : []
  const normalizedRanges = (Array.isArray(ranges) ? ranges : [])
    .map((range) => {
      const startMs = Number(range?.startMs)
      const endMs = Number(range?.endMs)
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
        return null
      }
      return {
        startMs: Math.min(startMs, endMs),
        endMs: Math.max(startMs, endMs),
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.startMs - b.startMs)
  let html = ''
  let buffer = ''
  let inHighlight = false

  const flush = () => {
    if (!buffer) {
      return
    }
    html += inHighlight ? `<mark class="${className}">${buffer}</mark>` : buffer
    buffer = ''
  }

  for (const entry of chars) {
    const insertedAtMs = Number(entry?.insertedAtMs)
    const shouldHighlight = Number.isFinite(insertedAtMs) && normalizedRanges.some((range) =>
      insertedAtMs >= range.startMs && insertedAtMs <= range.endMs,
    )

    if (shouldHighlight !== inHighlight) {
      flush()
      inHighlight = shouldHighlight
    }

    buffer += escapeHtml(entry?.char || '')
  }

  flush()
  return html
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
  let fallbackT = 0

  raw
    .slice()
    .sort((a, b) => historyEntryTime(a, 0) - historyEntryTime(b, 0))
    .forEach((entry) => {
      const nextText = nextHistoryText(currentText, entry)
      if (typeof nextText === 'string') {
        const nextT = historyEntryTime(entry, fallbackT)
        currentText = nextText
        parsed.push({
          t: nextT,
          text: currentText,
        })
        fallbackT = nextT + 1
      }
    })

  if (parsed.length === 0) {
    return buildSyntheticHistory(session?.doc_text || '', keydowns)
  }

  const finalText = session?.doc_text || latestTextFromHistory(session) || parsed[parsed.length - 1]?.text || ''
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
