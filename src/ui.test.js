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
  it('writes document stats with pluralization and reading estimates', async () => {
    const els = {
      'char-count': makeElement('char-count'),
      'page-count': makeElement('page-count'),
      'reading-time': makeElement('reading-time'),
    }
    global.document = {
      getElementById(id) { return els[id] ?? null },
    }

    const { updateDocStats } = await loadUiModule()
    updateDocStats('one two three')

    expect(els['char-count'].textContent).toBe('13 chars')
    expect(els['page-count'].textContent).toBe('Page 1 of 1')
    expect(els['reading-time'].textContent).toBe('~1 min read')
  })

  it('mirrors save status to both targets', async () => {
    const els = {
      'save-status': makeElement('save-status'),
      'tb-save-status': makeElement('tb-save-status'),
    }
    global.document = {
      getElementById(id) { return els[id] ?? null },
    }

    const { setSaveStatus } = await loadUiModule()
    setSaveStatus('Saved just now')

    expect(els['save-status'].textContent).toBe('Saved just now')
    expect(els['tb-save-status'].textContent).toBe('Saved just now')
  })

  it('ignores missing DOM targets without throwing', async () => {
    global.document = {
      getElementById() { return null },
    }

    const { initUI, updateDocStats, setSaveStatus, teardownUI } = await loadUiModule()
    expect(() => initUI()).not.toThrow()
    expect(() => updateDocStats('')).not.toThrow()
    expect(() => setSaveStatus('ok')).not.toThrow()
    expect(() => teardownUI()).not.toThrow()
  })
})
