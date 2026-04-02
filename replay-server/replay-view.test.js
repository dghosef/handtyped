import { describe, expect, it } from 'vitest'
import { buildSyntheticHistory, findHistoryIndex, parseHistory } from './public/replay-view.js'

describe('replay history start state', () => {
  it('starts parsed histories with a blank frame before the first typed content', () => {
    const history = parseHistory(
      {
        doc_text: 'Hello',
        doc_history: [{ t: 0, pos: 0, del: '', ins: 'Hello' }],
      },
      [],
    )

    expect(history[0]).toEqual({ t: 0, text: '' })
    expect(history[1].text).toBe('Hello')
    expect(history[1].t).toBeGreaterThan(0)
    expect(findHistoryIndex(history, 0)).toBe(0)
  })

  it('starts synthetic histories with a blank frame even when the first keydown is at t=0', () => {
    const history = buildSyntheticHistory('Hi', [{ t: 0 }, { t: 10 }])

    expect(history[0]).toEqual({ t: 0, text: '' })
    expect(history[1].text).toBe('H')
    expect(history[1].t).toBeGreaterThan(0)
    expect(findHistoryIndex(history, 0)).toBe(0)
  })
})
