import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.fn(async (command) => {
  if (command === 'save_editor_state') return null
  return null
})

vi.mock('./bridge.js', () => ({
  invoke: (...args) => invokeMock(...args),
}))

function makeElement(id) {
  const listeners = new Map()
  return {
    id,
    style: {
      removeProperty(name) {
        delete this[name]
      },
    },
    innerText: '',
    innerHTML: '',
    textContent: '',
    scrollTop: 0,
    value: '',
    focus: vi.fn(),
    setSelectionRange: vi.fn(),
    _listeners: listeners,
    classList: {
      _set: new Set(),
      add(name) { this._set.add(name) },
      remove(name) { this._set.delete(name) },
      toggle(name, force) {
        if (force === true) this._set.add(name)
        else if (force === false) this._set.delete(name)
        else if (this._set.has(name)) this._set.delete(name)
        else this._set.add(name)
      },
      contains(name) { return this._set.has(name) },
    },
    addEventListener(type, fn) {
      const handlers = listeners.get(type) ?? []
      handlers.push(fn)
      listeners.set(type, handlers)
    },
    selectionStart: 0,
    selectionEnd: 0,
  }
}

function firstListener(el, type) {
  return el._listeners.get(type)?.[0]
}

async function loadMarkdownModule() {
  vi.resetModules()
  return import('./markdown.js')
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.restoreAllMocks()
  invokeMock.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('markdown mode', () => {
  it('serializes and parses markdown with headings', async () => {
    const { parseFromMarkdown, serializeToMarkdown } = await loadMarkdownModule()
    const doc = parseFromMarkdown('# Title\n\nParagraph')

    expect(doc).toBeTruthy()
    expect(doc.firstChild.type.name).toBe('heading')
    expect(serializeToMarkdown({ doc })).toContain('# Title')
  })

  it('cycles through split, source, and back to rich text', async () => {
    const mod = await loadMarkdownModule()
    const {
      initMarkdown,
      cycleMarkdownMode,
      getMarkdownState,
      parseFromMarkdown,
    } = mod

    const els = {
      editor: makeElement('editor'),
      page: makeElement('page'),
      'md-split-pane': makeElement('md-split-pane'),
      'md-source-input': makeElement('md-source-input'),
      'md-highlight': makeElement('md-highlight'),
      'md-preview': makeElement('md-preview'),
      'btn-markdown': makeElement('btn-markdown'),
    }

    global.document = {
      getElementById(id) { return els[id] ?? null },
    }

    const doc = parseFromMarkdown('# Start\n\nBody')
    const dispatched = []
    const view = {
      state: {
        doc,
        tr: {
          replaceWith(from, to, content) {
            return { from, to, content }
          },
        },
      },
      dispatch(tr) { dispatched.push(tr) },
      focus: vi.fn(),
    }

    initMarkdown(view)
    cycleMarkdownMode()
    expect(getMarkdownState()).toBe('split')
    expect(els['md-split-pane'].classList.contains('visible')).toBe(true)
    expect(els['btn-markdown'].textContent).toBe('MD ⫿')
    expect(els['md-preview'].innerHTML).toContain('<h1>Start</h1>')
    expect(els['md-source-input'].focus).toHaveBeenCalled()
    expect(els['md-source-input'].setSelectionRange).toHaveBeenCalled()
    expect(els.page.style.display).toBe('none')

    els['md-source-input'].value = '# Changed\n\nUpdated body'
    firstListener(els['md-source-input'], 'input')()
    cycleMarkdownMode()
    expect(getMarkdownState()).toBe('source')
    expect(els['btn-markdown'].textContent).toBe('MD src')
    expect(els['md-preview'].style.display).toBe('none')

    cycleMarkdownMode()
    expect(getMarkdownState()).toBe('off')
    expect(dispatched).toHaveLength(1)
    expect(els['md-split-pane'].classList.contains('visible')).toBe(false)
    expect(els.page.style.display).toBe('')
  })

  it('updates preview after debounce and syncs highlight scroll', async () => {
    const { initMarkdown, cycleMarkdownMode, parseFromMarkdown } = await loadMarkdownModule()
    const els = {
      editor: makeElement('editor'),
      page: makeElement('page'),
      'md-split-pane': makeElement('md-split-pane'),
      'md-source-input': makeElement('md-source-input'),
      'md-highlight': makeElement('md-highlight'),
      'md-preview': makeElement('md-preview'),
      'btn-markdown': makeElement('btn-markdown'),
    }

    global.document = {
      getElementById(id) { return els[id] ?? null },
    }

    const view = {
      state: { doc: parseFromMarkdown('# Start') },
      dispatch: vi.fn(),
      focus: vi.fn(),
    }

    initMarkdown(view)
    cycleMarkdownMode()
    els['md-source-input'].value = '# New Title\n\n**bold**'
    firstListener(els['md-source-input'], 'input')()

    expect(els['md-preview'].innerHTML).toContain('<h1>New Title</h1>')
    vi.advanceTimersByTime(150)
    expect(els['md-preview'].innerHTML).toContain('<h1>New Title</h1>')
    expect(els['md-highlight'].innerHTML).toContain('md-h1')
    expect(els['md-highlight'].innerHTML).toContain('md-strong')

    els['md-source-input'].scrollTop = 42
    firstListener(els['md-source-input'], 'scroll')()
    expect(els['md-highlight'].scrollTop).toBe(42)

    els['md-source-input'].scrollTop = 84
    firstListener(els['md-source-input'], 'keyup')()
    expect(els['md-highlight'].scrollTop).toBe(84)
  })

  it('attaches source listeners only once and keeps dirty source between split and source states', async () => {
    const { initMarkdown, cycleMarkdownMode, parseFromMarkdown } = await loadMarkdownModule()
    const els = {
      editor: makeElement('editor'),
      page: makeElement('page'),
      'md-split-pane': makeElement('md-split-pane'),
      'md-source-input': makeElement('md-source-input'),
      'md-highlight': makeElement('md-highlight'),
      'md-preview': makeElement('md-preview'),
      'btn-markdown': makeElement('btn-markdown'),
    }

    global.document = {
      getElementById(id) { return els[id] ?? null },
    }

    const view = {
      state: {
        doc: parseFromMarkdown('# Initial'),
        tr: {
          replaceWith(from, to, content) {
            return { from, to, content }
          },
        },
      },
      dispatch: vi.fn(),
      focus: vi.fn(),
    }

    initMarkdown(view)
    cycleMarkdownMode()
    expect(els['md-source-input']._listeners.get('input')).toHaveLength(1)

    els['md-source-input'].value = '# Dirty Source'
    firstListener(els['md-source-input'], 'input')()
    cycleMarkdownMode()

    expect(els['md-source-input']._listeners.get('input')).toHaveLength(1)
    expect(els['md-source-input'].value).toBe('# Dirty Source')
  })

  it('primes and persists rust-backed markdown state', async () => {
    const { initMarkdown, cycleMarkdownMode, primeMarkdownSource, getMarkdownSourceText, parseFromMarkdown } = await loadMarkdownModule()
    const els = {
      editor: makeElement('editor'),
      page: makeElement('page'),
      'md-split-pane': makeElement('md-split-pane'),
      'md-source-input': makeElement('md-source-input'),
      'md-highlight': makeElement('md-highlight'),
      'md-preview': makeElement('md-preview'),
      'btn-markdown': makeElement('btn-markdown'),
    }

    global.document = {
      getElementById(id) { return els[id] ?? null },
    }

    const view = {
      state: { doc: parseFromMarkdown('# Existing') },
      dispatch: vi.fn(),
      focus: vi.fn(),
    }

    initMarkdown(view)
    primeMarkdownSource('# Rust-owned\n\nBody', 3, 'source')
    cycleMarkdownMode()

    expect(getMarkdownSourceText()).toContain('# Rust-owned')

    els['md-source-input'].value = '# Changed'
    firstListener(els['md-source-input'], 'input')()
    vi.advanceTimersByTime(250)
    await Promise.resolve()
    await Promise.resolve()

    expect(invokeMock).toHaveBeenCalledWith('save_editor_state', expect.objectContaining({
      markdown: '# Changed',
      mode: 'split',
    }))
  })

  it('supports a minimal vim normal/insert flow in the markdown source textarea', async () => {
    const { initMarkdown, cycleMarkdownMode, toggleVimMode, getVimMode, parseFromMarkdown } = await loadMarkdownModule()
    const els = {
      editor: makeElement('editor'),
      page: makeElement('page'),
      'md-split-pane': makeElement('md-split-pane'),
      'md-source-input': makeElement('md-source-input'),
      'md-highlight': makeElement('md-highlight'),
      'md-preview': makeElement('md-preview'),
      'btn-markdown': makeElement('btn-markdown'),
    }

    global.document = {
      getElementById(id) { return els[id] ?? null },
    }

    const view = {
      state: { doc: parseFromMarkdown('hello') },
      dispatch: vi.fn(),
      focus: vi.fn(),
    }

    initMarkdown(view)
    cycleMarkdownMode()
    els['md-source-input'].value = 'hello'
    els['md-source-input'].selectionStart = 0
    els['md-source-input'].selectionEnd = 0

    toggleVimMode()
    expect(getVimMode()).toBe('normal')

    firstListener(els['md-source-input'], 'keydown')({ key: 'l', preventDefault: vi.fn() })
    expect(els['md-source-input'].selectionStart).toBe(1)

    firstListener(els['md-source-input'], 'keydown')({ key: 'x', preventDefault: vi.fn() })
    expect(els['md-source-input'].value).toBe('hllo')

    firstListener(els['md-source-input'], 'keydown')({ key: 'i', preventDefault: vi.fn() })
    expect(getVimMode()).toBe('insert')

    firstListener(els['md-source-input'], 'keydown')({ key: 'Escape', preventDefault: vi.fn() })
    expect(getVimMode()).toBe('normal')
  })
})
