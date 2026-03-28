import { defaultMarkdownParser, defaultMarkdownSerializer } from 'prosemirror-markdown'
import MarkdownIt from 'markdown-it'

const markdownRenderer = new MarkdownIt({
  html: false,
  breaks: false,
  linkify: true,
  typographer: true,
})

const STATES = ['off', 'split', 'source']
const LABELS = { off: 'MD', split: 'MD ⫿', source: 'MD src' }
const PREVIEW_DOC_CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 20px 32px;
    background: white;
    color: #111;
    font: 14px/1.7 -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
    white-space: normal;
  }
  h1, h2, h3, h4, h5, h6 {
    display: block;
    margin: 1em 0 0.45em;
    color: #111;
    font-weight: 700;
    line-height: 1.2;
  }
  h1:first-child, h2:first-child, h3:first-child, h4:first-child, h5:first-child, h6:first-child { margin-top: 0; }
  h1 { font-size: 2.1rem; letter-spacing: -0.03em; }
  h2 { font-size: 1.65rem; letter-spacing: -0.02em; }
  h3 { font-size: 1.3rem; }
  h4 { font-size: 1.1rem; }
  h5 { font-size: 1rem; }
  h6 { font-size: 0.9rem; color: #666; text-transform: uppercase; letter-spacing: 0.06em; }
  p, ul, ol, pre, blockquote, table { display: block; margin: 0 0 1em; }
  ul, ol { padding-left: 1.4em; }
  li + li { margin-top: 0.2em; }
  a { color: #0f6cbd; text-decoration: none; }
  a:hover { text-decoration: underline; }
  code {
    background: #f0f0f0;
    padding: 1px 4px;
    border-radius: 3px;
    font: 12px/1.5 "SFMono-Regular", Menlo, "Courier New", monospace;
  }
  pre {
    background: #1e1e1e;
    color: #d4d4d4;
    padding: 12px;
    border-radius: 6px;
    overflow-x: auto;
  }
  pre code {
    display: block;
    background: transparent;
    color: inherit;
    padding: 0;
    border-radius: 0;
    white-space: pre;
  }
  blockquote {
    border-left: 3px solid #ccc;
    margin: 0 0 1em;
    padding-left: 16px;
    color: #666;
  }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ddd; padding: 8px 10px; text-align: left; vertical-align: top; }
  th { background: #f6f8fa; font-weight: 600; }
  hr { border: 0; border-top: 1px solid #ddd; margin: 1.5em 0; }
`

let _state = 'off'
let _view = null
let _previewTimer = null
let _syncTimer = null
let _listenersAttached = false
let _sourceDirty = false
let _lastSyncedSource = ''

function normalizeMarkdownText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u2028|\u2029/g, '\n')
}

function normalizeMarkdownForRender(text) {
  return normalizeMarkdownText(text)
    // Be slightly forgiving for ATX headings typed as "#Heading".
    .replace(/^(#{1,6})([^\s#])/gm, '$1 $2')
    // Same idea for blockquotes typed as ">quote".
    .replace(/^(>)([^\s>])/gm, '$1 $2')
}

export function initMarkdown(view) {
  _view = view
}

export function isMarkdownMode() {
  return _state !== 'off'
}

export function getMarkdownState() {
  return _state
}

export function cycleMarkdownMode() {
  const prev = _state
  const idx = STATES.indexOf(_state)
  const next = STATES[(idx + 1) % STATES.length]

  if (prev !== 'off' && next === 'off') {
    const srcEl = document.getElementById('md-source-input')
    const text = normalizeMarkdownText(srcEl?.value ?? '')
    const doc = _parseMarkdown(text)
    if (doc && _view) {
      const end = _view.state.doc.content.size
      _view.dispatch(_view.state.tr.replaceWith(0, end, doc.content))
    }
    _sourceDirty = false
  }

  _state = next
  _applyState(prev)
}

export function toggleMarkdownMode() {
  cycleMarkdownMode()
}

export function serializeToMarkdown(state) {
  try {
    return defaultMarkdownSerializer.serialize(state.doc)
  } catch {
    return state.doc.textContent
  }
}

export function parseFromMarkdown(text) {
  return _parseMarkdown(text)
}

function _parseMarkdown(text) {
  try {
    return defaultMarkdownParser.parse(normalizeMarkdownForRender(text))
  } catch {
    return null
  }
}

function _applyState(prev) {
  const editorEl = document.getElementById('editor')
  const pageEl = document.getElementById('page')
  const splitEl = document.getElementById('md-split-pane')
  const srcEl = document.getElementById('md-source-input')
  const prevEl = document.getElementById('md-preview')
  const btn = document.getElementById('btn-markdown')

  if (btn) {
    btn.textContent = LABELS[_state]
    btn.classList.toggle('active', _state !== 'off')
  }

  if (_state === 'off') {
    _stopSourceSync()
    if (editorEl) editorEl.style.display = ''
    if (pageEl) pageEl.style.display = ''
    if (pageEl) pageEl.style.removeProperty('padding')
    splitEl?.classList.remove('visible')
    _view?.focus()
    return
  }

  const shouldRefreshSource = prev === 'off' || !_sourceDirty
  const md = _view ? serializeToMarkdown(_view.state) : ''

  if (editorEl) editorEl.style.display = 'none'
  if (pageEl) {
    pageEl.style.padding = '0'
    pageEl.style.display = 'none'
  }
  splitEl?.classList.add('visible')

  if (srcEl && shouldRefreshSource) {
    srcEl.value = normalizeMarkdownText(md)
    _syncSourceToPreview(true)
  } else if (srcEl) {
    _syncSourceToPreview(true)
  }

  if (_state === 'split') {
    if (prevEl) prevEl.style.display = 'flex'
    _renderPreview(srcEl?.value ?? md)
  } else if (prevEl) {
    prevEl.style.display = 'none'
  }

  _setupSourceListeners()
  _startSourceSync()
  _focusSourceEditor()
}

function _syncSourceToPreview(force = false) {
  const srcEl = document.getElementById('md-source-input')
  if (!srcEl) return
  const text = normalizeMarkdownText(srcEl.value)
  if (text !== srcEl.value) srcEl.value = text
  if (!force && text === _lastSyncedSource) return
  _lastSyncedSource = text
  _sourceDirty = true
  _updateHighlight(text)
  if (_state === 'split') _renderPreview(text)
}

function _startSourceSync() {
  _stopSourceSync()
  _syncSourceToPreview(true)
  _syncTimer = setInterval(() => {
    if (_state === 'off') return
    _syncSourceToPreview(false)
  }, 120)
}

function _stopSourceSync() {
  if (_syncTimer) clearInterval(_syncTimer)
  _syncTimer = null
}

function _setupSourceListeners() {
  if (_listenersAttached) return
  const srcEl = document.getElementById('md-source-input')
  const hlEl = document.getElementById('md-highlight')
  if (!srcEl) return

  _listenersAttached = true

  const syncFromSource = (renderNow = false) => {
    _syncSourceToPreview(true)
    clearTimeout(_previewTimer)
    const delay = renderNow ? 0 : 75
    _previewTimer = setTimeout(() => {
      _syncSourceToPreview(true)
    }, delay)
  }

  srcEl.addEventListener('input', () => {
    syncFromSource(false)
  })

  srcEl.addEventListener('scroll', () => {
    if (hlEl) hlEl.scrollTop = srcEl.scrollTop
  })

  srcEl.addEventListener('keyup', () => {
    if (hlEl) hlEl.scrollTop = srcEl.scrollTop
    syncFromSource(true)
  })

  srcEl.addEventListener('change', () => {
    syncFromSource(true)
  })

  srcEl.addEventListener('paste', () => {
    setTimeout(() => syncFromSource(true), 0)
  })
}

function _renderPreview(markdownText) {
  const el = document.getElementById('md-preview')
  if (el) {
    const rendered = markdownRenderer.render(normalizeMarkdownForRender(markdownText))
    const html = globalThis.DOMPurify ? globalThis.DOMPurify.sanitize(rendered) : rendered
    if (el.tagName === 'IFRAME') {
      el.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>${PREVIEW_DOC_CSS}</style></head><body>${html}</body></html>`
    } else {
      el.innerHTML = html
    }
  }
}

function _focusSourceEditor() {
  const srcEl = document.getElementById('md-source-input')
  if (!srcEl || typeof srcEl.focus !== 'function') return
  srcEl.focus()
  if (typeof srcEl.setSelectionRange === 'function') {
    const end = srcEl.value.length
    srcEl.setSelectionRange(end, end)
  }
}

function _esc(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function _highlightLine(line) {
  if (/^######/.test(line)) return `<span class="md-h6">${_esc(line)}</span>`
  if (/^#####/.test(line)) return `<span class="md-h5">${_esc(line)}</span>`
  if (/^####/.test(line)) return `<span class="md-h4">${_esc(line)}</span>`
  if (/^###/.test(line)) return `<span class="md-h3">${_esc(line)}</span>`
  if (/^##/.test(line)) return `<span class="md-h2">${_esc(line)}</span>`
  if (/^#/.test(line)) return `<span class="md-h1">${_esc(line)}</span>`
  if (/^>/.test(line)) return `<span class="md-quote">${_esc(line)}</span>`
  if (/^[-*+] /.test(line) || /^\d+\. /.test(line)) return `<span class="md-list">${_esc(line)}</span>`
  if (/^```/.test(line)) return `<span class="md-fence">${_esc(line)}</span>`

  let highlighted = _esc(line)
  highlighted = highlighted.replace(/\*\*(.+?)\*\*/g, '<span class="md-strong">**$1**</span>')
  highlighted = highlighted.replace(/\*(.+?)\*/g, '<span class="md-em">*$1*</span>')
  highlighted = highlighted.replace(/`(.+?)`/g, '<span class="md-code">`$1`</span>')
  highlighted = highlighted.replace(/\[(.+?)\]\((.+?)\)/g, '<span class="md-link">[$1]($2)</span>')
  return highlighted
}

function _updateHighlight(text) {
  const hlEl = document.getElementById('md-highlight')
  if (!hlEl) return
  hlEl.innerHTML = normalizeMarkdownText(text).split('\n').map(_highlightLine).join('\n')
  const srcEl = document.getElementById('md-source-input')
  if (srcEl) hlEl.scrollTop = srcEl.scrollTop
}
