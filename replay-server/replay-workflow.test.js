import { describe, expect, it } from 'vitest'
import {
  buildRhythmSamples,
  findHistoryIndex,
  getDurationFromHistory,
  parseHistory,
} from './public/replay-view.js'

function buildWorkflowSession() {
  return {
    doc_text: 'Hello world\nreopened line',
    doc_history: [
      { t: 0, text: '' },
      { t: 90, text: 'H' },
      { t: 180, text: 'He' },
      { t: 270, text: 'Hel' },
      { t: 360, text: 'Hell' },
      { t: 450, text: 'Hello' },
      { t: 930, text: 'Hello ' },
      { t: 1020, text: 'Hello w' },
      { t: 1110, text: 'Hello wo' },
      { t: 1200, text: 'Hello wor' },
      { t: 1290, text: 'Hello worl' },
      { t: 1380, text: 'Hello world' },
      { t: 1700, text: 'Hello' },
      { t: 1860, text: 'Hello world' },
      { t: 3200, text: 'Hello world\n' },
      { t: 3290, text: 'Hello world\nr' },
      { t: 3380, text: 'Hello world\nre' },
      { t: 3470, text: 'Hello world\nreo' },
      { t: 3560, text: 'Hello world\nreop' },
      { t: 3650, text: 'Hello world\nreope' },
      { t: 3740, text: 'Hello world\nreopen' },
      { t: 3830, text: 'Hello world\nreopened' },
      { t: 3920, text: 'Hello world\nreopened ' },
      { t: 4010, text: 'Hello world\nreopened l' },
      { t: 4100, text: 'Hello world\nreopened li' },
      { t: 4190, text: 'Hello world\nreopened lin' },
      { t: 4280, text: 'Hello world\nreopened line' },
      { t: 4700, text: 'Hello world\n' },
      { t: 4900, text: 'Hello world\nreopened line' },
    ],
  }
}

function buildBlogPostSession() {
    return {
      doc_text:
        '# What I learned building Handtyped\n\n' +
        'I started this project to answer a simple question: can a document prove it was really typed by a person?\n\n' +
        'The answer turned out to depend on hardware-gated input, persistent undo, and a replay timeline that feels honest.\n\n' +
        'Along the way I found a small bug in the replay clock that made early drafts look incomplete.\n\n' +
        'That bug was annoying, but the fix was straightforward once the timeline was measured correctly.\n\n' +
      'Readers should be able to follow the proof from the first keystroke.\n\n' +
      'Readers should be able to follow the proof from the first keystroke.',
    doc_history: [
      { t: 0, text: '' },
      { t: 90, text: '#' },
      { t: 180, text: '# ' },
      { t: 270, text: '# W' },
      { t: 360, text: '# Wh' },
      { t: 450, text: '# Wha' },
      { t: 540, text: '# What' },
      { t: 630, text: '# What ' },
      { t: 720, text: '# What I' },
      { t: 810, text: '# What I ' },
      { t: 900, text: '# What I learned building Handtyped' },
      { t: 2450, text: '# What I learned building Handtyped\n\n' },
      { t: 2540, text: '# What I learned building Handtyped\n\nI' },
      { t: 2630, text: '# What I learned building Handtyped\n\nI started this project to answer a simple question: ' },
      { t: 2720, text: '# What I learned building Handtyped\n\nI started this project to answer a simple question: can a document prove it was really typed by a person?' },
      { t: 4380, text: '# What I learned building Handtyped\n\nI started this project to answer a simple question: can a document prove it was really typed by a person?\n\n' },
      { t: 4470, text: '# What I learned building Handtyped\n\nI started this project to answer a simple question: can a document prove it was really typed by a person?\n\nT' },
      { t: 4560, text: '# What I learned building Handtyped\n\nI started this project to answer a simple question: can a document prove it was really typed by a person?\n\nThe answer turned out to depend on hardware-gated input, persistent undo, and a replay timeline that feels honest.' },
      { t: 6020, text: '# What I learned building Handtyped\n\nI started this project to answer a simple question: can a document prove it was really typed by a person?\n\nThe answer turned out to depend on hardware-gated input, persistent undo, and a replay timeline that feels honest.\n\n' },
      { t: 6110, text: '# What I learned building Handtyped\n\nI started this project to answer a simple question: can a document prove it was really typed by a person?\n\nThe answer turned out to depend on hardware-gated input, persistent undo, and a replay timeline that feels honest.\n\nA' },
      { t: 6200, text: '# What I learned building Handtyped\n\nI started this project to answer a simple question: can a document prove it was really typed by a person?\n\nThe answer turned out to depend on hardware-gated input, persistent undo, and a replay timeline that feels honest.\n\nAlong the way I found a small bug in the replay clock that made early drafts look incomplete.' },
      { t: 7660, text: '# What I learned building Handtyped\n\nI started this project to answer a simple question: can a document prove it was really typed by a person?\n\nThe answer turned out to depend on hardware-gated input, persistent undo, and a replay timeline that feels honest.\n\nAlong the way I found a small bug in the replay clock that made early drafts look incomplete.\n\n' },
      { t: 7750, text: '# What I learned building Handtyped\n\nI started this project to answer a simple question: can a document prove it was really typed by a person?\n\nThe answer turned out to depend on hardware-gated input, persistent undo, and a replay timeline that feels honest.\n\nAlong the way I found a small bug in the replay clock that made early drafts look incomplete.\n\nThat bug was annoyng' },
      { t: 7840, text: '# What I learned building Handtyped\n\nI started this project to answer a simple question: can a document prove it was really typed by a person?\n\nThe answer turned out to depend on hardware-gated input, persistent undo, and a replay timeline that feels honest.\n\nAlong the way I found a small bug in the replay clock that made early drafts look incomplete.\n\nThat bug was annoyin' },
      { t: 7930, text: '# What I learned building Handtyped\n\nI started this project to answer a simple question: can a document prove it was really typed by a person?\n\nThe answer turned out to depend on hardware-gated input, persistent undo, and a replay timeline that feels honest.\n\nAlong the way I found a small bug in the replay clock that made early drafts look incomplete.\n\nThat bug was annoying' },
      { t: 8020, text: '# What I learned building Handtyped\n\nI started this project to answer a simple question: can a document prove it was really typed by a person?\n\nThe answer turned out to depend on hardware-gated input, persistent undo, and a replay timeline that feels honest.\n\nAlong the way I found a small bug in the replay clock that made early drafts look incomplete.\n\nThat bug was annoying, but the fix was straightforward once the timeline was measured correctly.' },
      { t: 9480, text: '# What I learned building Handtyped\n\nI started this project to answer a simple question: can a document prove it was really typed by a person?\n\nThe answer turned out to depend on hardware-gated input, persistent undo, and a replay timeline that feels honest.\n\nAlong the way I found a small bug in the replay clock that made early drafts look incomplete.\n\nThat bug was annoying, but the fix was straightforward once the timeline was measured correctly.\n\n' },
      { t: 9570, text: '# What I learned building Handtyped\n\nI started this project to answer a simple question: can a document prove it was really typed by a person?\n\nThe answer turned out to depend on hardware-gated input, persistent undo, and a replay timeline that feels honest.\n\nAlong the way I found a small bug in the replay clock that made early drafts look incomplete.\n\nThat bug was annoying, but the fix was straightforward once the timeline was measured correctly.\n\nReaders should be able to follow the proof from the first keystroke.' },
      { t: 10650, text: '# What I learned building Handtyped\n\nI started this project to answer a simple question: can a document prove it was really typed by a person?\n\nThe answer turned out to depend on hardware-gated input, persistent undo, and a replay timeline that feels honest.\n\nAlong the way I found a small bug in the replay clock that made early drafts look incomplete.\n\nThat bug was annoying, but the fix was straightforward once the timeline was measured correctly.\n\nReaders should be able to follow the proof from the first keystroke.\n\n' },
      { t: 10740, text: '# What I learned building Handtyped\n\nI started this project to answer a simple question: can a document prove it was really typed by a person?\n\nThe answer turned out to depend on hardware-gated input, persistent undo, and a replay timeline that feels honest.\n\nAlong the way I found a small bug in the replay clock that made early drafts look incomplete.\n\nThat bug was annoying, but the fix was straightforward once the timeline was measured correctly.\n\nReaders should be able to follow the proof from the first keystroke.\n\nReaders should be able to follow the proof from the first keystroke.' },
    ],
  }
}

function buildLongFormSession() {
  const paragraphs = [
    '# A longer essay about Human Editing',
    'Human editing has to survive the boring parts too, not just the headline demo.',
    'That means the editor must keep blank lines, paragraph breaks, and small pauses intact.',
    'It also means the replay needs to feel like the same draft the person saw on screen.',
    'A long draft should still preserve the exact shape of the text after save and reopen.',
    'Undo and redo should not collapse the document into a different structure.',
    'The final check is always whether the document still reads like a human wrote it.',
    'If a single blank line disappears, the whole proof starts to feel suspicious.',
  ]

  let doc_text = ''
  const doc_history = [{ t: 0, text: '' }]
  let t = 90

  paragraphs.forEach((paragraph, index) => {
    if (index > 0) {
      doc_text += '\n\n'
      doc_history.push({ t: t - 1, text: doc_text })
      t += 750
    }

    for (const ch of paragraph) {
      doc_text += ch
      doc_history.push({ t, text: doc_text })
      t += 90
    }
  })

  return { doc_text, doc_history }
}

describe('workflow replay', () => {
  it('replays a mixed novim/vim session from blank start to final text', () => {
    const session = buildWorkflowSession()
    const history = parseHistory(session, [])

    expect(history[0]).toEqual({ t: 0, text: '' })
    expect(findHistoryIndex(history, 0)).toBe(0)
    expect(findHistoryIndex(history, 449)).toBe(4)
    expect(findHistoryIndex(history, 450)).toBe(5)
    expect(findHistoryIndex(history, 1700)).toBe(12)
    expect(findHistoryIndex(history, 1860)).toBe(13)
    expect(findHistoryIndex(history, 3199)).toBe(13)
    expect(findHistoryIndex(history, 3200)).toBe(14)
    expect(findHistoryIndex(history, 4900)).toBe(history.length - 1)
    expect(getDurationFromHistory(history)).toBe(4900)

    const rhythm = buildRhythmSamples(history, [])
    expect(rhythm.length).toBeGreaterThan(10)
    expect(rhythm[0]).toEqual({ t: 90, weight: 1 })
    expect(rhythm[rhythm.length - 1]).toEqual({ t: 4900, weight: 13 })
  })

  it('replays a full blog draft with natural pauses, corrections, and a vim addendum', () => {
    const session = buildBlogPostSession()
    const history = parseHistory(session, [])

    expect(history[0]).toEqual({ t: 0, text: '' })
    expect(history[history.length - 1].text).toBe(session.doc_text)
    expect(findHistoryIndex(history, 900)).toBeGreaterThanOrEqual(9)
    expect(findHistoryIndex(history, 2720)).toBeGreaterThanOrEqual(14)
    expect(findHistoryIndex(history, 8020)).toBeGreaterThanOrEqual(20)
    expect(findHistoryIndex(history, 9570)).toBeGreaterThanOrEqual(24)
    expect(findHistoryIndex(history, 10740)).toBe(history.length - 1)
    expect(getDurationFromHistory(history)).toBe(10740)

    const rhythm = buildRhythmSamples(history, [])
    expect(rhythm.length).toBeGreaterThan(20)
    expect(rhythm[0].t).toBe(90)
    expect(rhythm.some((sample) => sample.t >= 7660 && sample.t <= 8020)).toBe(true)
    expect(rhythm[rhythm.length - 1].t).toBe(10740)
    expect(rhythm[rhythm.length - 1].weight).toBeGreaterThan(10)
  })

  it('replays a long-form draft without losing paragraph boundaries or timing', () => {
    const session = buildLongFormSession()
    const history = parseHistory(session, [])

    expect(history[0]).toEqual({ t: 0, text: '' })
    expect(history[history.length - 1].text).toBe(session.doc_text)
    expect(session.doc_text.split('\n\n')).toHaveLength(8)
    expect(findHistoryIndex(history, 0)).toBe(0)
    expect(findHistoryIndex(history, 89)).toBe(0)
    expect(findHistoryIndex(history, 90)).toBe(1)
    expect(findHistoryIndex(history, getDurationFromHistory(history))).toBe(history.length - 1)

    const rhythm = buildRhythmSamples(history, [])
    expect(rhythm.length).toBeGreaterThan(40)
    expect(rhythm[0].t).toBe(90)
    expect(rhythm[rhythm.length - 1].t).toBe(getDurationFromHistory(history))
  })

  it('replays a compact delta-based workflow without needing snapshot entries', () => {
    const session = {
      doc_text: 'cat\nquote',
      doc_history: [
        { t: 0, pos: 0, del: '', ins: 'cat' },
        { t: 20, pos: 3, del: '', ins: '\n' },
        { t: 30, pos: 4, del: '', ins: 'quxte' },
        { t: 40, pos: 6, del: 'x', ins: 'o' },
      ],
    }

    const history = parseHistory(session, [])

    expect(history.map((entry) => entry.text)).toEqual([
      'cat',
      'cat\n',
      'cat\nquxte',
      'cat\nquote',
    ])
    expect(findHistoryIndex(history, 39)).toBe(2)
    expect(findHistoryIndex(history, 40)).toBe(3)
    expect(getDurationFromHistory(history)).toBe(40)
  })

  it('builds replay duration from compact history even when timestamps start late', () => {
    const session = {
      doc_text: 'done',
      doc_history: [
        { t: 1500, pos: 0, del: '', ins: 'do' },
        { t: 2400, pos: 2, del: '', ins: 'ne' },
      ],
    }

    const history = parseHistory(session, [])

    expect(history[0].t).toBe(1500)
    expect(getDurationFromHistory(history)).toBe(2400)
    expect(findHistoryIndex(history, 1499)).toBe(-1)
    expect(findHistoryIndex(history, 1500)).toBe(0)
  })
})
