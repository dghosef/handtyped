import { describe, expect, it } from 'vitest'
import {
  buildFocusSegments,
  buildInactiveSpans,
  buildTimelineGapMarkers,
  buildSyntheticHistory,
  buildRhythmSamples,
  compressedTimeForRawMs,
  compressIdleGaps,
  documentWithAttribution,
  downloadFilenameForDocument,
  safeJsonLines,
  formatAbsoluteReplayTime,
  getDurationFromHistory,
  getElapsedRawTime,
  getFocusStateAtElapsedMs,
  getRawDurationFromHistory,
  getReplayOriginWallMs,
  findHistoryIndex,
  parseKeydowns,
  parseFocusEvents,
  parseHistory,
  renderMarkdownToHtml,
} from './public/replay-view.js'
import fs from 'node:fs'
import path from 'node:path'

const replayPageHtml = fs.readFileSync(
  path.join(process.cwd(), 'public', 'replay.html'),
  'utf8',
)
const eduReplayPageHtml = fs.readFileSync(
  path.join(process.cwd(), 'public', 'edu', 'replay.html'),
  'utf8',
)
const eduAppJs = fs.readFileSync(
  path.join(process.cwd(), 'public', 'edu', 'app.js'),
  'utf8',
)

describe('replay history start state', () => {
  it('keeps the edu replay page on the shared history parser', () => {
    expect(eduReplayPageHtml).toContain('parseHistory,')
    expect(eduReplayPageHtml).toContain('const rawHistory = parseHistory(')
    expect(eduReplayPageHtml).not.toContain("text: h.ins || ''")
  })

  it('links teacher replay actions to the edu replay route', () => {
    expect(eduAppJs).toContain('href="/edu/replay/${escapeHtml(')
    expect(eduAppJs).not.toContain('href="/replay/${escapeHtml(')
  })

  it('hides numeric risk scores from teacher student cards', () => {
    expect(eduAppJs).not.toContain('Risk ${risk.score}')
    expect(eduAppJs).toContain('student-card-risk-${risk.score')
    expect(eduAppJs).toContain("risk.reasons.join(' • ')")
  })

  it('uses the homepage header font for the replay title', () => {
    expect(replayPageHtml).toContain('cdn.jsdelivr.net/npm/marked/marked.min.js')
    expect(replayPageHtml).toContain(
      "fonts.googleapis.com/css?family=Open%20Sans%3A400%2C600%2C700&display=swap",
    )
    expect(replayPageHtml).toContain("font-family: 'Open Sans', Arial, Helvetica, sans-serif;")
    expect(replayPageHtml).not.toContain('Georgia, "Times New Roman", Times, serif')
    expect(replayPageHtml).toContain('.brand-mark {')
    expect(replayPageHtml).toContain('h1 {')
    expect(replayPageHtml).toContain('.share-btn,')
    expect(replayPageHtml).toContain('.play-btn,')
    expect(replayPageHtml).toContain('.speed-select {')
    expect(replayPageHtml).toContain('.doc-page {')
    expect(replayPageHtml).toContain('#doc-content h1')
    expect(replayPageHtml).toContain('.section-label {')
    expect(replayPageHtml).toContain('.keyboard-note p {')
    expect(replayPageHtml).toContain('renderMarkdownInto')
    expect(replayPageHtml).not.toContain('docContentEl.textContent = text')
    expect(replayPageHtml).not.toContain('Session stats')
    expect(replayPageHtml).not.toContain('stat-keystrokes')
    expect(replayPageHtml).not.toContain('stat-words')
  })

  it('initializes replay speed from the restored speed dropdown value', () => {
    for (const html of [replayPageHtml, eduReplayPageHtml]) {
      expect(html).toContain("const speedSelectEl = document.getElementById('speed-select')")
      expect(html).toContain('function readSelectedSpeed()')
      expect(html).toContain('speed = readSelectedSpeed()')
      expect(html).toContain("speedSelectEl.addEventListener('change', () => {")
      expect(html).not.toContain("document.getElementById('speed-select').addEventListener('change', event =>")
    }
  })

  it('escapes raw html when marked is unavailable during markdown rendering', () => {
    expect(renderMarkdownToHtml('Hello <script>alert(1)</script>')).toBe(
      '<p>Hello &lt;script&gt;alert(1)&lt;/script&gt;</p>',
    )
  })

  it('preserves the actual timestamp of the first parsed edit', () => {
    const history = parseHistory(
      {
        doc_text: 'Hello',
        doc_history: [{ t: 0, pos: 0, del: '', ins: 'Hello' }],
      },
      [],
    )

    expect(history[0]).toEqual({ t: 0, text: 'Hello' })
    expect(findHistoryIndex(history, 0)).toBe(0)
  })

  it('shows blank before the first recorded edit time', () => {
    const history = parseHistory(
      {
        doc_text: 'hs',
        doc_history: [
          { t: 1420, pos: 0, del: '', ins: 'hs' },
          { t: 1447, pos: 2, del: '', ins: 'd' },
        ],
      },
      [],
    )

    expect(findHistoryIndex(history, 0)).toBe(-1)
    expect(findHistoryIndex(history, 1419)).toBe(-1)
    expect(findHistoryIndex(history, 1420)).toBe(0)
  })

  it('measures replay duration through the final timestamp, not the first gap', () => {
    const history = parseHistory(
      {
        doc_text: 'hello',
        doc_history: [
          { t: 1000, pos: 0, del: '', ins: 'hel' },
          { t: 2500, pos: 3, del: '', ins: 'lo' },
        ],
      },
      [],
    )

    expect(getDurationFromHistory(history)).toBe(2500)
    expect(findHistoryIndex(history, 2499)).toBe(0)
    expect(findHistoryIndex(history, 2500)).toBe(1)
  })

  it('uses a single recorded edit timestamp as the replay duration', () => {
    const history = parseHistory(
      {
        doc_text: 'hello',
        doc_history: [{ t: 1420, pos: 0, del: '', ins: 'hello' }],
      },
      [],
    )

    expect(getDurationFromHistory(history)).toBe(1420)
    expect(findHistoryIndex(history, 1419)).toBe(-1)
    expect(findHistoryIndex(history, 1420)).toBe(0)
  })

  it('preserves intentional trailing blank lines before the replay attribution footer', () => {
    const text = documentWithAttribution('Line one\n\n', 'https://replay.handtyped.app/abc123')

    expect(text).toBe(
      'Line one\n\n\n\nThis document was handtyped. See the replay [here](https://replay.handtyped.app/abc123)',
    )
  })

  it('normalizes replay downloads to markdown filenames', () => {
    expect(downloadFilenameForDocument('essay.ht', 'ignored')).toBe('essay.md')
    expect(downloadFilenameForDocument('essay', 'ignored')).toBe('essay.md')
    expect(downloadFilenameForDocument('', '## Hello world')).toBe('hello-world.md')
    expect(downloadFilenameForDocument('', '')).toBe('handtyped-document.md')
  })

  it('keeps same-time edits in order instead of collapsing to the last one', () => {
    const history = parseHistory(
      {
        doc_text: 'hs',
        doc_history: [
          { t: 0, pos: 0, del: '', ins: 'h' },
          { t: 0, pos: 1, del: '', ins: 's' },
        ],
      },
      [],
    )

    expect(history.map((entry) => entry.t)).toEqual([0, 1])
    expect(history[0].text).toBe('h')
    expect(history[1].text).toBe('hs')
    expect(findHistoryIndex(history, 0)).toBe(0)
    expect(findHistoryIndex(history, 1)).toBe(1)
  })

  it('keeps synthetic history timestamps tied to the captured typing time', () => {
    const history = buildSyntheticHistory('Hi', [{ t: 0 }, { t: 10 }])

    expect(history[0]).toEqual({ t: 0, text: '' })
    expect(history[1].text).toBe('H')
    expect(history[1].t).toBe(1)
    expect(history[2].text).toBe('Hi')
    expect(history[2].t).toBe(2)
    expect(findHistoryIndex(history, 0)).toBe(0)
    expect(findHistoryIndex(history, 1)).toBe(1)
    expect(findHistoryIndex(history, 2)).toBe(2)
  })

  it('builds rhythm samples from the replay history when available', () => {
    const history = [
      { t: 0, text: '' },
      { t: 12, text: 'a' },
      { t: 140, text: 'ab' },
    ]

    const samples = buildRhythmSamples(history, [
      { t: 1_000_000_000 },
      { t: 2_000_000_000 },
    ])

    expect(samples).toEqual([
      { t: 12, weight: 1 },
      { t: 140, weight: 1 },
    ])
  })

  it('falls back to keydown timing when no replay history is available', () => {
    const samples = buildRhythmSamples([], [{ t: 1_000_000_000 }, { t: 1_250_000_000 }])

    expect(samples).toEqual([
      { t: 0, weight: 1 },
      { t: 250, weight: 1 },
    ])
  })

  it('compresses long idle gaps so late corrections do not dominate playback time', () => {
    const compressed = compressIdleGaps([
      { t: 1000, text: 'a' },
      { t: 2000, text: 'ab' },
      { t: 7_200_000, text: 'abc' },
    ], 5000)

    expect(compressed.map((entry) => entry.t)).toEqual([1000, 2000, 7000])
    expect(getDurationFromHistory(compressed)).toBe(7000)
    expect(compressed[2].raw_t).toBe(7_200_000)
  })

  it('reports raw replay duration from preserved timestamps after compression', () => {
    const compressed = compressIdleGaps([
      { t: 0, text: '' },
      { t: 1200, text: 'draft' },
      { t: 2 * 60 * 60 * 1000, text: 'draft done' },
    ], 5000)

    expect(getDurationFromHistory(compressed)).toBe(6200)
    expect(getRawDurationFromHistory(compressed)).toBe(2 * 60 * 60 * 1000)
  })

  it('falls back to compressed timestamps when raw replay timestamps are unavailable', () => {
    const history = [
      { t: 0, text: '' },
      { t: 1200, text: 'draft' },
      { t: 6200, text: 'draft done' },
    ]

    expect(getRawDurationFromHistory(history)).toBe(6200)
    expect(getElapsedRawTime(history, 2)).toBe(6200)
  })

  it('returns zero raw elapsed time for indexes outside the replay history', () => {
    const history = compressIdleGaps([
      { t: 1000, text: 'a' },
      { t: 600_000, text: 'ab' },
    ], 5000)

    expect(getElapsedRawTime(history, -1)).toBe(0)
    expect(getElapsedRawTime(history, 99)).toBe(0)
  })

  it('returns the preserved raw timestamp for the active replay frame', () => {
    const history = compressIdleGaps([
      { t: 0, text: '' },
      { t: 2500, text: 'a' },
      { t: 90_000, text: 'ab' },
    ], 5000)

    expect(getElapsedRawTime(history, 1)).toBe(2500)
    expect(getElapsedRawTime(history, 2)).toBe(90_000)
  })

  it('parses focus events, sorting valid active and inactive transitions only', () => {
    const focusEvents = parseFocusEvents({
      focus_events: [
        { t: 3000, state: 'active' },
        { t: -1, state: 'inactive' },
        { t: 1000, state: 'inactive' },
        { t: 2000, state: 'hidden' },
        null,
      ],
    })

    expect(focusEvents).toEqual([
      { t: 1000, state: 'inactive' },
      { t: 3000, state: 'active' },
    ])
  })

  it('maps focus event timestamps onto the compressed replay timeline', () => {
    const history = compressIdleGaps([
      { t: 0, text: '' },
      { t: 1000, text: 'a' },
      { t: 120_000, text: 'ab' },
    ], 5000)

    expect(compressedTimeForRawMs(history, 0)).toBe(0)
    expect(compressedTimeForRawMs(history, 1000)).toBe(1000)
    expect(compressedTimeForRawMs(history, 120_000)).toBe(6000)
    expect(compressedTimeForRawMs(history, 2000)).toBeCloseTo(1042.02, 1)
  })

  it('reports the focus state for the current replay position', () => {
    const focusEvents = parseFocusEvents({
      focus_events: [
        { t: 250, state: 'inactive' },
        { t: 900, state: 'active' },
      ],
    })

    expect(getFocusStateAtElapsedMs(focusEvents, 0)).toBe('active')
    expect(getFocusStateAtElapsedMs(focusEvents, 500)).toBe('inactive')
    expect(getFocusStateAtElapsedMs(focusEvents, 901)).toBe('active')
  })

  it('marks large timeline jumps as scrubber gaps', () => {
    const history = compressIdleGaps([
      { t: 0, text: '' },
      { t: 1000, text: 'a' },
      { t: 120_000, text: 'ab' },
      { t: 121_000, text: 'abc' },
    ], 5000)

    expect(buildTimelineGapMarkers(history)).toEqual([
      { start: 1000, end: 6000, rawStart: 1000, rawEnd: 120_000 },
    ])
  })

  it('builds closed and open-ended inactive spans for timeline overlays', () => {
    const history = compressIdleGaps([
      { t: 0, text: '' },
      { t: 1000, text: 'a' },
      { t: 2000, text: 'ab' },
      { t: 4000, text: 'abc' },
    ], 5000)

    const spans = buildInactiveSpans([
      { t: 500, state: 'inactive' },
      { t: 1500, state: 'active' },
      { t: 3000, state: 'inactive' },
    ], history, getDurationFromHistory(history))

    expect(spans).toEqual([
      { start: 500, end: 1500, rawStart: 500, rawEnd: 1500 },
      { start: 3000, end: 4000, rawStart: 3000, rawEnd: 4000 },
    ])
  })

  it('formats absolute replay times from explicit replay origin and timezone offset', () => {
    const session = {
      replay_origin_wall_ms: Date.UTC(2026, 3, 22, 21, 0, 0),
      recorded_timezone: 'AST',
      recorded_timezone_offset_minutes: -240,
    }

    expect(getReplayOriginWallMs(session)).toBe(Date.UTC(2026, 3, 22, 21, 0, 0))
    expect(formatAbsoluteReplayTime(session, 90_000)).toBe(
      'Apr 22, 2026, 5:01:30 PM AST (UTC-04:00)',
    )
  })

  it('falls back to session start_wall_ns when older replays lack replay origin', () => {
    expect(getReplayOriginWallMs({ start_wall_ns: 1_700_000_000_000_000_000 })).toBe(
      1_700_000_000_000,
    )
  })

  it('falls back to created_at when explicit replay origin metadata is missing', () => {
    const createdAt = '2026-04-22T21:00:00.000Z'
    expect(getReplayOriginWallMs({ created_at: createdAt })).toBe(Date.parse(createdAt))
  })

  it('formats unknown absolute replay time when the session lacks any origin timestamp', () => {
    expect(formatAbsoluteReplayTime({}, 45_000)).toBe('Unknown time')
  })

  it('parseHistory reconstructs string-based deletions correctly', () => {
    const history = parseHistory(
      {
        doc_text: 'abX',
        doc_history: [
          { t: 0, pos: 0, del: '', ins: 'abc' },
          { t: 10, pos: 2, del: 'c', ins: 'X' },
        ],
      },
      [],
    )

    expect(history.map((entry) => entry.text)).toEqual(['abc', 'abX'])
  })

  it('parseHistory sorts out-of-order deltas by timestamp', () => {
    const history = parseHistory(
      {
        doc_text: 'abc',
        doc_history: [
          { t: 30, pos: 2, del: '', ins: 'c' },
          { t: 10, pos: 0, del: '', ins: 'a' },
          { t: 20, pos: 1, del: '', ins: 'b' },
        ],
      },
      [],
    )

    expect(history.map((entry) => entry.text)).toEqual(['a', 'ab', 'abc'])
  })

  it('parseHistory handles mixed snapshot and delta history', () => {
    const history = parseHistory(
      {
        doc_text: 'hello world',
        doc_history: [
          { t: 0, text: 'hello' },
          { t: 25, pos: 5, del: '', ins: ' world' },
        ],
      },
      [],
    )

    expect(history.map((entry) => entry.text)).toEqual(['hello', 'hello world'])
  })

  it('parseHistory appends final text if deltas stop short of doc_text', () => {
    const history = parseHistory(
      {
        doc_text: 'hello world',
        doc_history: [{ t: 0, pos: 0, del: '', ins: 'hello' }],
      },
      [],
    )

    expect(history.map((entry) => entry.text)).toEqual(['hello', 'hello world'])
    expect(history[1].t).toBeGreaterThan(history[0].t)
  })

  it('buildRhythmSamples weights multi-character changes above 1', () => {
    const samples = buildRhythmSamples([
      { t: 0, text: '' },
      { t: 20, text: 'hello' },
      { t: 40, text: 'hello world' },
    ])

    expect(samples).toEqual([
      { t: 20, weight: 5 },
      { t: 40, weight: 6 },
    ])
  })

  it('compressIdleGaps preserves smaller gaps unchanged', () => {
    const compressed = compressIdleGaps([
      { t: 100, text: 'a' },
      { t: 300, text: 'ab' },
      { t: 700, text: 'abc' },
    ], 5000)

    expect(compressed.map((entry) => entry.t)).toEqual([100, 300, 700])
    expect(compressed.map((entry) => entry.raw_t)).toEqual([100, 300, 700])
  })

  it('parseHistory clamps out-of-range positions instead of crashing reconstruction', () => {
    const history = parseHistory(
      {
        doc_text: 'ab',
        doc_history: [
          { t: 0, pos: 0, del: '', ins: 'a' },
          { t: 10, pos: 999, del: '', ins: 'b' },
        ],
      },
      [],
    )

    expect(history.map((entry) => entry.text)).toEqual(['a', 'ab'])
  })

  it('parseHistory treats numeric delete counts as character counts', () => {
    const history = parseHistory(
      {
        doc_text: 'hé',
        doc_history: [
          { t: 0, pos: 0, del: '', ins: 'héllo' },
          { t: 10, pos: 2, del: 3, ins: '' },
        ],
      },
      [],
    )

    expect(history.map((entry) => entry.text)).toEqual(['héllo', 'hé'])
  })

  it('parseHistory ignores malformed entries instead of poisoning later reconstruction', () => {
    const history = parseHistory(
      {
        doc_text: 'abc',
        doc_history: [
          { t: 0, pos: 0, del: '', ins: 'a' },
          { t: 5, nope: true },
          { t: 10, pos: 1, del: '', ins: 'bc' },
        ],
      },
      [],
    )

    expect(history.map((entry) => entry.text)).toEqual(['a', 'abc'])
  })

  it('parseHistory clamps negative positions to the start of the document', () => {
    const history = parseHistory(
      {
        doc_text: 'abc',
        doc_history: [
          { t: 0, pos: 0, del: '', ins: 'bc' },
          { t: 10, pos: -5, del: '', ins: 'a' },
        ],
      },
      [],
    )

    expect(history.map((entry) => entry.text)).toEqual(['bc', 'abc'])
  })

  it('parseHistory tolerates delete strings longer than the remaining tail', () => {
    const history = parseHistory(
      {
        doc_text: 'ab',
        doc_history: [
          { t: 0, pos: 0, del: '', ins: 'abcd' },
          { t: 10, pos: 2, del: 'cdefgh', ins: '' },
        ],
      },
      [],
    )

    expect(history.map((entry) => entry.text)).toEqual(['abcd', 'ab'])
  })

  it('parseHistory applies unicode string deletions by character count', () => {
    const history = parseHistory(
      {
        doc_text: 'go 😎',
        doc_history: [
          { t: 0, pos: 0, del: '', ins: 'go 😀😎' },
          { t: 10, pos: 3, del: '😀', ins: '' },
        ],
      },
      [],
    )

    expect(history.map((entry) => entry.text)).toEqual(['go 😀😎', 'go 😎'])
  })

  it('buildRhythmSamples gives replacement edits a nonzero weight', () => {
    const samples = buildRhythmSamples([
      { t: 0, text: '' },
      { t: 20, text: 'cat' },
      { t: 40, text: 'cot' },
    ])

    expect(samples).toEqual([
      { t: 20, weight: 3 },
      { t: 40, weight: 1 },
    ])
  })

  it('buildSyntheticHistory keeps empty final text as a single blank frame', () => {
    const history = buildSyntheticHistory('', [{ t: 1_000_000_000 }])

    expect(history).toEqual([{ t: 0, text: '' }])
  })
})
  it('safeJsonLines drops malformed json rows without dropping valid ones', () => {
    expect(
      safeJsonLines('{"type":"down","t":3}\nnot json\n\n{"type":"up","t":2}\n'),
    ).toEqual([
      { type: 'down', t: 3 },
      { type: 'up', t: 2 },
    ])
  })

  it('parseKeydowns keeps only down events and sorts them by time', () => {
    expect(
      parseKeydowns(
        '{"type":"up","t":8}\n{"type":"down","t":30}\n{"type":"down","t":10}\n{"type":"move"}',
      ),
    ).toEqual([
      { type: 'down', t: 10 },
      { type: 'down', t: 30 },
    ])
  })

  it('buildFocusSegments covers the whole replay with active and inactive ranges', () => {
    const history = compressIdleGaps([
      { t: 0, text: '' },
      { t: 1000, text: 'a' },
      { t: 120_000, text: 'ab' },
      { t: 180_000, text: 'abc' },
    ], 5000)
    const total = getDurationFromHistory(history)
    const compressedInactiveStart = compressedTimeForRawMs(history, 60_000)
    const compressedActiveResume = compressedTimeForRawMs(history, 150_000)

    expect(buildFocusSegments(
      [
        { t: 60_000, state: 'inactive' },
        { t: 150_000, state: 'active' },
      ],
      history,
      total,
    )).toEqual([
      { state: 'active', start: 0, end: compressedInactiveStart, rawStart: 0, rawEnd: 60_000 },
      {
        state: 'inactive',
        start: compressedInactiveStart,
        end: compressedActiveResume,
        rawStart: 60_000,
        rawEnd: 150_000,
      },
      {
        state: 'active',
        start: compressedActiveResume,
        end: total,
        rawStart: 150_000,
        rawEnd: 180_000,
      },
    ])
  })

  it('buildFocusSegments defaults to one active segment when no focus events exist', () => {
    const history = compressIdleGaps([
      { t: 0, text: '' },
      { t: 800, text: 'draft' },
      { t: 1600, text: 'draft done' },
    ], 5000)

    expect(buildFocusSegments([], history, getDurationFromHistory(history))).toEqual([
      { state: 'active', start: 0, end: 1600, rawStart: 0, rawEnd: 1600 },
    ])
  })
