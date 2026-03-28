import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { history, undo, redo } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import {
  baseKeymap, toggleMark, setBlockType, wrapIn, lift, chainCommands, selectAll
} from 'prosemirror-commands'
import { wrapInList, liftListItem, sinkListItem, splitListItem } from 'prosemirror-schema-list'
import { DOMSerializer } from 'prosemirror-model'
import {
  addColumnAfter, addColumnBefore, deleteColumn,
  addRowAfter, addRowBefore, deleteRow,
  mergeCells, splitCell, toggleHeaderRow,
  goToNextCell, tableEditing
} from 'prosemirror-tables'
import { invoke } from './bridge.js'

import { schema, tableEditing as schemaTableEditing } from './schema.js'
import { findPlugin, findKey, findSearch, findNext, findPrev, findClear, getFindState, replaceNext, replaceAll } from './find.js'
import { initUI, updateDocStats, updateKeystrokeCount, setSaveStatus } from './ui.js'
import { vim } from './vim.js'
import { initMarkdown, toggleMarkdownMode, serializeToMarkdown, parseFromMarkdown, isMarkdownMode } from './markdown.js'
import { inputRules, InputRule } from 'prosemirror-inputrules'
import { makeTypographyPlugin } from './typography.js'
import { fleschKincaid } from './readability.js'

// ── Shared editor view reference ────────────────────────────────────────────
let view

// ── Document history for proof replay ────────────────────────────────────────
const _docHistory = []  // [{t: ms, text: string}]
let _lastHistoryText = ''

// ── Typography enabled flag ───────────────────────────────────────────────
let _typographyEnabled = true
let _currentTypoPlugin = null

// ── Task item NodeView ────────────────────────────────────────────────────
class TaskItemView {
  constructor(node, view, getPos) {
    this.dom = document.createElement('li')
    this.dom.setAttribute('data-task-item', '')
    if (node.attrs.checked) this.dom.setAttribute('data-checked', '')

    this.checkbox = document.createElement('input')
    this.checkbox.type = 'checkbox'
    this.checkbox.checked = node.attrs.checked
    this.checkbox.contentEditable = 'false'
    this.checkbox.addEventListener('mousedown', e => {
      e.preventDefault()
      view.dispatch(view.state.tr.setNodeMarkup(
        getPos(), null, { checked: !node.attrs.checked }
      ))
    })

    this.content = document.createElement('span')
    this.dom.appendChild(this.checkbox)
    this.dom.appendChild(this.content)
    this.contentDOM = this.content
  }

  update(node) {
    if (node.type.name !== 'task_item') return false
    this.checkbox.checked = node.attrs.checked
    if (node.attrs.checked) this.dom.setAttribute('data-checked', '')
    else this.dom.removeAttribute('data-checked')
    return true
  }
}

// ── Mark helpers ─────────────────────────────────────────────────────────────

function isMarkActive(state, markType) {
  const { from, $from, to, empty } = state.selection
  if (empty) {
    return !!(state.storedMarks ?? $from.marks()).find(m => m.type === markType)
  }
  let found = false
  state.doc.nodesBetween(from, to, node => {
    if (!found && node.isInline && node.marks.some(m => m.type === markType)) found = true
  })
  return found
}

function getMarkAttr(state, markType, attr) {
  const { from, $from, to, empty } = state.selection
  if (empty) {
    const m = (state.storedMarks ?? $from.marks()).find(m => m.type === markType)
    return m ? m.attrs[attr] : null
  }
  let val = null
  state.doc.nodesBetween(from, to, node => {
    if (val !== null) return
    const m = node.marks.find(m => m.type === markType)
    if (m) val = m.attrs[attr]
  })
  return val
}

function applyMark(markType, attrs) {
  return (state, dispatch) => {
    const { from, to } = state.selection
    if (from === to) return false
    if (dispatch) dispatch(state.tr.addMark(from, to, markType.create(attrs)))
    return true
  }
}

function clearAllMarks(state, dispatch) {
  const { from, to } = state.selection
  if (from === to) return false
  if (dispatch) {
    let tr = state.tr
    for (const mt of Object.values(schema.marks)) tr = tr.removeMark(from, to, mt)
    dispatch(tr)
  }
  return true
}

// ── Block / alignment helpers ─────────────────────────────────────────────────

function getBlockInfo(state) {
  const { $from } = state.selection
  const node = $from.node($from.depth)
  return node ? { type: node.type, attrs: node.attrs } : null
}

function setAlignment(align) {
  return (state, dispatch) => {
    const { from, to } = state.selection
    let tr = state.tr
    let changed = false
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (node.isBlock && node.type.spec.attrs && 'align' in node.type.spec.attrs) {
        const newAlign = (align === 'left') ? null : align
        if (node.attrs.align !== newAlign) {
          tr = tr.setNodeMarkup(pos, null, { ...node.attrs, align: newAlign })
          changed = true
        }
      }
    })
    if (!changed) return false
    if (dispatch) dispatch(tr)
    return true
  }
}

// ── Line height ──────────────────────────────────────────────────────────────

function setLineHeight(value) {
  const { from, to } = view.state.selection
  let tr = view.state.tr
  let changed = false
  view.state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type === schema.nodes.paragraph) {
      const newLH = value || null
      if (node.attrs.lineHeight !== newLH) {
        tr = tr.setNodeMarkup(pos, null, { ...node.attrs, lineHeight: newLH })
        changed = true
      }
    }
  })
  if (changed) {
    view.dispatch(tr)
    view.focus()
  }
}

// ── Paragraph spacing ────────────────────────────────────────────────────────

function setParagraphSpacing(attr, value) {
  const { from, to } = view.state.selection
  let tr = view.state.tr
  let changed = false
  view.state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type === schema.nodes.paragraph) {
      const newVal = parseFloat(value) || 0
      if (node.attrs[attr] !== newVal) {
        tr = tr.setNodeMarkup(pos, null, { ...node.attrs, [attr]: newVal })
        changed = true
      }
    }
  })
  if (changed) { view.dispatch(tr); view.focus() }
}

// ── Footnotes ─────────────────────────────────────────────────────────────────

function insertFootnote() {
  if (!schema.nodes.footnote_mark) return
  const doc = view.state.doc
  let n = 1
  doc.descendants(node => { if (node.type === schema.nodes.footnote_mark) n++ })

  const mark = schema.nodes.footnote_mark.create({ number: n })
  const { from } = view.state.selection
  const def = schema.nodes.footnote_def.createAndFill({ number: n })

  let tr = view.state.tr.insert(from, mark)
  // Insert def at end of doc (before closing doc node)
  const defInsertPos = tr.doc.content.size
  tr = tr.insert(defInsertPos, def)
  // Move cursor inside the def
  const defPos = defInsertPos + 1
  tr = tr.setSelection(TextSelection.create(tr.doc, Math.min(defPos, tr.doc.content.size - 1)))
  view.dispatch(tr)
  view.focus()
}

// ── Column layout ─────────────────────────────────────────────────────────────

function wrapInColumns() {
  const { $from } = view.state.selection
  const nodePos = $from.before($from.depth)
  const node = $from.node($from.depth)
  const para = schema.nodes.paragraph.createAndFill()
  const col1 = schema.nodes.column.createAndFill(null, node.copy(node.content))
  const col2 = schema.nodes.column.createAndFill(null, [para])
  const block = schema.nodes.column_block.create(null, [col1, col2])
  view.dispatch(view.state.tr.replaceWith(nodePos, nodePos + node.nodeSize, block))
  view.focus()
}

function unwrapColumns() {
  const { $from } = view.state.selection
  let depth = $from.depth
  while (depth > 0 && $from.node(depth).type !== schema.nodes.column_block) depth--
  if (depth === 0) return
  const blockPos = $from.before(depth)
  const block = $from.node(depth)
  const content = []
  block.forEach(col => col.forEach(n => content.push(n)))
  view.dispatch(view.state.tr.replaceWith(blockPos, blockPos + block.nodeSize, content))
  view.focus()
}

// ── Table helpers ─────────────────────────────────────────────────────────────

function insertTable(rows = 3, cols = 3) {
  const { $from } = view.state.selection
  const tableType = schema.nodes.table
  const rowType = schema.nodes.table_row
  const cellType = schema.nodes.table_cell

  if (!tableType || !rowType || !cellType) return

  const cells = []
  for (let c = 0; c < cols; c++) {
    cells.push(cellType.createAndFill())
  }
  const tableRows = []
  for (let r = 0; r < rows; r++) {
    tableRows.push(rowType.create(null, cells.map(c => c.copy(c.content))))
  }
  const table = tableType.create(null, tableRows)
  const insertPos = $from.after($from.depth)
  view.dispatch(view.state.tr.insert(insertPos, table))
  view.focus()
}

// ── Page break ───────────────────────────────────────────────────────────────

function insertPageBreak() {
  if (!schema.nodes.page_break) return
  const { $from } = view.state.selection
  const insertPos = $from.after($from.depth)
  view.dispatch(view.state.tr.insert(insertPos, schema.nodes.page_break.create()))
  view.focus()
}

// ── Focus mode ───────────────────────────────────────────────────────────────

function toggleFocusMode() {
  document.body.classList.toggle('focus-mode')
}

// ── Outline ──────────────────────────────────────────────────────────────────

function buildOutline() {
  if (!view) return []
  const headings = []
  view.state.doc.descendants((node, pos) => {
    if (node.type === schema.nodes.heading) {
      headings.push({ level: node.attrs.level, text: node.textContent, pos })
    }
  })
  return headings
}

function updateOutline() {
  const panel = el('outline-content')
  if (!panel) return
  const headings = buildOutline()
  panel.innerHTML = ''
  if (!headings.length) {
    panel.innerHTML = '<div class="outline-empty">No headings</div>'
    return
  }
  headings.forEach(h => {
    const item = document.createElement('div')
    item.className = `outline-item outline-h${h.level}`
    item.textContent = h.text || '(empty heading)'
    item.style.paddingLeft = `${(h.level - 1) * 12 + 8}px`
    item.addEventListener('click', () => {
      if (!view) return
      const $pos = view.state.doc.resolve(Math.min(h.pos + 1, view.state.doc.content.size))
      view.dispatch(view.state.tr.setSelection(TextSelection.near($pos)).scrollIntoView())
      view.focus()
    })
    panel.appendChild(item)
  })
}

function setupOutlinePanel() {
  const btn = el('btn-outline')
  if (btn) {
    btn.addEventListener('click', () => {
      const panel = el('outline-panel')
      if (panel) {
        const visible = panel.style.display !== 'none' && panel.style.display !== ''
        panel.style.display = visible ? 'none' : 'flex'
        updateOutline()
      }
    })
  }
}

// ── Typing speed tracker ─────────────────────────────────────────────────────

const _keyTimestamps = []

function trackKeystroke() {
  const now = Date.now()
  _keyTimestamps.push(now)
  // Purge keystrokes older than 60s
  const cutoff = now - 60_000
  while (_keyTimestamps.length && _keyTimestamps[0] < cutoff) _keyTimestamps.shift()
  updateTypingSpeed()
}

function updateTypingSpeed() {
  const span = el('typing-speed')
  if (!span) return
  // WPM = keystrokes in last 60s / 5 (avg chars/word) / 1 minute
  const wpm = Math.round(_keyTimestamps.length / 5)
  span.textContent = `${wpm} wpm`
}

// ── Word count detail ────────────────────────────────────────────────────────

function updateWordCountDetail(docText) {
  const detail = el('word-count-detail')
  if (!detail) return
  const words = docText.trim() ? docText.trim().split(/\s+/).length : 0
  const chars = docText.length
  const sentences = docText.split(/[.!?]+/).filter(s => s.trim()).length
  detail.textContent = `${words} words · ${chars} chars · ${sentences} sentences`
}

// ── InputRules ────────────────────────────────────────────────────────────

function makeEditorInputRules() {
  return inputRules({
    rules: [
      // ``` at start of line → code block
      new InputRule(/^```$/, (state, match, start, end) => {
        if (state.selection.$from.parent.type !== schema.nodes.paragraph) return null
        return state.tr.replaceWith(
          state.selection.$from.before(),
          state.selection.$from.after(),
          schema.nodes.code_block.createAndFill()
        )
      }),
    ]
  })
}

// ── Keyboard map ────────────────────────────────────────────────────────────

const wordKeymap = keymap({
  'Mod-b': toggleMark(schema.marks.strong),
  'Mod-i': toggleMark(schema.marks.em),
  'Mod-u': toggleMark(schema.marks.underline),
  'Mod-z': undo,
  'Mod-y': redo,
  'Mod-Shift-z': redo,
  'Mod-l': setAlignment('left'),
  'Mod-e': setAlignment('center'),
  'Mod-r': setAlignment('right'),
  'Mod-j': setAlignment('justify'),
  'Mod-f': () => { openFind(); return true },
  'Mod-g': () => { findNext(view); updateFindCount(); return true },
  'Mod-Shift-g': () => { findPrev(view); updateFindCount(); return true },
  'Mod-a': selectAll,
  'Mod-Shift-,': toggleMark(schema.marks.subscript),
  'Mod-Shift-.': toggleMark(schema.marks.superscript),
  'Tab': chainCommands(
    goToNextCell(1),
    sinkListItem(schema.nodes.list_item),
    (state, dispatch) => { if (dispatch) dispatch(state.tr.insertText('\t')); return true }
  ),
  'Shift-Tab': chainCommands(
    goToNextCell(-1),
    liftListItem(schema.nodes.list_item)
  ),
  'Enter': chainCommands(
    splitListItem(schema.nodes.list_item),
    baseKeymap['Enter']
  ),
  'Mod-Enter': () => { insertPageBreak(); return true },
  'Mod-Shift-f': () => { insertFootnote(); return true },
  'Mod-Shift-t': () => { insertTable(3, 3); return true },
  'Mod-Shift-2': () => { wrapInColumns(); return true },
  'Mod-Shift-1': () => { unwrapColumns(); return true },
  'Mod-[': () => {
    const cur = currentFontSize()
    const prev = [...FONT_SIZES].reverse().find(n => n < cur) ?? FONT_SIZES[0]
    applyFontSize(prev)
    return true
  },
  'Mod-]': () => {
    const cur = currentFontSize()
    const next = FONT_SIZES.find(n => n > cur) ?? FONT_SIZES[FONT_SIZES.length - 1]
    applyFontSize(next)
    return true
  },
  'Mod-k': () => {
    const url = prompt('Insert link URL:')
    if (url) {
      const { from, to } = view.state.selection
      if (from !== to) {
        view.dispatch(view.state.tr.addMark(from, to, schema.marks.link.create({ href: url, title: null })))
      }
    }
    return true
  },
  'Mod-\\': clearAllMarks,
  'Mod-Shift-k': (state, dispatch) => {
    const { $from } = state.selection
    const node = $from.node($from.depth)
    if (node.type === schema.nodes.code_block) {
      if (dispatch) dispatch(state.tr.setBlockType($from.before(), $from.after(), schema.nodes.paragraph))
      return true
    }
    if (dispatch) dispatch(state.tr.setBlockType($from.before(), $from.after(), schema.nodes.code_block))
    return true
  },
  'Escape': (state, dispatch) => {
    if (state.selection.$from.parent.type === schema.nodes.code_block) {
      if (dispatch) dispatch(state.tr.setBlockType(
        state.selection.from, state.selection.to, schema.nodes.paragraph
      ))
      return true
    }
    return false
  },
  'Mod-Shift-9': (state, dispatch) => {
    const { $from } = state.selection
    const inTaskList = $from.depth > 1 && $from.node($from.depth - 1).type === schema.nodes.task_item
    if (inTaskList) {
      if (dispatch) dispatch(state.tr.lift(state.selection, $from.depth - 1))
      return true
    }
    if (dispatch) {
      const item = schema.nodes.task_item.createAndFill()
      const list = schema.nodes.task_list.create(null, item)
      const pos = $from.before($from.depth)
      dispatch(state.tr.replaceWith(pos, pos + $from.parent.nodeSize, list))
    }
    return true
  },
})

// ── Focus-loss tracking ──────────────────────────────────────────────────────

let _focusLostAt = null

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    _focusLostAt = Date.now()
  } else if (_focusLostAt !== null) {
    const duration_ms = Date.now() - _focusLostAt
    _focusLostAt = null
    invoke('log_focus_loss_event', { duration_ms }).catch(console.error)
  }
})
window.addEventListener('blur', () => { if (_focusLostAt === null) _focusLostAt = Date.now() })
window.addEventListener('focus', () => {
  if (_focusLostAt !== null) {
    const duration_ms = Date.now() - _focusLostAt
    _focusLostAt = null
    invoke('log_focus_loss_event', { duration_ms }).catch(console.error)
  }
})

// ── Editor init ──────────────────────────────────────────────────────────────

function buildEditor(editable = true) {
  _currentTypoPlugin = _typographyEnabled ? makeTypographyPlugin() : inputRules({ rules: [] })
  const state = EditorState.create({
    schema,
    plugins: [history(), wordKeymap, keymap(baseKeymap), findPlugin, tableEditing(), makeEditorInputRules(), _currentTypoPlugin],
  })

  view = new EditorView(document.getElementById('editor'), {
    state,
    editable: () => editable,
    nodeViews: {
      task_item: (node, view, getPos) => new TaskItemView(node, view, getPos),
    },
    // Disable macOS autocorrect/autocapitalize — they fire NSCorrectionPanel events
    // that conflict with our keyboard filter and move the cursor unexpectedly.
    attributes: { autocorrect: 'off', autocapitalize: 'off', spellcheck: 'true' },
    dispatchTransaction(tr) {
      const next = view.state.apply(tr)
      view.updateState(next)
      if (tr.docChanged) {
        updateDocStats(next.doc.textContent)
        updateWordCountDetail(next.doc.textContent)
        updateOutline()
        const text = next.doc.textContent
        if (text !== _lastHistoryText) {
          _docHistory.push({ t: Date.now(), text })
          _lastHistoryText = text
        }
      }
      syncToolbar(next)
    },
    handleDOMEvents: {
      keydown(editorView, event) {
        if (vim.handleKeydown(editorView, event)) return true
        // Keyboard gating: we can't synchronously block, but we track for session.
        // Actual filtering is done at the HID level via pending_builtin_keydowns.
        trackKeystroke()
        return false // let ProseMirror handle, filtering done at HID level
      },
      // Allow paste but log a SHA-256 hash of the clipboard content so verifiers
      // can detect if pasted material appears in the final document.
      paste(_view, event) {
        const text = event.clipboardData?.getData('text/plain') || ''
        if (text.length > 0) {
          const encoded = new TextEncoder().encode(text)
          crypto.subtle.digest('SHA-256', encoded).then(buf => {
            const hash = Array.from(new Uint8Array(buf))
              .map(b => b.toString(16).padStart(2, '0'))
              .join('')
            invoke('log_paste_event', { char_count: text.length, content_hash: hash })
              .catch(console.error)
          })
        }
        return false // let ProseMirror insert the content normally
      },
      // Block drag & drop
      drop(_view, event) {
        event.preventDefault()
        return true
      },
      dragover(_view, event) {
        event.preventDefault()
        return true
      },
      // Block non-keyboard beforeinput types (drop, dictation replacement, autocorrect).
      // insertFromPaste is allowed so the pasted content actually enters the document;
      // the paste handler above already logged the clipboard hash for attestation.
      beforeinput(_view, event) {
        const blocked = new Set([
          'insertFromPasteAsQuotation',
          'insertFromDrop', 'insertFromYank',
          'insertReplacementText', 'insertTranspose',
        ])
        if (blocked.has(event.inputType)) {
          event.preventDefault()
          return true
        }
        return false
      },
    },
  })

  return view
}

// ── Toolbar state sync ───────────────────────────────────────────────────────

function syncToolbar(state) {
  // Marks
  setActive('btn-bold',      isMarkActive(state, schema.marks.strong))
  setActive('btn-italic',    isMarkActive(state, schema.marks.em))
  setActive('btn-underline', isMarkActive(state, schema.marks.underline))
  setActive('btn-strike',      isMarkActive(state, schema.marks.strikethrough))
  setActive('btn-subscript',   isMarkActive(state, schema.marks.subscript))
  setActive('btn-superscript', isMarkActive(state, schema.marks.superscript))

  // Paragraph style
  const block = getBlockInfo(state)
  const styleEl = el('style-select')
  if (styleEl && block) {
    styleEl.value = block.type === schema.nodes.heading ? `h${block.attrs.level}` : block.type.name
  }

  // Alignment
  const align = block?.attrs?.align || 'left'
  ;['left', 'center', 'right', 'justify'].forEach(a => {
    setActive(`btn-align-${a}`, a === align || (a === 'left' && !block?.attrs?.align))
  })

  // Font family
  const family = getMarkAttr(state, schema.marks.fontFamily, 'family')
  if (family) { const e = el('font-family-select'); if (e) e.value = family }

  // Font size
  const size = getMarkAttr(state, schema.marks.fontSize, 'size')
  if (size) { const e = el('font-size-select'); if (e) e.value = parseInt(size) || 12 }

  // Color swatch
  const color = getMarkAttr(state, schema.marks.textColor, 'color')
  const swatch = el('color-swatch')
  if (swatch) swatch.style.background = color || '#000000'

  // Code block
  const inCodeBlock = state.selection.$from.parent.type === schema.nodes.code_block
  setActive('btn-code-block', inCodeBlock)

  // Paragraph spacing
  const paraNode = state.selection.$from.node(state.selection.$from.depth)
  if (paraNode && paraNode.type === schema.nodes.paragraph) {
    const sb = el('space-before-select'); if (sb) sb.value = String(paraNode.attrs.spaceBefore || 0)
    const sa = el('space-after-select'); if (sa) sa.value = String(paraNode.attrs.spaceAfter || 0)
  }

  // Table toolbar visibility
  updateTableToolbar(state)
}

function updateTableToolbar(state) {
  const tt = el('table-toolbar')
  if (!tt) return
  // Check if cursor is inside a table cell
  const { $from } = state.selection
  let inTable = false
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d)
    if (node.type === schema.nodes.table) { inTable = true; break }
  }
  tt.style.display = inTable ? 'flex' : 'none'
}

function setActive(id, on) { el(id)?.classList.toggle('active', on) }
function el(id) { return document.getElementById(id) }
function on(id, fn) { el(id)?.addEventListener('click', fn) }

// ── Toolbar wiring ───────────────────────────────────────────────────────────

function wireToolbar() {
  on('btn-undo',  () => { undo(view.state, view.dispatch);  view.focus() })
  on('btn-redo',  () => { redo(view.state, view.dispatch);  view.focus() })

  on('btn-bold',      () => { toggleMark(schema.marks.strong)(view.state, view.dispatch);        view.focus() })
  on('btn-italic',    () => { toggleMark(schema.marks.em)(view.state, view.dispatch);             view.focus() })
  on('btn-underline', () => { toggleMark(schema.marks.underline)(view.state, view.dispatch);      view.focus() })
  on('btn-strike',      () => { toggleMark(schema.marks.strikethrough)(view.state, view.dispatch); view.focus() })
  on('btn-subscript',   () => { toggleMark(schema.marks.subscript)(view.state, view.dispatch);    view.focus() })
  on('btn-superscript', () => { toggleMark(schema.marks.superscript)(view.state, view.dispatch);  view.focus() })
  on('btn-clear-format', () => { clearAllMarks(view.state, view.dispatch); view.focus() })

  ;['left', 'center', 'right', 'justify'].forEach(a => {
    on(`btn-align-${a}`, () => { setAlignment(a)(view.state, view.dispatch); view.focus() })
  })

  // Lists
  on('btn-bullet-list', () => {
    if (!wrapInList(schema.nodes.bullet_list)(view.state, view.dispatch)) lift(view.state, view.dispatch)
    view.focus()
  })
  on('btn-ordered-list', () => {
    if (!wrapInList(schema.nodes.ordered_list)(view.state, view.dispatch)) lift(view.state, view.dispatch)
    view.focus()
  })
  on('btn-indent',  () => { sinkListItem(schema.nodes.list_item)(view.state, view.dispatch); view.focus() })
  on('btn-outdent', () => { liftListItem(schema.nodes.list_item)(view.state, view.dispatch); view.focus() })

  // Blockquote
  on('btn-blockquote', () => {
    if (!wrapIn(schema.nodes.blockquote)(view.state, view.dispatch)) lift(view.state, view.dispatch)
    view.focus()
  })

  // Horizontal rule
  on('btn-hr', () => {
    const { $from } = view.state.selection
    const end = $from.after($from.depth)
    view.dispatch(view.state.tr.insert(end, schema.nodes.horizontal_rule.create()))
    view.focus()
  })

  // Style dropdown
  el('style-select')?.addEventListener('change', e => {
    const v = e.target.value
    if (v === 'paragraph') {
      setBlockType(schema.nodes.paragraph)(view.state, view.dispatch)
    } else if (v.startsWith('h')) {
      setBlockType(schema.nodes.heading, { level: parseInt(v[1]) })(view.state, view.dispatch)
    }
    view.focus()
  })

  // Font family
  el('font-family-select')?.addEventListener('change', e => {
    const { from, to } = view.state.selection
    if (from === to) { view.focus(); return }
    view.dispatch(view.state.tr.addMark(from, to, schema.marks.fontFamily.create({ family: e.target.value })))
    view.focus()
  })

  // Font size
  el('font-size-select')?.addEventListener('change', e => {
    const { from, to } = view.state.selection
    if (from === to) { view.focus(); return }
    view.dispatch(view.state.tr.addMark(from, to, schema.marks.fontSize.create({ size: `${e.target.value}pt` })))
    view.focus()
  })

  // Text color
  const colorPicker = el('color-picker')
  on('btn-color', () => colorPicker?.click())
  colorPicker?.addEventListener('input', e => {
    const { from, to } = view.state.selection
    if (from === to) return
    view.dispatch(view.state.tr.addMark(from, to, schema.marks.textColor.create({ color: e.target.value })))
    const sw = el('color-swatch'); if (sw) sw.style.background = e.target.value
  })
  colorPicker?.addEventListener('change', () => view.focus())

  // Highlight
  const hlPicker = el('highlight-picker')
  on('btn-highlight', () => hlPicker?.click())
  hlPicker?.addEventListener('input', e => {
    const { from, to } = view.state.selection
    if (from === to) return
    view.dispatch(view.state.tr.addMark(from, to, schema.marks.highlight.create({ color: e.target.value })))
  })
  hlPicker?.addEventListener('change', () => view.focus())

  // Find
  on('btn-find', openFind)
  on('find-close', closeFind)
  on('btn-find-next', () => { findNext(view); updateFindCount() })
  on('btn-find-prev', () => { findPrev(view); updateFindCount() })

  el('find-input')?.addEventListener('input', e => {
    findSearch(view, e.target.value)
    updateFindCount()
  })
  el('find-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.shiftKey ? findPrev(view) : findNext(view); updateFindCount() }
    if (e.key === 'Escape') closeFind()
  })

  // Replace
  on('btn-replace-one', () => {
    const repl = el('replace-input')?.value ?? ''
    replaceNext(view, repl)
    updateFindCount()
  })
  on('btn-replace-all', () => {
    const repl = el('replace-input')?.value ?? ''
    replaceAll(view, repl)
    updateFindCount()
  })

  // Dark mode
  on('btn-dark', () => document.body.classList.toggle('dark'))

  // Export
  on('btn-export-title', handleExport)

  // New toolbar row buttons
  on('btn-insert-table', () => { insertTable(3, 3); view.focus() })
  on('btn-page-break',   () => { insertPageBreak(); view.focus() })
  on('btn-focus-mode',   () => { toggleFocusMode() })
  on('btn-fullscreen',   () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen()
    else document.exitFullscreen()
  })

  // Line height select
  el('line-height-select')?.addEventListener('change', e => {
    setLineHeight(e.target.value)
  })

  // Paragraph spacing
  el('space-before-select')?.addEventListener('change', e => {
    setParagraphSpacing('spaceBefore', e.target.value)
  })
  el('space-after-select')?.addEventListener('change', e => {
    setParagraphSpacing('spaceAfter', e.target.value)
  })

  // Footnote
  on('btn-footnote', () => insertFootnote())

  // Columns
  on('btn-2col', () => wrapInColumns())
  on('btn-1col', () => unwrapColumns())

  // Table toolbar buttons
  on('btn-table-add-row', () => { addRowAfter(view.state, view.dispatch); view.focus() })
  on('btn-table-add-col', () => { addColumnAfter(view.state, view.dispatch); view.focus() })
  on('btn-table-del-row', () => { deleteRow(view.state, view.dispatch); view.focus() })
  on('btn-table-del-col', () => { deleteColumn(view.state, view.dispatch); view.focus() })
  on('btn-table-merge',   () => { mergeCells(view.state, view.dispatch); view.focus() })
  on('btn-table-split',   () => { splitCell(view.state, view.dispatch); view.focus() })

  // Outline
  setupOutlinePanel()

  // Vim mode
  on('btn-vim', () => { if (vim.isEnabled()) vim.disable(); else vim.enable(view) })

  // Markdown mode
  on('btn-markdown', () => {
    toggleMarkdownMode()
    if (isMarkdownMode()) {
      const md = serializeToMarkdown(view.state)
      const ta = document.getElementById('markdown-source')
      if (ta) { ta.value = md; ta.style.display = 'flex' }
      document.getElementById('editor').style.display = 'none'
      document.getElementById('page').style.padding = '0'
    } else {
      const ta = document.getElementById('markdown-source')
      if (ta) {
        const doc = parseFromMarkdown(ta.value, schema)
        if (doc) {
          const end = view.state.doc.content.size
          view.dispatch(view.state.tr.replaceWith(0, end, doc.content))
        }
        ta.style.display = 'none'
      }
      document.getElementById('editor').style.display = ''
      document.getElementById('page').style.padding = ''
      view.focus()
    }
  })

  // Upload proof
  on('btn-upload-proof', handleUploadProof)

  // Code block
  on('btn-code-block', () => {
    const { $from } = view.state.selection
    const node = $from.node($from.depth)
    if (node.type === schema.nodes.code_block) {
      view.dispatch(view.state.tr.setBlockType($from.before(), $from.after(), schema.nodes.paragraph))
    } else {
      view.dispatch(view.state.tr.setBlockType($from.before(), $from.after(), schema.nodes.code_block))
    }
    view.focus()
  })

  // Task list
  on('btn-task-list', () => {
    const state = view.state
    const { $from } = state.selection
    const item = schema.nodes.task_item.createAndFill()
    const list = schema.nodes.task_list.create(null, item)
    const pos = $from.before($from.depth)
    view.dispatch(state.tr.replaceWith(pos, pos + $from.parent.nodeSize, list))
    view.focus()
  })
}

// ── Find ─────────────────────────────────────────────────────────────────────

function openFind() {
  el('find-bar')?.classList.add('visible')
  const input = el('find-input')
  input?.focus(); input?.select()
}

function closeFind() {
  el('find-bar')?.classList.remove('visible')
  findClear(view)
  el('find-count').textContent = ''
  view.focus()
}

function updateFindCount() {
  const s = getFindState(view)
  const c = el('find-count')
  if (!c) return
  c.textContent = s.matches.length
    ? `${s.index + 1} of ${s.matches.length}`
    : s.query ? 'Not found' : ''
}

// ── Auto-save + poller ───────────────────────────────────────────────────────

function startAutosave() {
  setInterval(async () => {
    try {
      await invoke('save_session')
      setSaveStatus(`Saved ${new Date().toLocaleTimeString()}`)
    } catch {
      setSaveStatus('Save failed')
    }
  }, 30_000)
}

function startKeystrokePoller() {
  setInterval(async () => {
    try { updateKeystrokeCount(await invoke('get_keystroke_count')) } catch {}
  }, 2_000)
}

// ── Export ───────────────────────────────────────────────────────────────────

async function handleExport() {
  const docText = view.state.doc.textContent
  const tmp = document.createElement('div')
  const serializer = DOMSerializer.fromSchema(schema)
  tmp.appendChild(serializer.serializeFragment(view.state.doc.content))
  const docHtml = tmp.innerHTML

  try {
    const b64 = await invoke('export_bundle', { doc_text: docText, doc_html: docHtml })
    if (!b64) { alert('Export produced empty bundle'); return }
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }))
    Object.assign(document.createElement('a'), { href: url, download: 'humanproof-session.zip' }).click()
    URL.revokeObjectURL(url)
  } catch (e) {
    alert(`Export failed: ${e}`)
  }
}

// ── Upload Proof ─────────────────────────────────────────────────────────────

async function handleUploadProof() {
  try {
    setSaveStatus('Uploading proof...')
    const docText = view.state.doc.textContent
    const tmp = document.createElement('div')
    const serializer = DOMSerializer.fromSchema(schema)
    tmp.appendChild(serializer.serializeFragment(view.state.doc.content))
    const docHtml = tmp.innerHTML
    const docHistory = window.__getDocHistory ? window.__getDocHistory() : []
    const url = await invoke('upload_proof', { doc_text: docText, doc_html: docHtml, doc_history: docHistory })
    setSaveStatus('Proof uploaded!')
    showProofUrl(url)
  } catch (e) {
    setSaveStatus('Upload failed')
    alert(`Proof upload failed: ${e}`)
  }
}

function showProofUrl(url) {
  const existing = document.getElementById('proof-url-overlay')
  if (existing) existing.remove()
  const overlay = document.createElement('div')
  overlay.id = 'proof-url-overlay'
  overlay.innerHTML = `
    <div class="proof-url-box">
      <div class="proof-url-title">Proof Published</div>
      <div class="proof-url-desc">Share this link to let anyone verify your writing:</div>
      <div class="proof-url-link">
        <input type="text" value="${url}" readonly id="proof-url-input" />
        <button id="btn-copy-proof-url">Copy</button>
      </div>
      <button id="btn-close-proof-url">Close</button>
    </div>
  `
  document.body.appendChild(overlay)
  document.getElementById('btn-copy-proof-url').onclick = () => {
    navigator.clipboard.writeText(url).catch(() => {
      document.getElementById('proof-url-input').select()
      document.execCommand('copy')
    })
    document.getElementById('btn-copy-proof-url').textContent = 'Copied!'
  }
  document.getElementById('btn-close-proof-url').onclick = () => overlay.remove()
}

// ── Click-to-place cursor ─────────────────────────────────────────────────
// When the user clicks on blank space (below content, right of a short line,
// on the page margins), find the nearest document position and place the
// cursor there — just like Word.

function setupClickToPlace() {
  document.getElementById('page-area').addEventListener('mousedown', e => {
    if (!view || e.button !== 0) return
    // If the click landed inside the ProseMirror DOM, let it handle normally.
    if (view.dom.contains(e.target)) return

    e.preventDefault()
    // Clamp click to within the editor bounding box so posAtCoords finds the
    // nearest line/column rather than returning null outside the content area.
    // Clicking below the last line uses the click's x to pick the column.
    const rect = view.dom.getBoundingClientRect()
    const x = Math.max(rect.left + 1, Math.min(rect.right  - 1, e.clientX))
    const y = Math.max(rect.top  + 1, Math.min(rect.bottom - 1, e.clientY))
    const pos = view.posAtCoords({ left: x, top: y })
    const docEnd = view.state.doc.content.size
    const targetPos = pos ? Math.min(pos.pos, docEnd) : docEnd
    const $pos = view.state.doc.resolve(targetPos)
    view.dispatch(view.state.tr.setSelection(TextSelection.near($pos)))
    view.focus()
  })
}

// ── HID gate ─────────────────────────────────────────────────────────────────

function showHidBlocked() {
  const overlay = document.createElement('div')
  overlay.id = 'hid-blocked'
  overlay.innerHTML = `
    <div class="hid-blocked-box">
      <div class="hid-blocked-icon">&#128274;</div>
      <h2>Input Monitoring Required</h2>
      <p>HumanProof only accepts keystrokes via its secure hardware input capture layer.</p>
      <p>Grant access, then quit and relaunch the app.</p>
      <button id="btn-open-privacy">Open Privacy Settings</button>
    </div>
  `
  document.body.appendChild(overlay)
  document.getElementById('btn-open-privacy').addEventListener('click', () => {
    invoke('open_input_monitoring_settings').catch(console.error)
  })
}

async function boot() {
  initUI()
  let hidOk = false
  try { hidOk = await invoke('get_hid_status') } catch {}

  if (!hidOk) {
    buildEditor(false)
    wireToolbar()
    showHidBlocked()

    function unlockEditor() {
      document.getElementById('hid-blocked')?.remove()
      view.setProps({ editable: () => true })
      startAutosave()
      startKeystrokePoller()
    }

    // Push notification from Swift when HID becomes active
    window.__hidBecameActive = () => { clearInterval(poll); unlockEditor() }

    // Push notification from Swift when Karabiner-Elements is detected
    window.__karabinerDetected = () => {
      const existing = document.getElementById('__karabiner-warning')
      if (existing) return
      const banner = document.createElement('div')
      banner.id = '__karabiner-warning'
      banner.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:#7c3aed;color:#fff;padding:10px 18px;border-radius:8px;font-size:13px;z-index:9999;max-width:480px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,0.3)'
      banner.textContent = 'Karabiner-Elements detected. Add HumanProof to its Excluded Applications list (Karabiner-Elements → Misc → Excluded applications) for keyboard input to work.'
      document.body.appendChild(banner)
    }

    // Poll every 2s as fallback
    const poll = setInterval(async () => {
      try {
        const ok = await invoke('get_hid_status')
        if (ok) { clearInterval(poll); unlockEditor() }
      } catch {}
    }, 2000)
    return
  }

  buildEditor(true)
  wireToolbar()
  setupClickToPlace()
  setupMenuCmd()
  startAutosave()
  startKeystrokePoller()
}

// ── Native menu command dispatcher ───────────────────────────────────────────
// Called by AppMenu.swift via evaluateJavaScript("window.__menuCmd('...')")

const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72]

function currentFontSize() {
  const raw = getMarkAttr(view.state, schema.marks.fontSize, 'size')
  return raw ? (parseInt(raw) || 12) : 12
}

function applyFontSize(pt) {
  const { from, to } = view.state.selection
  if (from === to) return
  view.dispatch(view.state.tr.addMark(from, to, schema.marks.fontSize.create({ size: `${pt}pt` })))
  const e = document.getElementById('font-size-select')
  if (e) e.value = pt
}

function setupMenuCmd() {
  window.__menuCmd = (cmd) => {
    if (!view) return
    const s = view.state
    const d = view.dispatch.bind(view)
    switch (cmd) {
      case 'undo':          undo(s, d); break
      case 'redo':          redo(s, d); break
      case 'bold':          toggleMark(schema.marks.strong)(s, d); break
      case 'italic':        toggleMark(schema.marks.em)(s, d); break
      case 'underline':     toggleMark(schema.marks.underline)(s, d); break
      case 'strike':        toggleMark(schema.marks.strikethrough)(s, d); break
      case 'subscript':     toggleMark(schema.marks.subscript)(s, d); break
      case 'superscript':   toggleMark(schema.marks.superscript)(s, d); break
      case 'align-left':    setAlignment('left')(s, d); break
      case 'align-center':  setAlignment('center')(s, d); break
      case 'align-right':   setAlignment('right')(s, d); break
      case 'align-justify': setAlignment('justify')(s, d); break
      case 'clear-format':  clearAllMarks(s, d); break
      case 'selectAll':     selectAll(s, d); break
      case 'find':          openFind(); return
      case 'find-next':     findNext(view); updateFindCount(); return
      case 'find-prev':     findPrev(view); updateFindCount(); return
      case 'bullet-list':
        if (!wrapInList(schema.nodes.bullet_list)(s, d)) lift(s, d); break
      case 'ordered-list':
        if (!wrapInList(schema.nodes.ordered_list)(s, d)) lift(s, d); break
      case 'indent':        sinkListItem(schema.nodes.list_item)(s, d); break
      case 'outdent':       liftListItem(schema.nodes.list_item)(s, d); break
      case 'blockquote':
        if (!wrapIn(schema.nodes.blockquote)(s, d)) lift(s, d); break
      case 'hr': {
        const { $from } = s.selection
        d(s.tr.insert($from.after($from.depth), schema.nodes.horizontal_rule.create()))
        break
      }
      case 'font-bigger': {
        const cur = currentFontSize()
        const next = FONT_SIZES.find(n => n > cur) ?? FONT_SIZES[FONT_SIZES.length - 1]
        applyFontSize(next); break
      }
      case 'font-smaller': {
        const cur = currentFontSize()
        const prev = [...FONT_SIZES].reverse().find(n => n < cur) ?? FONT_SIZES[0]
        applyFontSize(prev); break
      }
      case 'dark-mode':    document.body.classList.toggle('dark'); return
      case 'save':
        invoke('save_session')
          .then(() => setSaveStatus(`Saved ${new Date().toLocaleTimeString()}`))
          .catch(() => setSaveStatus('Save failed'))
        return
      case 'export': handleExport(); return
      case 'print':  window.print(); return
      case 'new':
        if (confirm('Start a new document? Current content will be lost.')) {
          window.location.reload()
        }
        return
      case 'insert-table':       insertTable(3, 3); break
      case 'insert-page-break':  insertPageBreak(); break
      case 'focus-mode':         toggleFocusMode(); return
      case 'vim-mode':           if (vim.isEnabled()) vim.disable(); else vim.enable(view); return
      case 'markdown':           toggleMarkdownMode(); return
      case 'upload-proof':       handleUploadProof(); return
      case 'table-add-row-after': addRowAfter(s, d); break
      case 'table-add-col-after': addColumnAfter(s, d); break
      case 'table-delete-row':    deleteRow(s, d); break
      case 'table-delete-col':    deleteColumn(s, d); break
      case 'table-merge-cells':   mergeCells(s, d); break
      case 'table-split-cell':    splitCell(s, d); break
    }
    view.focus()
  }
}

// ── Window globals for proof upload ──────────────────────────────────────────
window.__getDocHistory = () => _docHistory
window.__getDocHtml = () => {
  const tmp = document.createElement('div')
  const serializer = DOMSerializer.fromSchema(schema)
  tmp.appendChild(serializer.serializeFragment(view.state.doc.content))
  return tmp.innerHTML
}

boot()
