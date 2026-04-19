import { describe, expect, it } from 'vitest'
import {
  buildSyntheticHistory,
  buildRhythmSamples,
  compressIdleGaps,
  documentWithAttribution,
  downloadFilenameForDocument,
  getDurationFromHistory,
  getElapsedRawTime,
  getRawDurationFromHistory,
  findHistoryIndex,
  parseHistory,
} from './public/replay-view.js'
import fs from 'node:fs'
import path from 'node:path'

const replayPageHtml = fs.readFileSync(
  path.join(process.cwd(), 'public', 'replay.html'),
  'utf8',
)

describe('replay history start state', () => {
  it('uses the homepage header font for the replay title', () => {
    expect(replayPageHtml).toContain(
      "fonts.googleapis.com/css?family=Open%20Sans%3A400%2C600%2C700&display=swap",
    )
    expect(replayPageHtml).toContain("font-family: 'Open Sans', Arial, Helvetica, sans-serif;")
    expect(replayPageHtml).toContain('.brand-name {')
    expect(replayPageHtml).toContain('h1 {')
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
