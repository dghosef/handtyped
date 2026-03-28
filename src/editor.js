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
import { initMarkdown, cycleMarkdownMode } from './markdown.js'
import { inputRules, InputRule } from 'prosemirror-inputrules'
import { makeTypographyPlugin } from './typography.js'
import { fleschKincaid } from './readability.js'
import { loadDocumentSnapshot, restoreDocumentSnapshot, saveDocumentSnapshot } from './storage.js'

// ── Shared editor view reference ────────────────────────────────────────────
let view

// ── Document history for proof replay ────────────────────────────────────────
const _docHistory = []  // [{t: ms, text: string}]
let _lastHistoryText = ''

// ── Typography enabled flag ───────────────────────────────────────────────
let _typographyEnabled = true
let _currentTypoPlugin = null
let _toolbarWired = false
let _shortcutEscBound = false

const HELP_TOPICS = {
  getting_started: {
    title: 'Getting Started',
    html: `
      <p>HumanProof accepts input only through its secure hardware capture layer, so the first step is making sure Input Monitoring is approved for the signed app bundle.</p>
      <ol>
        <li>Launch the app normally. In development, use <code>npm run dev:app</code>.</li>
        <li>Grant Input Monitoring when macOS asks.</li>
        <li>Write in the editor as usual. Autosave is stored encrypted on disk.</li>
        <li>Use <b>Export Bundle</b> when you want a proof package you can share or verify.</li>
      </ol>
    `,
  },
  input_monitoring: {
    title: 'Input Monitoring',
    html: `
      <p>HumanProof uses macOS Input Monitoring to read built-in keyboard events through IOHIDManager.</p>
      <ul>
        <li>Approve the signed <code>HumanProof.app</code> bundle, not an older transient dev binary.</li>
        <li>If approval seems stuck, remove stale HumanProof entries in <b>Privacy &amp; Security &gt; Input Monitoring</b>, then relaunch and grant access again.</li>
        <li>If you use Karabiner-Elements, add HumanProof to Karabiner's excluded applications list.</li>
      </ul>
    `,
    primaryLabel: 'Open Privacy Settings',
    primaryAction() {
      invoke('open_input_monitoring_settings').catch(console.error)
    },
  },
  markdown: {
    title: 'Markdown Mode',
    html: `
      <p><b>MD</b> cycles between rich text, split markdown, and source-only markdown editing.</p>
      <ul>
        <li>Split mode shows markdown source on the left and rendered preview on the right.</li>
        <li>Source mode hides the preview so you can focus on raw markdown.</li>
        <li>The preview follows strict markdown paragraph rules: one newline stays in the same paragraph, and a blank line starts a new paragraph.</li>
      </ul>
      <p>Use fenced blocks like <code>\`\`\`js</code> for code and leave a blank line between paragraphs.</p>
    `,
  },
}

function buildPlugins() {
  _currentTypoPlugin = _typographyEnabled ? makeTypographyPlugin() : inputRules({ rules: [] })
  return [
    history(),
    wordKeymap,
    keymap(baseKeymap),
    findPlugin,
    tableEditing(),
    makeEditorInputRules(),
    _currentTypoPlugin,
  ]
}

function toggleTypography() {
  _typographyEnabled = !_typographyEnabled
  const ind = document.getElementById('smart-typo-indicator')
  if (ind) ind.textContent = _typographyEnabled ? '✓ Smart' : ''
  if (view) {
    const newState = view.state.reconfigure({ plugins: buildPlugins() })
    view.updateState(newState)
    syncToolbar(newState)
    view.focus()
  }
}

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

// ── Image ─────────────────────────────────────────────────────────────────────

function insertImageNode(src, alt) {
  if (!view || !schema.nodes.image) return
  const node = schema.nodes.image.create({ src, alt: alt || null })
  const { $from } = view.state.selection
  view.dispatch(view.state.tr.replaceSelectionWith(node))
  view.focus()
}

function openImageFilePicker() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.style.display = 'none'
  document.body.appendChild(input)
  input.addEventListener('change', () => {
    const file = input.files?.[0]
    if (!file) { input.remove(); return }
    const reader = new FileReader()
    reader.onload = e => {
      insertImageNode(e.target.result, file.name)
      input.remove()
    }
    reader.readAsDataURL(file)
  })
  input.click()
}

// ── Focus mode ───────────────────────────────────────────────────────────────

function toggleFocusMode() {
  document.body.classList.toggle('focus-mode')
}

// ── Special Characters ────────────────────────────────────────────────────────

const SC_CATEGORIES = [
  { label: 'Symbols', chars: [
    { ch: '\u00A9', name: 'copyright' }, { ch: '\u00AE', name: 'registered' }, { ch: '\u2122', name: 'trademark' },
    { ch: '\u00B0', name: 'degree' }, { ch: '\u00A7', name: 'section' }, { ch: '\u00B6', name: 'pilcrow paragraph' },
    { ch: '\u2020', name: 'dagger' }, { ch: '\u2021', name: 'double dagger' }, { ch: '\u2022', name: 'bullet' },
    { ch: '\u203B', name: 'reference mark' }, { ch: '\u2605', name: 'black star' }, { ch: '\u2606', name: 'white star' },
    { ch: '\u2713', name: 'check mark' }, { ch: '\u2717', name: 'ballot x cross' }, { ch: '\u2726', name: 'star' },
    { ch: '\u27A4', name: 'arrowhead' }, { ch: '\u2756', name: 'diamond' },
  ] },
  { label: 'Currency', chars: [
    { ch: '\u20AC', name: 'euro' }, { ch: '\u00A3', name: 'pound sterling' }, { ch: '\u00A5', name: 'yen yuan' },
    { ch: '\u00A2', name: 'cent' }, { ch: '\u20B9', name: 'rupee indian' }, { ch: '\u20A9', name: 'won korean' },
    { ch: '\u20BF', name: 'bitcoin' }, { ch: '\u20AA', name: 'shekel' }, { ch: '\u20AB', name: 'dong vietnamese' },
    { ch: '\u20AD', name: 'kip lao' },
  ] },
  { label: 'Math', chars: [
    { ch: '\u00B1', name: 'plus minus' }, { ch: '\u00D7', name: 'multiply times' }, { ch: '\u00F7', name: 'divide division' },
    { ch: '\u2260', name: 'not equal' }, { ch: '\u2264', name: 'less than or equal' }, { ch: '\u2265', name: 'greater than or equal' },
    { ch: '\u221E', name: 'infinity' }, { ch: '\u221A', name: 'square root radical' }, { ch: '\u2211', name: 'sum sigma' },
    { ch: '\u220F', name: 'product pi' }, { ch: '\u2202', name: 'partial derivative' }, { ch: '\u222B', name: 'integral' },
    { ch: '\u03C0', name: 'pi' }, { ch: '\u03B1', name: 'alpha' }, { ch: '\u03B2', name: 'beta' },
    { ch: '\u03B3', name: 'gamma' }, { ch: '\u03B4', name: 'delta' }, { ch: '\u03BB', name: 'lambda' },
    { ch: '\u03BC', name: 'mu micro' }, { ch: '\u03C3', name: 'sigma' }, { ch: '\u03C6', name: 'phi' }, { ch: '\u03C9', name: 'omega' },
  ] },
  { label: 'Arrows', chars: [
    { ch: '\u2190', name: 'arrow left' }, { ch: '\u2192', name: 'arrow right' }, { ch: '\u2191', name: 'arrow up' },
    { ch: '\u2193', name: 'arrow down' }, { ch: '\u2194', name: 'arrow left right' }, { ch: '\u2195', name: 'arrow up down' },
    { ch: '\u21D0', name: 'double arrow left' }, { ch: '\u21D2', name: 'double arrow right' },
    { ch: '\u21D1', name: 'double arrow up' }, { ch: '\u21D3', name: 'double arrow down' },
    { ch: '\u21D4', name: 'double arrow left right' }, { ch: '\u2794', name: 'arrow pointing right' },
    { ch: '\u279C', name: 'arrow curved right' },
  ] },
  { label: 'Punctuation', chars: [
    { ch: '\u00AB', name: 'left guillemet angle quote' }, { ch: '\u00BB', name: 'right guillemet angle quote' },
    { ch: '\u201E', name: 'low double quotation mark' }, { ch: '\u201C', name: 'left double quote' },
    { ch: '\u201D', name: 'right double quote' }, { ch: '\u2018', name: 'left single quote' },
    { ch: '\u2019', name: 'right single quote apostrophe' }, { ch: '\u2039', name: 'left single guillemet' },
    { ch: '\u203A', name: 'right single guillemet' }, { ch: '\u2014', name: 'em dash' }, { ch: '\u2013', name: 'en dash' },
    { ch: '\u2026', name: 'ellipsis' }, { ch: '\u203C', name: 'double exclamation' }, { ch: '\u203D', name: 'interrobang' },
  ] },
  { label: 'Latin Extended', chars: [
    { ch: '\u00E0', name: 'a grave' }, { ch: '\u00E1', name: 'a acute' }, { ch: '\u00E2', name: 'a circumflex' },
    { ch: '\u00E3', name: 'a tilde' }, { ch: '\u00E4', name: 'a umlaut' }, { ch: '\u00E5', name: 'a ring' },
    { ch: '\u00E6', name: 'ae ligature' }, { ch: '\u00E7', name: 'c cedilla' }, { ch: '\u00E8', name: 'e grave' },
    { ch: '\u00E9', name: 'e acute' }, { ch: '\u00EA', name: 'e circumflex' }, { ch: '\u00EB', name: 'e umlaut' },
    { ch: '\u00EC', name: 'i grave' }, { ch: '\u00ED', name: 'i acute' }, { ch: '\u00EE', name: 'i circumflex' },
    { ch: '\u00EF', name: 'i umlaut' }, { ch: '\u00F1', name: 'n tilde' }, { ch: '\u00F2', name: 'o grave' },
    { ch: '\u00F3', name: 'o acute' }, { ch: '\u00F4', name: 'o circumflex' }, { ch: '\u00F6', name: 'o umlaut' },
    { ch: '\u00F9', name: 'u grave' }, { ch: '\u00FA', name: 'u acute' }, { ch: '\u00FB', name: 'u circumflex' },
    { ch: '\u00FC', name: 'u umlaut' }, { ch: '\u00FD', name: 'y acute' }, { ch: '\u00FF', name: 'y umlaut' },
  ] },
]

const SC_ALL = SC_CATEGORIES.flatMap(cat => cat.chars)

const SC_RECENT_KEY = 'humanproof_recent_chars'
const SC_RECENT_MAX = 8

function scGetRecent() {
  try { return JSON.parse(localStorage.getItem(SC_RECENT_KEY) || '[]') } catch { return [] }
}

function scAddRecent(ch) {
  let recent = scGetRecent().filter(c => c !== ch)
  recent.unshift(ch)
  if (recent.length > SC_RECENT_MAX) recent = recent.slice(0, SC_RECENT_MAX)
  try { localStorage.setItem(SC_RECENT_KEY, JSON.stringify(recent)) } catch {}
}

function insertSpecialChar(ch) {
  if (!view) return
  const { from, to } = view.state.selection
  view.dispatch(view.state.tr.replaceWith(from, to, schema.text(ch)))
  view.focus()
}

function _scMakeBtn(charObj) {
  const btn = document.createElement('button')
  btn.className = 'sc-char'
  btn.textContent = charObj.ch
  btn.title = charObj.name
  btn.type = 'button'
  btn.addEventListener('click', () => {
    scAddRecent(charObj.ch)
    insertSpecialChar(charObj.ch)
    closeSpecialCharsDialog()
  })
  return btn
}

function _scRenderRecent() {
  const wrapper = document.getElementById('sc-recent')
  const grid = document.getElementById('sc-recent-grid')
  if (!wrapper || !grid) return
  const recent = scGetRecent()
  if (!recent.length) { wrapper.style.display = 'none'; return }
  wrapper.style.display = ''
  grid.innerHTML = ''
  recent.forEach(ch => {
    const charObj = SC_ALL.find(c => c.ch === ch) || { ch, name: ch }
    grid.appendChild(_scMakeBtn(charObj))
  })
}

function _scRenderBody(filter) {
  const body = document.getElementById('sc-body')
  if (!body) return
  body.innerHTML = ''
  const q = (filter || '').toLowerCase().trim()

  if (q) {
    const matches = SC_ALL.filter(c => c.ch === q || c.name.includes(q))
    if (!matches.length) {
      const msg = document.createElement('div')
      msg.style.cssText = 'font-size:12px;color:#888;padding:8px 0'
      msg.textContent = 'No characters found.'
      body.appendChild(msg)
      return
    }
    const grid = document.createElement('div')
    grid.className = 'sc-grid'
    matches.forEach(c => grid.appendChild(_scMakeBtn(c)))
    body.appendChild(grid)
    return
  }

  SC_CATEGORIES.forEach(cat => {
    const section = document.createElement('div')
    section.className = 'sc-category'
    const label = document.createElement('div')
    label.className = 'sc-cat-label'
    label.textContent = cat.label
    section.appendChild(label)
    const grid = document.createElement('div')
    grid.className = 'sc-grid'
    cat.chars.forEach(c => grid.appendChild(_scMakeBtn(c)))
    section.appendChild(grid)
    body.appendChild(section)
  })
}

function openSpecialCharsDialog() {
  const dlg = document.getElementById('special-chars-dialog')
  if (!dlg) return
  const searchEl = document.getElementById('sc-search')
  if (searchEl) searchEl.value = ''
  _scRenderRecent()
  _scRenderBody('')
  dlg.classList.add('visible')
  if (searchEl) setTimeout(() => searchEl.focus(), 50)
}

function closeSpecialCharsDialog() {
  document.getElementById('special-chars-dialog')?.classList.remove('visible')
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

// ── Table of Contents ────────────────────────────────────────────────────────

const TOC_HEADING_TEXT = 'Table of Contents'

function buildTocNodes(headings) {
  // Build a flat bullet list where each item is indented by heading level.
  // H1 → 0 indent, H2 → 1 level (nested list), H3 → 2 levels, H4 → 3 levels.
  // We use nested bullet_list nodes to achieve indentation in ProseMirror.
  function makeItem(text, level) {
    const para = schema.nodes.paragraph.create(null, schema.text(text))
    const item = schema.nodes.list_item.create(null, para)
    if (level <= 1) return item
    // Wrap in nested lists for deeper levels
    let node = item
    for (let d = 1; d < level; d++) {
      node = schema.nodes.list_item.create(null, [
        schema.nodes.paragraph.create(null, schema.text('')),
        schema.nodes.bullet_list.create(null, node),
      ])
    }
    return node
  }

  const items = headings.map(h => makeItem(h.text || '(empty)', h.level))
  if (!items.length) {
    // Empty list fallback
    items.push(schema.nodes.list_item.create(null, schema.nodes.paragraph.create(null, schema.text('(no headings)'))))
  }
  const list = schema.nodes.bullet_list.create(null, items)
  const tocHeading = schema.nodes.heading.create({ level: 2 }, schema.text(TOC_HEADING_TEXT))
  const hr = schema.nodes.horizontal_rule.create()
  return [tocHeading, list, hr]
}

function insertTableOfContents() {
  if (!view) return
  const headings = buildOutline().filter(h => h.text !== TOC_HEADING_TEXT)
  const nodes = buildTocNodes(headings)
  const { $from } = view.state.selection
  const insertPos = $from.after($from.depth)
  let tr = view.state.tr
  for (let i = nodes.length - 1; i >= 0; i--) {
    tr = tr.insert(insertPos, nodes[i])
  }
  view.dispatch(tr)
  view.focus()
}

function updateTableOfContents() {
  if (!view) return
  const doc = view.state.doc
  // Find the TOC heading node
  let tocStart = -1
  let tocEnd = -1
  doc.forEach((node, offset) => {
    if (node.type === schema.nodes.heading && node.textContent === TOC_HEADING_TEXT) {
      tocStart = offset
    }
  })
  if (tocStart === -1) {
    // No existing TOC — insert one instead
    insertTableOfContents()
    return
  }
  // The TOC block is: [heading, bullet_list, horizontal_rule] at top level.
  // Find the end: heading + next list + next hr (if they follow immediately).
  tocEnd = tocStart
  let foundHeading = false
  let afterHeadingCount = 0
  doc.forEach((node, offset) => {
    if (offset === tocStart) { foundHeading = true; tocEnd = offset + node.nodeSize; return }
    if (foundHeading && afterHeadingCount < 2) {
      const isList = node.type === schema.nodes.bullet_list || node.type === schema.nodes.ordered_list
      const isHr = node.type === schema.nodes.horizontal_rule
      if (isList || isHr) {
        tocEnd = offset + node.nodeSize
        afterHeadingCount++
      } else {
        afterHeadingCount = 2 // stop
      }
    }
  })

  const headings = buildOutline().filter(h => h.text !== TOC_HEADING_TEXT)
  const nodes = buildTocNodes(headings)
  let tr = view.state.tr
  tr = tr.replaceWith(tocStart, tocEnd, nodes)
  view.dispatch(tr)
  view.focus()
}

function insertOrUpdateTableOfContents() {
  if (!view) return
  const doc = view.state.doc
  let hasToc = false
  doc.forEach(node => {
    if (node.type === schema.nodes.heading && node.textContent === TOC_HEADING_TEXT) hasToc = true
  })
  if (hasToc) updateTableOfContents()
  else insertTableOfContents()
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

// ── Readability ─────────────────────────────────────────────────────────────

let _readabilityTimer = null

function scheduleReadability(text) {
  clearTimeout(_readabilityTimer)
  _readabilityTimer = setTimeout(() => {
    const scoreEl = document.getElementById('readability-score')
    if (!scoreEl) return
    if (!text.trim()) {
      scoreEl.textContent = ''
      return
    }
    const { score, level } = fleschKincaid(text)
    scoreEl.textContent = `FK ${score} · ${level}`
  }, 500)
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
  'Mod-/': () => { openShortcutPanel(); return true },
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
  "Mod-Shift-'": () => { toggleTypography(); return true },
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
  'Mod-k': () => { openLinkDialog(); return true },
  'Mod-\\': clearAllMarks,
  'Mod-Shift-\\': () => { openSpecialCharsDialog(); return true },
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
  'Mod-Shift-o': () => { insertOrUpdateTableOfContents(); return true },
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
  'Mod-p': () => { printDocument(); return true },
})

// ── Print ────────────────────────────────────────────────────────────────────

function printDocument() {
  window.print()
}

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
  const state = EditorState.create({
    schema,
    plugins: buildPlugins(),
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
      updateDocStats(next.doc.textContent)
      updateWordCountDetail(next.doc.textContent)
      applySelectionStats(next)
      if (tr.docChanged) {
        updateOutline()
        const text = next.doc.textContent
        if (text !== _lastHistoryText) {
          _docHistory.push({ t: Date.now(), text })
          _lastHistoryText = text
        }
        scheduleReadability(text)
      }
      syncToolbar(next)
    },
    handleDOMEvents: {
      keydown(editorView, event) {
        if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'v') {
          event.preventDefault()
          navigator.clipboard.readText().then(text => {
            if (!text || !view) return
            const node = schema.text(text)
            view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView())
            const encoded = new TextEncoder().encode(text)
            crypto.subtle.digest('SHA-256', encoded).then(buf => {
              const hash = Array.from(new Uint8Array(buf))
                .map(b => b.toString(16).padStart(2, '0'))
                .join('')
              invoke('log_paste_event', { char_count: text.length, content_hash: hash }).catch(console.error)
            })
            view.focus()
          }).catch(() => {})
          return true
        }
        // Keyboard gating: we can't synchronously block, but we track for session.
        // Actual filtering is done at the HID level via pending_builtin_keydowns.
        trackKeystroke()
        return false // let ProseMirror handle, filtering done at HID level
      },
      // Allow paste but log a SHA-256 hash of the clipboard content so verifiers
      // can detect if pasted material appears in the final document.
      paste(_view, event) {
        // Check for image items first
        const items = event.clipboardData?.items
        if (items) {
          for (const item of items) {
            if (item.type.startsWith('image/')) {
              event.preventDefault()
              const file = item.getAsFile()
              if (!file) break
              const reader = new FileReader()
              reader.onload = e => insertImageNode(e.target.result, 'pasted-image')
              reader.readAsDataURL(file)
              return true
            }
          }
        }
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

function applySelectionStats(state) {
  const sel = state.selection
  const wordEl = document.getElementById('word-count')
  const charEl = document.getElementById('char-count')
  if (!wordEl || !charEl) return
  if (!sel.empty) {
    const selText = state.doc.textBetween(sel.from, sel.to, ' ')
    const selWords = selText.trim() ? selText.trim().split(/\s+/).length : 0
    const selChars = sel.to - sel.from
    wordEl.textContent = `${selWords} words selected`
    charEl.textContent = `${selChars} chars selected`
    return
  }
  const text = state.doc.textContent
  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  charEl.textContent = `${text.length.toLocaleString()} chars`
  wordEl.textContent = `${words.toLocaleString()} word${words !== 1 ? 's' : ''}`
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

const SHORTCUTS = [
  { category: 'Formatting', items: [
    ['⌘B', 'Bold'], ['⌘I', 'Italic'], ['⌘U', 'Underline'],
    ['⌘⇧X', 'Strikethrough'], ['⌘⇧,', 'Subscript'], ['⌘⇧.', 'Superscript'],
    ['⌘\\', 'Clear Formatting'], ['⌘]', 'Font Bigger'], ['⌘[', 'Font Smaller'],
    ['⌘⇧K', 'Code Block'], ['⌘⇧9', 'Task List'],
  ] },
  { category: 'Structure', items: [
    ['⌘L/E/R/J', 'Align Left/Center/Right/Justify'],
    ['⌘Enter', 'Page Break'], ['⌘⇧T', 'Insert Table (3×3)'],
    ['⌘⇧F', 'Insert Footnote'], ['⌘⇧2', '2-Column Layout'],
    ['⌘⇧1', '1-Column Layout'], ['Tab / ⇧Tab', 'Indent / Outdent'],
    ['⌘⇧O', 'Insert/Update TOC'],
  ] },
  { category: 'Editing', items: [
    ['⌘Z / ⌘Y', 'Undo / Redo'], ['⌘A', 'Select All'], ['⌘K', 'Insert Link'],
    ['⌘F', 'Find'], ['⌘G / ⌘⇧G', 'Find Next / Prev'],
    ['⌘⇧V', 'Paste Plain Text'], ["⌘⇧'", 'Toggle Smart Typography'],
  ] },
  { category: 'View', items: [
    ['⌘⇧Space', 'Focus Mode'], ['⌘/', 'Keyboard Shortcuts'],
    ['Btn: MD', 'Cycle Markdown Mode'],
    ['⌘P', 'Print / Save as PDF'],
  ] },
]

function buildShortcutPanel() {
  const content = document.getElementById('shortcut-content')
  if (!content) return
  content.innerHTML = SHORTCUTS.map(({ category, items }) => `
    <div class="shortcut-category">
      <h3>${category}</h3>
      <div class="shortcut-grid">
        ${items.map(([key, desc]) => `
          <div class="shortcut-row">
            <span class="shortcut-key">${key}</span>
            <span class="shortcut-desc">${desc}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `).join('')
}

function openShortcutPanel() {
  buildShortcutPanel()
  document.getElementById('shortcut-panel')?.classList.add('visible')
}

function closeShortcutPanel() {
  document.getElementById('shortcut-panel')?.classList.remove('visible')
}

function openHelpTopic(topic = 'getting_started') {
  const panel = document.getElementById('help-panel')
  const title = document.getElementById('help-title')
  const content = document.getElementById('help-content')
  const primary = document.getElementById('help-primary')
  const cfg = HELP_TOPICS[topic] ?? HELP_TOPICS.getting_started
  if (!panel || !title || !content || !primary) return

  title.textContent = cfg.title
  content.innerHTML = cfg.html
  if (cfg.primaryLabel && cfg.primaryAction) {
    primary.style.display = ''
    primary.textContent = cfg.primaryLabel
    primary.onclick = cfg.primaryAction
  } else {
    primary.style.display = 'none'
    primary.onclick = null
  }
  panel.classList.add('visible')
}

function closeHelpPanel() {
  document.getElementById('help-panel')?.classList.remove('visible')
}

// ── Toolbar wiring ───────────────────────────────────────────────────────────

function wireToolbar() {
  if (_toolbarWired) return
  _toolbarWired = true
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

  // Markdown mode
  on('btn-markdown', () => {
    cycleMarkdownMode()
  })

  // Print
  on('btn-print', printDocument)

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

  // Image
  on('btn-insert-image', () => openImageFilePicker())

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

  const typoIndicator = document.getElementById('smart-typo-indicator')
  if (typoIndicator) {
    typoIndicator.textContent = '✓ Smart'
    typoIndicator.style.cursor = 'pointer'
    typoIndicator.addEventListener('click', toggleTypography)
  }

  on('btn-toc', () => insertOrUpdateTableOfContents())

  on('btn-link', openLinkDialog)
  on('link-dialog-insert', applyLinkDialog)
  on('link-dialog-remove', removeLinkDialog)
  on('link-dialog-cancel', closeLinkDialog)
  on('link-dialog-close', closeLinkDialog)
  el('link-dialog')?.addEventListener('click', e => {
    if (e.target.id === 'link-dialog') closeLinkDialog()
  })
  el('link-url')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') applyLinkDialog()
    if (e.key === 'Escape') closeLinkDialog()
  })
  el('link-text')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') applyLinkDialog()
    if (e.key === 'Escape') closeLinkDialog()
  })

  on('btn-shortcuts', openShortcutPanel)
  on('shortcut-close', closeShortcutPanel)
  document.getElementById('shortcut-panel')?.addEventListener('click', e => {
    if (e.target.id === 'shortcut-panel') closeShortcutPanel()
  })
  on('help-close', closeHelpPanel)
  document.getElementById('help-panel')?.addEventListener('click', e => {
    if (e.target.id === 'help-panel') closeHelpPanel()
  })
  window.__openHelpTopic = openHelpTopic

  // Special chars dialog
  on('btn-special-chars', openSpecialCharsDialog)
  on('sc-close', closeSpecialCharsDialog)
  document.getElementById('special-chars-dialog')?.addEventListener('click', e => {
    if (e.target.id === 'special-chars-dialog') closeSpecialCharsDialog()
  })
  document.getElementById('sc-search')?.addEventListener('input', e => {
    _scRenderBody(e.target.value)
  })

  if (!_shortcutEscBound) {
    _shortcutEscBound = true
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        closeShortcutPanel()
        closeHelpPanel()
        closeLinkDialog()
        closeSpecialCharsDialog()
      }
    })
  }
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

// ── Link dialog ─────────────────────────────────────────────────────────────

// Stores the selection range that was active when the dialog opened, so we can
// apply the mark after focus returns to the editor.
let _linkDialogRange = null

function openLinkDialog() {
  if (!view) return
  const state = view.state
  const { from, to, $from } = state.selection

  // Check if cursor is inside an existing link mark
  let existingHref = null
  let existingRange = { from, to }

  // Walk up to find a link mark at cursor
  const linkMark = schema.marks.link
  if (linkMark) {
    // If cursor is collapsed, find the link mark extent around cursor
    const marks = $from.marks()
    const lm = marks.find(m => m.type === linkMark)
    if (lm) {
      existingHref = lm.attrs.href
      // Expand range to cover the full link mark span
      let start = from
      let end = from
      state.doc.nodesBetween(0, state.doc.content.size, (node, pos) => {
        if (node.isInline && node.marks.some(m => m.type === linkMark && m.attrs.href === existingHref)) {
          if (pos < start || start === from) start = Math.min(start, pos)
          end = Math.max(end, pos + node.nodeSize)
        }
      })
      existingRange = { from: start, to: end }
    } else if (from !== to) {
      // Selection: check if a link mark is present in selection
      state.doc.nodesBetween(from, to, node => {
        if (!existingHref && node.isInline) {
          const m = node.marks.find(mk => mk.type === linkMark)
          if (m) existingHref = m.attrs.href
        }
      })
    }
  }

  // Pre-fill display text from selection
  const selText = from !== to ? state.doc.textBetween(from, to, ' ') : ''

  _linkDialogRange = existingRange.from !== existingRange.to ? existingRange : (from !== to ? { from, to } : null)

  // Populate dialog fields
  const urlInput = el('link-url')
  const textInput = el('link-text')
  const removeBtn = el('link-dialog-remove')
  const insertBtn = el('link-dialog-insert')
  const titleEl = el('link-dialog-title')

  if (urlInput) urlInput.value = existingHref || ''
  if (textInput) textInput.value = selText
  if (removeBtn) removeBtn.style.display = existingHref ? '' : 'none'
  if (insertBtn) insertBtn.textContent = existingHref ? 'Update' : 'Insert'
  if (titleEl) titleEl.textContent = existingHref ? 'Edit Link' : 'Insert Link'

  el('link-dialog')?.classList.add('visible')
  // Focus URL field (small delay so dialog is visible first)
  setTimeout(() => urlInput?.focus(), 30)
}

function closeLinkDialog() {
  el('link-dialog')?.classList.remove('visible')
  _linkDialogRange = null
  view?.focus()
}

function applyLinkDialog() {
  const href = el('link-url')?.value?.trim()
  const text = el('link-text')?.value

  if (!href) { closeLinkDialog(); return }

  const linkMark = schema.marks.link
  if (!linkMark || !view) { closeLinkDialog(); return }

  const state = view.state
  let tr = state.tr

  if (_linkDialogRange) {
    // Apply mark to existing range
    tr = tr.addMark(_linkDialogRange.from, _linkDialogRange.to, linkMark.create({ href, title: null }))
  } else {
    // No selection: insert linked text at cursor
    if (!text) { closeLinkDialog(); return }
    const { from } = state.selection
    const node = schema.text(text, [linkMark.create({ href, title: null })])
    tr = tr.insert(from, node)
  }

  view.dispatch(tr)
  closeLinkDialog()
}

function removeLinkDialog() {
  if (!view) { closeLinkDialog(); return }
  const linkMark = schema.marks.link
  if (!linkMark) { closeLinkDialog(); return }

  const state = view.state
  const { from, to, $from } = state.selection
  let removeFrom = from
  let removeTo = to

  // If cursor is collapsed, find the link extent
  if (from === to) {
    state.doc.nodesBetween(0, state.doc.content.size, (node, pos) => {
      if (node.isInline && node.marks.some(m => m.type === linkMark)) {
        const lm = node.marks.find(m => m.type === linkMark)
        if (lm) {
          removeFrom = Math.min(removeFrom, pos)
          removeTo = Math.max(removeTo, pos + node.nodeSize)
        }
      }
    })
  }

  view.dispatch(state.tr.removeMark(removeFrom, removeTo, linkMark))
  closeLinkDialog()
}

// ── Auto-save + poller ───────────────────────────────────────────────────────

function startAutosave() {
  setInterval(async () => {
    try {
      await saveDocumentSnapshot(view.state)
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

  async function restoreSavedDocument() {
    try {
      const snapshot = await loadDocumentSnapshot()
      if (snapshot) {
        restoreDocumentSnapshot(view, snapshot)
      }
    } catch (err) {
      console.error('Failed to restore encrypted document snapshot', err)
    }
  }

  function initializeEditorUi() {
    initMarkdown(view)
    wireToolbar()
    setupClickToPlace()
    setupMenuCmd()
    updateDocStats(view.state.doc.textContent)
    updateWordCountDetail(view.state.doc.textContent)
    applySelectionStats(view.state)
    scheduleReadability(view.state.doc.textContent)
  }

  if (!hidOk) {
    buildEditor(false)
    await restoreSavedDocument()
    initializeEditorUi()
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
  await restoreSavedDocument()
  initializeEditorUi()
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
      case 'shortcuts':     openShortcutPanel(); return
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
        saveDocumentSnapshot(view.state)
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
      case 'markdown':           cycleMarkdownMode(); return
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
