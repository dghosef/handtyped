import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function makeElement(id) {
  return { id, textContent: '' }
}

async function loadUiModule() {
  vi.resetModules()
  return import('./ui.js')
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-03-28T00:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('ui helpers', () => {
  it('updates timer text every second after init', async () => {
    const els = { timer: makeElement('timer') }
    global.document = {
      getElementById(id) { return els[id] ?? null },
    }

    const { initUI, teardownUI } = await loadUiModule()
    initUI()
    vi.advanceTimersByTime(65_000)

    expect(els.timer.textContent).toBe('01:05')
    teardownUI()
  })

  it('writes document stats with pluralization and reading estimates', async () => {
    const els = {
      'word-count': makeElement('word-count'),
      'char-count': makeElement('char-count'),
      'page-count': makeElement('page-count'),
      'reading-time': makeElement('reading-time'),
    }
    global.document = {
      getElementById(id) { return els[id] ?? null },
    }

    const { updateDocStats } = await loadUiModule()
    updateDocStats('one two three')

    expect(els['word-count'].textContent).toBe('3 words')
    expect(els['char-count'].textContent).toBe('13 chars')
    expect(els['page-count'].textContent).toBe('Page 1 of 1')
    expect(els['reading-time'].textContent).toBe('~1 min read')
  })

  it('formats keystroke count and mirrors save status to both targets', async () => {
    const els = {
      'keystroke-count': makeElement('keystroke-count'),
      'save-status': makeElement('save-status'),
      'tb-save-status': makeElement('tb-save-status'),
    }
    global.document = {
      getElementById(id) { return els[id] ?? null },
    }

    const { updateKeystrokeCount, setSaveStatus } = await loadUiModule()
    updateKeystrokeCount(1234)
    setSaveStatus('Saved just now')

    expect(els['keystroke-count'].textContent).toBe('1,234 keystrokes')
    expect(els['save-status'].textContent).toBe('Saved just now')
    expect(els['tb-save-status'].textContent).toBe('Saved just now')
  })

  it('ignores missing DOM targets without throwing', async () => {
    global.document = {
      getElementById() { return null },
    }

    const { initUI, updateDocStats, updateKeystrokeCount, setSaveStatus, teardownUI } = await loadUiModule()
    expect(() => initUI()).not.toThrow()
    expect(() => updateDocStats('')).not.toThrow()
    expect(() => updateKeystrokeCount(0)).not.toThrow()
    expect(() => setSaveStatus('ok')).not.toThrow()
    expect(() => teardownUI()).not.toThrow()
  })
})
