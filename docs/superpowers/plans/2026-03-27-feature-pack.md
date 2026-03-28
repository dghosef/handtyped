# HumanProof Feature Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add code blocks, task lists, paragraph spacing, footnotes, 2-column layout, smart typography, paste-as-plain-text, selection stats, readability score, keyboard shortcut panel, enhanced vim motions, and markdown live preview.

**Architecture:** All changes are frontend-only (`src/`, `index.html`). No Rust/Tauri changes. New files: `src/readability.js`, `src/typography.js`. Existing files extended: `src/schema.js`, `src/vim.js`, `src/markdown.js`, `src/editor.js`, `index.html`. `prosemirror-inputrules`, `marked`, and `vitest` are added as dependencies.

**Tech Stack:** ProseMirror (inputRules, NodeViews), `marked` for HTML rendering, `vitest` for unit tests, vanilla JS.

---

## File Map

| File | Role |
|------|------|
| `src/readability.js` | **New.** `countSyllables(word)` and `fleschKincaid(text)` — pure functions, unit tested |
| `src/typography.js` | **New.** `makeTypographyPlugin()` returns a ProseMirror `inputRules` plugin |
| `src/schema.js` | Add `code_block`, `task_list`, `task_item`, `footnote_mark`, `footnote_def`, `column_block`, `column` nodes; add `spaceBefore`/`spaceAfter` to paragraph |
| `src/vim.js` | Extend `VimPlugin` with count prefixes, f/F/t/T/;/,, %, ., c operator, r replace, y/p yank-paste |
| `src/markdown.js` | Three-state toggle (off/split/source), overlay syntax highlighting, `marked` preview |
| `src/editor.js` | Wire all new features: inputRules, NodeViews, toolbar, readability, selection stats, shortcut panel, paste-plain |
| `index.html` | Toolbar row 4, split-pane HTML, shortcut panel modal, new status bar spans, all CSS |

---

## Task 1: Install dependencies + `src/readability.js`

**Files:**
- Modify: `package.json`
- Create: `src/readability.js`
- Create: `src/readability.test.js`

- [ ] **Step 1: Install packages**

```bash
cd /Users/dghosef/editor
npm install prosemirror-inputrules marked
npm install -D vitest
```

- [ ] **Step 2: Add test script to `package.json`**

In `package.json`, add `"test": "vitest run"` to `scripts`:

```json
{
  "name": "humanproof",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "tauri": "tauri",
    "test": "vitest run"
  },
  "dependencies": {
    "@tauri-apps/api": "^2",
    "marked": "^12.0.0",
    "prosemirror-commands": "^1.5.2",
    "prosemirror-history": "^1.3.2",
    "prosemirror-inputrules": "^1.4.0",
    "prosemirror-keymap": "^1.2.2",
    "prosemirror-markdown": "^1.13.4",
    "prosemirror-model": "^1.22.3",
    "prosemirror-schema-basic": "^1.2.3",
    "prosemirror-schema-list": "^1.3.0",
    "prosemirror-state": "^1.4.3",
    "prosemirror-tables": "^1.8.5",
    "prosemirror-view": "^1.33.8"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2",
    "vite": "^5.3.1",
    "vitest": "^1.0.0"
  }
}
```

- [ ] **Step 3: Write failing tests for `src/readability.js`**

Create `src/readability.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { countSyllables, fleschKincaid } from './readability.js'

describe('countSyllables', () => {
  it('counts simple word', () => { expect(countSyllables('hello')).toBe(2) })
  it('counts monosyllable', () => { expect(countSyllables('cat')).toBe(1) })
  it('counts "education"', () => { expect(countSyllables('education')).toBe(4) })
  it('returns at least 1', () => { expect(countSyllables('the')).toBeGreaterThanOrEqual(1) })
  it('handles empty string', () => { expect(countSyllables('')).toBe(0) })
})

describe('fleschKincaid', () => {
  it('returns score and level', () => {
    const result = fleschKincaid('The cat sat on the mat. It is a fat cat.')
    expect(result).toHaveProperty('score')
    expect(result).toHaveProperty('level')
    expect(result.score).toBeGreaterThanOrEqual(0)
    expect(result.score).toBeLessThanOrEqual(100)
  })
  it('handles single word', () => {
    const result = fleschKincaid('Hello.')
    expect(result.score).toBeGreaterThanOrEqual(0)
  })
  it('simple text scores higher than complex', () => {
    const simple = fleschKincaid('The dog ran fast. The cat sat down.')
    const complex = fleschKincaid('The utilization of sophisticated methodological frameworks necessitates comprehensive evaluation.')
    expect(simple.score).toBeGreaterThan(complex.score)
  })
})
```

- [ ] **Step 4: Run tests to confirm they fail**

```bash
cd /Users/dghosef/editor && npm test
```

Expected: FAIL — "Cannot find module './readability.js'"

- [ ] **Step 5: Create `src/readability.js`**

```js
// src/readability.js — Flesch-Kincaid readability scoring

/**
 * Heuristic syllable counter. Returns 0 for empty/non-alpha strings.
 */
export function countSyllables(word) {
  word = word.toLowerCase().replace(/[^a-z]/g, '')
  if (!word) return 0
  if (word.length <= 3) return 1
  // Strip silent trailing e patterns
  word = word.replace(/(?:[^laeiouy]es|[^laeiouy]ed|[^laeiouy]e)$/, '')
  word = word.replace(/^y/, '')
  const m = word.match(/[aeiouy]{1,2}/g)
  return m ? m.length : 1
}

/**
 * Returns Flesch-Kincaid Reading Ease score (0-100) and grade level label.
 */
export function fleschKincaid(text) {
  const sentences = (text.match(/[.!?]+/g) || []).length || 1
  const wordList = text.trim().split(/\s+/).filter(w => w.replace(/[^a-z]/gi, ''))
  const words = wordList.length || 1
  const syllables = wordList.reduce((n, w) => n + countSyllables(w), 0) || 1

  const raw = 206.835 - 1.015 * (words / sentences) - 84.6 * (syllables / words)
  const score = Math.max(0, Math.min(100, Math.round(raw)))

  const level =
    score >= 90 ? '5th grade' :
    score >= 80 ? '6th grade' :
    score >= 70 ? '7th grade' :
    score >= 60 ? '8th–9th grade' :
    score >= 50 ? 'College' : 'Graduate'

  return { score, level }
}
```

- [ ] **Step 6: Run tests — expect pass**

```bash
cd /Users/dghosef/editor && npm test
```

Expected: PASS — all 7 tests green.

- [ ] **Step 7: Commit**

```bash
cd /Users/dghosef/editor && git add src/readability.js src/readability.test.js package.json package-lock.json && git commit -m "feat: add readability module + test deps"
```

---

## Task 2: Schema additions

**Files:**
- Modify: `src/schema.js` (replace entirely)

- [ ] **Step 1: Write the new `src/schema.js`**

Replace the entire file with:

```js
import { Schema } from 'prosemirror-model'
import { schema as basicSchema } from 'prosemirror-schema-basic'
import { addListNodes } from 'prosemirror-schema-list'
import { tableNodes, tableEditing, columnResizing } from 'prosemirror-tables'
export { tableEditing, columnResizing }

// ── Paragraph: alignment, lineHeight, paragraph spacing ─────────────────────
const paragraphSpec = {
  attrs: {
    align: { default: null },
    lineHeight: { default: null },
    spaceBefore: { default: 0 },
    spaceAfter: { default: 0 },
  },
  content: 'inline*',
  group: 'block',
  parseDOM: [{
    tag: 'p',
    getAttrs(dom) {
      return {
        align: (dom.style.textAlign && dom.style.textAlign !== 'start' && dom.style.textAlign !== 'left')
          ? dom.style.textAlign : null,
        lineHeight: dom.style.lineHeight || null,
        spaceBefore: parseFloat(dom.style.marginTop) || 0,
        spaceAfter: parseFloat(dom.style.marginBottom) || 0,
      }
    }
  }],
  toDOM(node) {
    const { align, lineHeight, spaceBefore, spaceAfter } = node.attrs
    let style = ''
    if (align) style += `text-align: ${align}; `
    if (lineHeight) style += `line-height: ${lineHeight}; `
    if (spaceBefore) style += `margin-top: ${spaceBefore}pt; `
    if (spaceAfter) style += `margin-bottom: ${spaceAfter}pt; `
    return ['p', style ? { style: style.trim() } : {}, 0]
  }
}

// ── Heading: alignment, levels 1-4 ──────────────────────────────────────────
const headingSpec = {
  attrs: { level: { default: 1 }, align: { default: null } },
  content: 'inline*',
  group: 'block',
  defining: true,
  parseDOM: [1, 2, 3, 4].map(i => ({
    tag: `h${i}`,
    getAttrs(dom) { return { level: i, align: dom.style.textAlign || null } }
  })),
  toDOM(node) {
    const { level, align } = node.attrs
    return [`h${level}`, align ? { style: `text-align: ${align}` } : {}, 0]
  }
}

// ── Code block ───────────────────────────────────────────────────────────────
const codeBlockSpec = {
  content: 'text*',
  marks: '',
  group: 'block',
  code: true,
  defining: true,
  attrs: { language: { default: '' } },
  parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
  toDOM() { return ['pre', ['code', 0]] }
}

// ── Task list ────────────────────────────────────────────────────────────────
const taskListSpec = {
  content: 'task_item+',
  group: 'block',
  parseDOM: [{ tag: 'ul[data-task]' }],
  toDOM() { return ['ul', { 'data-task': '' }, 0] }
}

const taskItemSpec = {
  attrs: { checked: { default: false } },
  content: 'inline*',
  defining: true,
  parseDOM: [{
    tag: 'li[data-task-item]',
    getAttrs(dom) { return { checked: dom.hasAttribute('data-checked') } }
  }],
  toDOM(node) {
    const attrs = { 'data-task-item': '' }
    if (node.attrs.checked) attrs['data-checked'] = ''
    return ['li', attrs, 0]
  }
}

// ── Footnote mark (inline atom) ──────────────────────────────────────────────
const footnoteMarkSpec = {
  inline: true,
  atom: true,
  attrs: { number: { default: 1 } },
  group: 'inline',
  selectable: true,
  parseDOM: [{
    tag: 'sup.footnote-ref',
    getAttrs(dom) { return { number: parseInt(dom.dataset.n) || 1 } }
  }],
  toDOM(node) {
    return ['sup', {
      class: 'footnote-ref',
      contenteditable: 'false',
      'data-n': String(node.attrs.number)
    }, `[${node.attrs.number}]`]
  }
}

// ── Footnote definition (block) ──────────────────────────────────────────────
const footnoteDefSpec = {
  attrs: { number: { default: 1 } },
  content: 'inline*',
  group: 'block',
  parseDOM: [{
    tag: 'div.footnote-def',
    getAttrs(dom) { return { number: parseInt(dom.dataset.n) || 1 } }
  }],
  toDOM(node) {
    return ['div', { class: 'footnote-def', 'data-n': String(node.attrs.number) }, 0]
  }
}

// ── 2-column layout ───────────────────────────────────────────────────────────
const columnBlockSpec = {
  content: 'column{2}',
  group: 'block',
  parseDOM: [{ tag: 'div.column-block' }],
  toDOM() { return ['div', { class: 'column-block' }, 0] }
}

const columnSpec = {
  content: 'block+',
  parseDOM: [{ tag: 'div.column' }],
  toDOM() { return ['div', { class: 'column' }, 0] }
}

// ── Page break ───────────────────────────────────────────────────────────────
const pageBreakSpec = {
  group: 'block',
  atom: true,
  parseDOM: [{ tag: 'div.page-break' }],
  toDOM() { return ['div', { class: 'page-break', contenteditable: 'false' }, ['hr']] }
}

// ── Build node map ────────────────────────────────────────────────────────────
let nodes = basicSchema.spec.nodes
  .update('paragraph', paragraphSpec)
  .update('heading', headingSpec)
nodes = addListNodes(nodes, 'paragraph block*', 'block')

// Table nodes
const tableNodeSpecs = tableNodes({
  tableGroup: 'block',
  cellContent: 'block+',
  cellAttributes: {
    align: {
      default: null,
      getFromDOM(dom) { return dom.style.textAlign || null },
      setDOMAttr(val, attrs) { if (val) attrs.style = (attrs.style || '') + `text-align: ${val};` }
    }
  }
})
nodes = nodes.append(tableNodeSpecs)
nodes = nodes.append({
  page_break: pageBreakSpec,
  code_block: codeBlockSpec,
  task_list: taskListSpec,
  task_item: taskItemSpec,
  footnote_mark: footnoteMarkSpec,
  footnote_def: footnoteDefSpec,
  column_block: columnBlockSpec,
  column: columnSpec,
})

// ── Marks ────────────────────────────────────────────────────────────────────
const extraMarks = {
  underline: {
    parseDOM: [{ tag: 'u' }, { style: 'text-decoration=underline' }],
    toDOM() { return ['u', 0] }
  },
  strikethrough: {
    parseDOM: [{ tag: 's' }, { tag: 'del' }],
    toDOM() { return ['s', 0] }
  },
  textColor: {
    attrs: { color: { default: '#000000' } },
    parseDOM: [{ style: 'color', getAttrs: v => ({ color: v }) }],
    toDOM(mark) { return ['span', { style: `color:${mark.attrs.color}` }, 0] }
  },
  highlight: {
    attrs: { color: { default: '#ffff00' } },
    parseDOM: [{ tag: 'mark', getAttrs: dom => ({ color: dom.style.backgroundColor || '#ffff00' }) }],
    toDOM(mark) { return ['mark', { style: `background-color:${mark.attrs.color}` }, 0] }
  },
  fontSize: {
    attrs: { size: { default: '12pt' } },
    parseDOM: [{ style: 'font-size', getAttrs: v => ({ size: v }) }],
    toDOM(mark) { return ['span', { style: `font-size:${mark.attrs.size}` }, 0] }
  },
  fontFamily: {
    attrs: { family: { default: 'Helvetica Neue' } },
    parseDOM: [{ style: 'font-family', getAttrs: v => ({ family: v.replace(/['"]/g, '').trim() }) }],
    toDOM(mark) { return ['span', { style: `font-family:"${mark.attrs.family}"` }, 0] }
  },
  subscript: {
    excludes: 'superscript',
    parseDOM: [{ tag: 'sub' }],
    toDOM() { return ['sub', 0] }
  },
  superscript: {
    excludes: 'subscript',
    parseDOM: [{ tag: 'sup' }],
    toDOM() { return ['sup', 0] }
  },
}

const marks = basicSchema.spec.marks.append(extraMarks)

export const schema = new Schema({ nodes, marks })
export { tableNodes }
```

- [ ] **Step 2: Verify it builds**

```bash
cd /Users/dghosef/editor && npx vite build 2>&1 | tail -10
```

Expected: `✓ built in` with no errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/dghosef/editor && git add src/schema.js && git commit -m "feat: add code_block, task_list, footnote, column, paragraph spacing to schema"
```

---

## Task 3: `index.html` — toolbar row 4, split pane, shortcut panel, CSS

**Files:**
- Modify: `index.html`

This task adds all HTML structure and CSS. No JS wiring yet.

- [ ] **Step 1: Add the new CSS block**

In `index.html`, just before the closing `</style>` tag (after the `#btn-open-privacy:hover` rule at line ~533), add:

```css
    /* ── Code block ─────────────────────────────────────────────────────── */
    .ProseMirror pre {
      background: #1e1e1e; color: #d4d4d4; border-radius: 6px;
      padding: 12px 16px; font-family: 'Menlo','Courier New',monospace;
      font-size: 12px; overflow-x: auto; margin: 8px 0;
    }
    .ProseMirror pre code { background: none; padding: 0; }
    .ProseMirror pre.ProseMirror-selectednode { outline: 2px solid #66a7d4; }

    /* ── Task list ──────────────────────────────────────────────────────── */
    ul[data-task] { list-style: none; padding-left: 4px; }
    ul[data-task] li[data-task-item] { display: flex; align-items: baseline; gap: 6px; padding: 1px 0; }
    ul[data-task] li[data-task-item] > input[type=checkbox] { flex-shrink: 0; cursor: pointer; margin-top: 2px; }
    ul[data-task] li[data-task-item][data-checked] > span { text-decoration: line-through; opacity: 0.5; }

    /* ── Footnotes ──────────────────────────────────────────────────────── */
    sup.footnote-ref { color: #2b5797; cursor: pointer; font-size: 0.75em; }
    .footnote-def { font-size: 12px; color: #555; border-top: 1px solid #ddd; padding-top: 4px; margin-top: 4px; }
    .footnote-def::before { content: attr(data-n) '. '; font-weight: 600; color: #2b5797; }

    /* ── 2-column layout ────────────────────────────────────────────────── */
    .column-block { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin: 8px 0; }
    .column { min-width: 0; }

    /* ── Paragraph spacing selects ─────────────────────────────────────── */
    #space-before-select, #space-after-select { width: 50px; }

    /* ── Shortcut panel ─────────────────────────────────────────────────── */
    #shortcut-panel {
      display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.7);
      z-index: 9998; align-items: center; justify-content: center;
    }
    #shortcut-panel.visible { display: flex; }
    .shortcut-box {
      background: white; border-radius: 10px; padding: 24px 28px;
      max-width: 700px; width: 95%; max-height: 80vh; overflow-y: auto;
      box-shadow: 0 20px 60px rgba(0,0,0,0.4);
    }
    .shortcut-box h2 { font-size: 16px; font-weight: 700; margin-bottom: 16px; color: #111; }
    .shortcut-category { margin-bottom: 16px; }
    .shortcut-category h3 { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #888; margin-bottom: 6px; }
    .shortcut-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 16px; }
    .shortcut-row { display: flex; gap: 10px; align-items: baseline; padding: 2px 0; font-size: 12px; }
    .shortcut-key { flex-shrink: 0; background: #f0f0f0; border: 1px solid #ccc; border-radius: 3px; padding: 1px 6px; font-family: monospace; font-size: 11px; min-width: 90px; text-align: center; }
    .shortcut-desc { color: #444; }
    #shortcut-close { margin-top: 16px; padding: 6px 20px; border: 1px solid #ccc; border-radius: 5px; background: #f5f5f5; cursor: pointer; font-size: 13px; display: block; }

    /* ── Markdown split pane ────────────────────────────────────────────── */
    #md-split-pane { display: none; flex: 1; overflow: hidden; }
    #md-split-pane.visible { display: flex; }
    #md-source-wrapper {
      flex: 1; position: relative; overflow: hidden;
      border-right: 1px solid #333;
    }
    #md-highlight {
      position: absolute; inset: 0; pointer-events: none; z-index: 1;
      padding: 20px; font-family: 'Menlo','Courier New',monospace; font-size: 13px;
      white-space: pre-wrap; word-break: break-word; overflow: auto;
      background: #1e1e1e; color: #d4d4d4; line-height: 1.6;
    }
    #md-source-input {
      position: absolute; inset: 0; z-index: 2;
      padding: 20px; font-family: 'Menlo','Courier New',monospace; font-size: 13px;
      white-space: pre-wrap; word-break: break-word; overflow: auto;
      background: transparent; color: transparent; caret-color: #fff;
      outline: none; line-height: 1.6;
    }
    #md-preview {
      flex: 1; overflow-y: auto; padding: 20px 32px;
      background: white; font-family: -apple-system, sans-serif; font-size: 14px; line-height: 1.7;
    }
    #md-preview h1,#md-preview h2,#md-preview h3 { margin-top: 1em; }
    #md-preview code { background: #f0f0f0; padding: 1px 4px; border-radius: 3px; font-size: 12px; }
    #md-preview pre { background: #1e1e1e; color: #d4d4d4; padding: 12px; border-radius: 6px; overflow-x: auto; }
    #md-preview blockquote { border-left: 3px solid #ccc; margin: 0; padding-left: 16px; color: #666; }
    /* md highlight spans */
    .md-h1,.md-h2,.md-h3,.md-h4,.md-h5,.md-h6 { color: #569cd6; }
    .md-strong { color: #ce9178; }
    .md-em { color: #4ec9b0; }
    .md-code { color: #b5cea8; }
    .md-fence { color: #808080; }
    .md-link { color: #dcdcaa; }
    .md-quote { color: #6a9955; }
    .md-list { color: #c586c0; }

    /* ── Smart typography indicator ─────────────────────────────────────── */
    #smart-typo-indicator { font-size: 10px; color: #4ec9b0; }

    /* ── Readability in status bar ──────────────────────────────────────── */
    #readability-score { font-size: 11px; }
```

- [ ] **Step 2: Add toolbar row 4**

In `index.html`, after the closing `</div><!-- /toolbar-wrapper -->` of row 3 (the line `<button class="tb-btn" id="btn-markdown" title="Markdown Mode">MD</button>`), insert a new row 4 inside `#toolbar-wrapper` before the closing `</div><!-- /toolbar-wrapper -->` comment:

```html
    <!-- Row 4: Code block | Task list | Para spacing | Footnote | Columns | Shortcuts -->
    <div class="toolbar-row">
      <button class="tb-btn" id="btn-code-block" title="Code Block (⌘⇧K)">&lt;/&gt;</button>
      <button class="tb-btn" id="btn-task-list" title="Task List (⌘⇧9)">&#9745; Tasks</button>
      <span class="tb-sep"></span>
      <label style="font-size:11px;color:#666;">&#8593;</label>
      <select class="tb-select" id="space-before-select" title="Space before paragraph">
        <option value="0" selected>0</option>
        <option value="6">6pt</option>
        <option value="12">12pt</option>
        <option value="18">18pt</option>
        <option value="24">24pt</option>
        <option value="36">36pt</option>
      </select>
      <label style="font-size:11px;color:#666;">&#8595;</label>
      <select class="tb-select" id="space-after-select" title="Space after paragraph">
        <option value="0" selected>0</option>
        <option value="6">6pt</option>
        <option value="12">12pt</option>
        <option value="18">18pt</option>
        <option value="24">24pt</option>
        <option value="36">36pt</option>
      </select>
      <span class="tb-sep"></span>
      <button class="tb-btn" id="btn-footnote" title="Insert Footnote (⌘⇧F)">FN&#8321;</button>
      <span class="tb-sep"></span>
      <button class="tb-btn" id="btn-2col" title="2-Column Layout (⌘⇧2)">&#10095;&#10094; 2-Col</button>
      <button class="tb-btn" id="btn-1col" title="1-Column Layout (⌘⇧1)">&#9646; 1-Col</button>
      <span class="tb-sep"></span>
      <button class="tb-btn" id="btn-shortcuts" title="Keyboard Shortcuts (⌘/)">?</button>
    </div>
```

- [ ] **Step 3: Add markdown split pane and update page area**

Replace the current page-area div:

```html
  <!-- ── Main content area (outline + page) ─────────────────────────────── -->
  <div style="display:flex;flex:1;overflow:hidden;">

    <!-- ── Outline Panel ────────────────────────────────────────────────── -->
    <div id="outline-panel">
      <div id="outline-header">Outline</div>
      <div id="outline-content"></div>
    </div>

    <!-- ── Page Area ──────────────────────────────────────────────────────── -->
    <div id="page-area" style="flex:1;overflow-y:auto;display:flex;flex-direction:column;">
      <!-- ── Markdown split pane ────────────────────────────────────────── -->
      <div id="md-split-pane">
        <div id="md-source-wrapper">
          <div id="md-highlight" aria-hidden="true"></div>
          <div id="md-source-input" contenteditable="true" spellcheck="false"></div>
        </div>
        <div id="md-preview"></div>
      </div>
      <div id="page">
        <div id="editor"></div>
      </div>
    </div>

  </div><!-- /main content -->
```

(Remove the old `<textarea id="markdown-source">` — it's replaced by `#md-source-input`.)

- [ ] **Step 4: Add shortcut panel modal**

Before `<script type="module" src="/src/editor.js"></script>`, add:

```html
  <!-- ── Shortcut Panel ─────────────────────────────────────────────────── -->
  <div id="shortcut-panel">
    <div class="shortcut-box">
      <h2>Keyboard Shortcuts</h2>
      <div id="shortcut-content"></div>
      <button id="shortcut-close">Close</button>
    </div>
  </div>
```

- [ ] **Step 5: Update status bar**

Replace the status bar:

```html
  <!-- ── Status Bar ─────────────────────────────────────────────────────── -->
  <div id="status-bar">
    <span id="word-count">0 words</span>
    <span id="char-count">0 chars</span>
    <span id="page-count">Page 1 of 1</span>
    <span id="reading-time">~1 min read</span>
    <span id="keystroke-count">0 keystrokes</span>
    <span id="typing-speed">0 wpm</span>
    <span id="timer">00:00</span>
    <span id="word-count-detail"></span>
    <span id="readability-score"></span>
    <span id="smart-typo-indicator"></span>
    <span id="vim-mode-indicator" style="display:none;font-weight:600;color:#7c83ff;"></span>
    <span id="save-status">Not saved</span>
  </div>
```

- [ ] **Step 6: Verify the page still loads (visual check)**

```bash
cd /Users/dghosef/editor && npm run dev &
```

Open `http://localhost:5173` — toolbar should have 4 rows, no JS errors in console.

- [ ] **Step 7: Commit**

```bash
cd /Users/dghosef/editor && git add index.html && git commit -m "feat: add toolbar row 4, shortcut panel, markdown split pane, status bar spans, CSS"
```

---

## Task 4: Code blocks + task lists

**Files:**
- Modify: `src/editor.js`

- [ ] **Step 1: Add imports at the top of `src/editor.js`**

After the existing imports (after line `import { initMarkdown, toggleMarkdownMode, ... } from './markdown.js'`), add:

```js
import { inputRules, InputRule } from 'prosemirror-inputrules'
import { makeTypographyPlugin } from './typography.js'
import { fleschKincaid } from './readability.js'
```

(Note: `makeTypographyPlugin` comes from Task 6, so for now just add the import and we'll create the file in Task 6. The app will fail to build until Task 6 — if building incrementally, comment out this import and the readability import until those tasks are done, or do Tasks 1, 6 before this task.)

**Important:** Complete Task 6 (`src/typography.js`) before building. If you want to build after this task only, temporarily stub `src/typography.js`:

```js
// src/typography.js — stub, replace in Task 6
import { inputRules } from 'prosemirror-inputrules'
export function makeTypographyPlugin() { return inputRules({ rules: [] }) }
```

- [ ] **Step 2: Add inputRules list + task item NodeView after the `_docHistory` declaration (around line 28)**

Insert after `let _lastHistoryText = ''`:

```js
// ── Typography enabled flag ───────────────────────────────────────────────
let _typographyEnabled = true

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
```

- [ ] **Step 3: Add code block inputRule constant after the `_docHistory` block**

Insert the code block inputRule (placed near the `wordKeymap` definition, before it):

```js
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
```

- [ ] **Step 4: Register nodeViews and inputRules in `buildEditor`**

In `buildEditor`, update the plugins array and add nodeViews:

```js
function buildEditor(editable = true) {
  const typoPlugin = _typographyEnabled ? makeTypographyPlugin() : inputRules({ rules: [] })
  const state = EditorState.create({
    schema,
    plugins: [
      history(),
      wordKeymap,
      keymap(baseKeymap),
      findPlugin,
      tableEditing(),
      makeEditorInputRules(),
      typoPlugin,
    ],
  })

  view = new EditorView(document.getElementById('editor'), {
    state,
    editable: () => editable,
    attributes: { autocorrect: 'off', autocapitalize: 'off', spellcheck: 'true' },
    nodeViews: {
      task_item: (node, view, getPos) => new TaskItemView(node, view, getPos),
    },
    dispatchTransaction(tr) {
      // ... existing dispatchTransaction body unchanged ...
```

Keep the entire existing `dispatchTransaction` body, `handleDOMEvents`, etc. unchanged.

- [ ] **Step 5: Add code block keyboard helpers to `wordKeymap`**

Add to the `wordKeymap` object (inside the `keymap({...})` call):

```js
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
      // lift out
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
```

- [ ] **Step 6: Wire toolbar buttons in `wireToolbar`**

Add to the end of `wireToolbar()`:

```js
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
```

- [ ] **Step 7: Update `syncToolbar` to show code block active state**

Add to `syncToolbar`:

```js
  // Code block
  const inCodeBlock = state.selection.$from.parent.type === schema.nodes.code_block
  setActive('btn-code-block', inCodeBlock)
```

- [ ] **Step 8: Build and verify**

```bash
cd /Users/dghosef/editor && npx vite build 2>&1 | tail -5
```

If `src/typography.js` doesn't exist yet, create the stub first:

```bash
echo "import { inputRules } from 'prosemirror-inputrules'\nexport function makeTypographyPlugin() { return inputRules({ rules: [] }) }" > /Users/dghosef/editor/src/typography.js
```

Expected: `✓ built in` with no errors.

- [ ] **Step 9: Manual test**

Run `npm run tauri dev`. In the editor:
1. Type ` ``` ` at the start of a line — should convert to code block (dark background, monospace).
2. Press Escape inside code block — should convert back to paragraph.
3. Click "☑ Tasks" toolbar button — should insert a task list item with a checkbox.
4. Click the checkbox — should toggle strikethrough on the text.

- [ ] **Step 10: Commit**

```bash
cd /Users/dghosef/editor && git add src/editor.js src/typography.js && git commit -m "feat: add code blocks and task lists"
```

---

## Task 5: Paragraph spacing + footnotes + 2-column layout

**Files:**
- Modify: `src/editor.js`

- [ ] **Step 1: Add paragraph spacing functions**

Add after the existing `setLineHeight` function (around line 127):

```js
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
```

- [ ] **Step 2: Add footnote insert function**

Add after `setParagraphSpacing`:

```js
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
```

- [ ] **Step 3: Add column layout functions**

Add after `insertFootnote`:

```js
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
```

- [ ] **Step 4: Add keyboard shortcuts to `wordKeymap`**

Add to the `wordKeymap` object:

```js
  'Mod-Shift-f': (state, dispatch) => { insertFootnote(); return true },
  'Mod-Shift-2': () => { wrapInColumns(); return true },
  'Mod-Shift-1': () => { unwrapColumns(); return true },
```

(Note: `Mod-Shift-f` was previously used for focus mode — change focus mode to `Mod-Shift-Space` or keep the footnote binding and wire focus mode only via toolbar/menu. The spec assigns `Mod-Shift-F` to footnote. Update the old focus mode keymap entry `'Mod-Shift-f'` to remove it or use `Mod-Shift-Space`.)

Remove the old `'Mod-Shift-f': () => { toggleFocusMode(); return true },` entry from `wordKeymap`.

- [ ] **Step 5: Wire toolbar buttons in `wireToolbar`**

Add to `wireToolbar()`:

```js
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
```

- [ ] **Step 6: Update `syncToolbar` for paragraph spacing**

Add to `syncToolbar`:

```js
  // Paragraph spacing
  const paraNode = state.selection.$from.node(state.selection.$from.depth)
  if (paraNode && paraNode.type === schema.nodes.paragraph) {
    const sb = el('space-before-select'); if (sb) sb.value = String(paraNode.attrs.spaceBefore || 0)
    const sa = el('space-after-select'); if (sa) sa.value = String(paraNode.attrs.spaceAfter || 0)
  }
```

- [ ] **Step 7: Build and manual test**

```bash
cd /Users/dghosef/editor && npx vite build 2>&1 | tail -5
```

Run `npm run tauri dev`. Test:
1. Select a paragraph, choose "12pt" in the ↑ spacing select — paragraph gains top margin.
2. Click "FN₁" button — inserts `[1]` superscript at cursor, cursor jumps to footnote def at bottom.
3. Click "⊳⊲ 2-Col" button — wraps current paragraph in two-column grid.
4. Click "▐ 1-Col" button — unwraps back to single column.

- [ ] **Step 8: Commit**

```bash
cd /Users/dghosef/editor && git add src/editor.js && git commit -m "feat: paragraph spacing, footnotes, 2-column layout"
```

---

## Task 6: Smart typography plugin

**Files:**
- Create: `src/typography.js`
- Create: `src/typography.test.js`

- [ ] **Step 1: Write failing tests**

Create `src/typography.test.js`:

```js
import { describe, it, expect } from 'vitest'

// We test the replacement strings, not the full ProseMirror plugin.
// The rules map is exported for testability.
import { TYPOGRAPHY_RULES } from './typography.js'

describe('typography rules', () => {
  it('has a rule for em-dash', () => {
    const rule = TYPOGRAPHY_RULES.find(r => r.id === 'em-dash')
    expect(rule).toBeDefined()
    expect(rule.replacement).toBe('—')
    expect(rule.pattern.test('foo--')).toBe(true)
  })

  it('has a rule for ellipsis', () => {
    const rule = TYPOGRAPHY_RULES.find(r => r.id === 'ellipsis')
    expect(rule).toBeDefined()
    expect(rule.replacement).toBe('…')
    expect(rule.pattern.test('foo...')).toBe(true)
  })

  it('has rules for copyright, registered, trademark', () => {
    const ids = TYPOGRAPHY_RULES.map(r => r.id)
    expect(ids).toContain('copyright')
    expect(ids).toContain('registered')
    expect(ids).toContain('trademark')
  })

  it('has rules for smart quotes', () => {
    const ids = TYPOGRAPHY_RULES.map(r => r.id)
    expect(ids).toContain('double-quote')
    expect(ids).toContain('single-quote')
  })
})
```

- [ ] **Step 2: Run tests — expect fail**

```bash
cd /Users/dghosef/editor && npm test
```

Expected: FAIL — "Cannot find module './typography.js'" or "TYPOGRAPHY_RULES is not exported"

- [ ] **Step 3: Create `src/typography.js`**

```js
// src/typography.js — smart typography input rules plugin
import { inputRules, InputRule } from 'prosemirror-inputrules'

// Exported for unit tests
export const TYPOGRAPHY_RULES = [
  { id: 'em-dash',   pattern: /--$/,    replacement: '—' },
  { id: 'ellipsis',  pattern: /\.\.\.$/,replacement: '…' },
  { id: 'copyright', pattern: /\(c\)$/i,replacement: '©' },
  { id: 'registered',pattern: /\(r\)$/i,replacement: '®' },
  { id: 'trademark', pattern: /\(tm\)$/i,replacement:'™' },
  // Smart double quote: replacement is a function (context-sensitive)
  { id: 'double-quote', pattern: /"$/, replacement: null },
  // Smart single quote: replacement is a function (context-sensitive)
  { id: 'single-quote', pattern: /'$/, replacement: null },
]

function simpleRule(pattern, replacement) {
  return new InputRule(pattern, (state, match, start, end) =>
    state.tr.insertText(replacement, start, end)
  )
}

function quoteRule(pattern, open, close) {
  return new InputRule(pattern, (state, match, start, end) => {
    const charBefore = start > 0 ? state.doc.textBetween(start - 1, start) : ''
    const isOpening = charBefore === '' || /[\s([{]/.test(charBefore)
    return state.tr.insertText(isOpening ? open : close, start, end)
  })
}

export function makeTypographyPlugin() {
  return inputRules({
    rules: [
      simpleRule(/--$/,     '—'),
      simpleRule(/\.\.\.$/,'…'),
      simpleRule(/\(c\)$/i,'©'),
      simpleRule(/\(r\)$/i,'®'),
      simpleRule(/\(tm\)$/i,'™'),
      quoteRule(/"$/, '\u201C', '\u201D'),
      quoteRule(/'$/, '\u2018', '\u2019'),
    ]
  })
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd /Users/dghosef/editor && npm test
```

Expected: All tests pass (7 readability + 5 typography = 12 total).

- [ ] **Step 5: Wire typography toggle**

In `src/editor.js`, add a function to toggle typography and update the status bar indicator. After the `_typographyEnabled` declaration:

```js
function toggleTypography() {
  _typographyEnabled = !_typographyEnabled
  const ind = document.getElementById('smart-typo-indicator')
  if (ind) ind.textContent = _typographyEnabled ? '✓ Smart' : ''
  // Rebuild editor plugins to apply/remove the typography plugin
  if (view) {
    const plugins = view.state.plugins.filter(p => p !== view.state.plugins.find(x => x === _currentTypoPlugin))
    // Simpler: just track whether typography was included at build time
    // For now, rebuild the editor state with updated plugins
    const typoPlugin = _typographyEnabled ? makeTypographyPlugin() : inputRules({ rules: [] })
    _currentTypoPlugin = typoPlugin
    const newState = view.state.reconfigure({
      plugins: [
        history(),
        wordKeymap,
        keymap(baseKeymap),
        findPlugin,
        tableEditing(),
        makeEditorInputRules(),
        typoPlugin,
      ]
    })
    view.updateState(newState)
  }
}
let _currentTypoPlugin = null
```

Update `buildEditor` to store the typography plugin reference:

```js
function buildEditor(editable = true) {
  _currentTypoPlugin = _typographyEnabled ? makeTypographyPlugin() : inputRules({ rules: [] })
  const state = EditorState.create({
    schema,
    plugins: [
      history(), wordKeymap, keymap(baseKeymap), findPlugin,
      tableEditing(), makeEditorInputRules(), _currentTypoPlugin,
    ],
  })
  // ... rest of buildEditor unchanged
```

Add keyboard shortcut to `wordKeymap`:

```js
  "Mod-Shift-'": () => { toggleTypography(); return true },
```

Add to `wireToolbar` (or handle via status bar click):

```js
  const ind = document.getElementById('smart-typo-indicator')
  if (ind) {
    ind.textContent = '✓ Smart'
    ind.style.cursor = 'pointer'
    ind.addEventListener('click', toggleTypography)
  }
```

- [ ] **Step 6: Build and verify**

```bash
cd /Users/dghosef/editor && npx vite build 2>&1 | tail -5
```

Run `npm run tauri dev`. Type `--` → should become `—`. Type `(c)` → should become `©`. Click `✓ Smart` in status bar → should toggle off, `--` stays as `--`.

- [ ] **Step 7: Commit**

```bash
cd /Users/dghosef/editor && git add src/typography.js src/typography.test.js src/editor.js && git commit -m "feat: smart typography plugin with toggle"
```

---

## Task 7: Productivity polish — paste plain text, selection stats, readability, shortcut panel

**Files:**
- Modify: `src/editor.js`

- [ ] **Step 1: Add paste-as-plain-text**

In `src/editor.js`, inside `handleDOMEvents` in `buildEditor`, add a `keydown` branch for Cmd+Shift+V. The existing `keydown` handler is:

```js
keydown(editorView, event) {
  if (vim.handleKeydown(editorView, event)) return true
  trackKeystroke()
  return false
},
```

Replace with:

```js
keydown(editorView, event) {
  // Paste as plain text: Cmd+Shift+V
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'v') {
    event.preventDefault()
    navigator.clipboard.readText().then(text => {
      if (!text || !view) return
      const node = schema.text(text)
      view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView())
      // Log paste event for attestation
      const encoded = new TextEncoder().encode(text)
      crypto.subtle.digest('SHA-256', encoded).then(buf => {
        const hash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('')
        invoke('log_paste_event', { char_count: text.length, content_hash: hash }).catch(console.error)
      })
      view.focus()
    }).catch(() => {})
    return true
  }
  if (vim.handleKeydown(editorView, event)) return true
  trackKeystroke()
  return false
},
```

- [ ] **Step 2: Add selection stats to `dispatchTransaction`**

In `dispatchTransaction`, after `updateDocStats(next.doc.textContent)`, add:

```js
      // Selection stats
      const sel = next.selection
      const selEl = document.getElementById('word-count')
      const charEl = document.getElementById('char-count')
      if (!sel.empty) {
        const selText = next.doc.textBetween(sel.from, sel.to, ' ')
        const selWords = selText.trim() ? selText.trim().split(/\s+/).length : 0
        const selChars = sel.to - sel.from
        if (selEl) selEl.textContent = `${selWords} words selected`
        if (charEl) charEl.textContent = `${selChars} chars selected`
      } else {
        // Revert to full doc stats — updateDocStats already set these
        // but it uses its own el references; refresh here for clarity
        const text = next.doc.textContent
        const wc = text.trim() ? text.trim().split(/\s+/).length : 0
        if (selEl) selEl.textContent = `${wc} words`
        if (charEl) charEl.textContent = `${text.length} chars`
      }
```

(Remove or guard the existing `updateDocStats` call if it conflicts — check `src/ui.js` to see if it sets `#word-count` and `#char-count`. If it does, the selection override above will work because it runs after.)

- [ ] **Step 3: Add readability score**

Add a debounced readability updater. After `updateTypingSpeed()` function, add:

```js
// ── Readability ───────────────────────────────────────────────────────────────

let _readabilityTimer = null

function scheduleReadability(text) {
  clearTimeout(_readabilityTimer)
  _readabilityTimer = setTimeout(() => {
    const el = document.getElementById('readability-score')
    if (!el) return
    if (!text.trim()) { el.textContent = ''; return }
    const { score, level } = fleschKincaid(text)
    el.textContent = `FK ${score} · ${level}`
  }, 500)
}
```

In `dispatchTransaction`, if `tr.docChanged`, add after the history push:

```js
      if (tr.docChanged) {
        // ... existing code ...
        scheduleReadability(next.doc.textContent)
      }
```

- [ ] **Step 4: Add shortcut panel data and wiring**

Add the shortcut data constant after `setupMenuCmd`:

```js
// ── Keyboard shortcut panel ───────────────────────────────────────────────────

const SHORTCUTS = [
  { category: 'Formatting', items: [
    ['⌘B', 'Bold'], ['⌘I', 'Italic'], ['⌘U', 'Underline'],
    ['⌘⇧X', 'Strikethrough'], ['⌘⇧,', 'Subscript'], ['⌘⇧.', 'Superscript'],
    ['⌘\\', 'Clear Formatting'], ['⌘]', 'Font Bigger'], ['⌘[', 'Font Smaller'],
    ['⌘⇧K', 'Code Block'], ['⌘⇧9', 'Task List'],
  ]},
  { category: 'Structure', items: [
    ['⌘L/E/R/J', 'Align Left/Center/Right/Justify'],
    ['⌘Enter', 'Page Break'], ['⌘⇧T', 'Insert Table (3×3)'],
    ['⌘⇧F', 'Insert Footnote'],
    ['⌘⇧2', '2-Column Layout'], ['⌘⇧1', '1-Column Layout'],
    ['Tab / ⇧Tab', 'Indent / Outdent'],
  ]},
  { category: 'Editing', items: [
    ['⌘Z / ⌘Y', 'Undo / Redo'], ['⌘A', 'Select All'], ['⌘K', 'Insert Link'],
    ['⌘F', 'Find'], ['⌘G / ⌘⇧G', 'Find Next / Prev'],
    ['⌘⇧V', 'Paste Plain Text'], ["⌘⇧'", 'Toggle Smart Typography'],
  ]},
  { category: 'View', items: [
    ['⌘⇧Space', 'Focus Mode'], ['⌘/', 'Keyboard Shortcuts'],
    ['Btn: Vim', 'Toggle Vim Mode'], ['Btn: MD', 'Cycle Markdown Mode'],
  ]},
  { category: 'Vim — Normal Mode', items: [
    ['h j k l', 'Left / Down / Up / Right'],
    ['w b e', 'Word Forward / Back / End'],
    ['0 ^ $', 'Line Start / First Non-blank / End'],
    ['gg G', 'Document Start / End'],
    ['i a I A o O', 'Enter Insert Mode (variants)'],
    ['x dd', 'Delete Char / Line'],
    ['u Ctrl+R', 'Undo / Redo'],
    ['v V', 'Visual / Visual Line'],
    ['/ n N', 'Search / Next / Prev'],
    ['f F <c>', 'Find Char Forward / Backward'],
    ['t T <c>', 'Till Char Forward / Backward'],
    ['; ,', 'Repeat Find / Reverse Find'],
    ['%', 'Matching Bracket'],
    ['r <c>', 'Replace Single Char'],
    ['c cc cw c$', 'Change (delete + insert mode)'],
    ['y yy yw y$', 'Yank (copy to register)'],
    ['p P', 'Paste After / Before'],
    ['.', 'Repeat Last Change'],
    ['3w 5j 2dd', 'Count Prefix'],
    [':w :q :wq', 'Save / Quit / Save+Quit'],
    ['?', 'Open This Panel'],
  ]},
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
```

Wire it in `wireToolbar()`:

```js
  on('btn-shortcuts', openShortcutPanel)
  on('shortcut-close', closeShortcutPanel)
  document.getElementById('shortcut-panel')?.addEventListener('click', e => {
    if (e.target.id === 'shortcut-panel') closeShortcutPanel()
  })
```

Add keyboard shortcut to `wordKeymap`:

```js
  'Mod-/': () => { openShortcutPanel(); return true },
```

Also update vim normal mode to open shortcut panel on `?`:

In `vim.js`, in `_handleNormal`, find the `'/'` case and add:

```js
case '?': this._onShortcuts?.(); return true
```

And in `VimPlugin` constructor, add `this._onShortcuts = options.onShortcuts || (() => {})`.

In `editor.js`, update the vim instantiation (the `vim` singleton at bottom of vim.js has no options, but it's used as `vim.handleKeydown`). Since the options are set in the constructor, the `vim` singleton at end of vim.js uses empty options. We need to set the callback after construction.

After `export const vim = new VimPlugin()`, add setter support — or just add a direct property setter in `VimPlugin`:

```js
// In VimPlugin class:
setShortcutsCallback(fn) { this._onShortcuts = fn }
```

Then in `src/editor.js` after `setupMenuCmd()`:

```js
  vim.setShortcutsCallback(openShortcutPanel)
```

Actually, since `vim.js` doesn't accept options at the singleton level, the simplest fix: just call `openShortcutPanel` from the vim `?` handler by checking a global. Or add a method to VimPlugin. Use the method approach.

- [ ] **Step 5: Build and test**

```bash
cd /Users/dghosef/editor && npx vite build 2>&1 | tail -5
```

Run `npm run tauri dev`. Test:
1. Cmd+Shift+V — pastes without formatting.
2. Select some text — status bar shows "N words selected".
3. Type a paragraph — FK score appears after 500ms (e.g., `FK 72 · College`).
4. Click `?` button or press Cmd+/ — shortcut panel opens. Press Escape or click outside — closes.

- [ ] **Step 6: Commit**

```bash
cd /Users/dghosef/editor && git add src/editor.js && git commit -m "feat: paste plain text, selection stats, readability score, shortcut panel"
```

---

## Task 8: Vim enhancements — count prefixes, f/F/t/T/;/,, %, r replace

**Files:**
- Modify: `src/vim.js`

This task rewrites vim.js in full to add the new features cleanly.

- [ ] **Step 1: Replace `src/vim.js`**

Replace the entire file with:

```js
// src/vim.js
import { TextSelection } from 'prosemirror-state'
import { undo, redo } from 'prosemirror-history'

export class VimPlugin {
  constructor(options = {}) {
    this.mode = 'insert'
    this.pendingOp = null      // 'd', 'c', 'y', 'g'
    this.pendingCount = ''     // numeric prefix buffer
    this._onSave = options.onSave || (() => {})
    this._onFind = options.onFind || (() => {})
    this._onFindNext = options.onFindNext || (() => {})
    this._onFindPrev = options.onFindPrev || (() => {})
    this._onShortcuts = options.onShortcuts || (() => {})
    this._commandBuf = ''
    this._inCommandMode = false
    this._enabled = false
    this._view = null
    // f/F/t/T state
    this._pendingFind = null    // { dir: 1|-1, till: bool }
    this._lastFind = null       // { dir, till, char }
    // r replace state
    this._pendingReplace = false
    // yank register
    this._register = ''
    // . repeat
    this._lastChange = null     // { type, ... }
    // insert mode tracking for . repeat
    this._insertBefore = null   // doc textContent before entering insert
  }

  enable(view) {
    this._enabled = true
    this._view = view
    this.setMode('normal')
  }

  disable() {
    this._enabled = false
    this._view = null
    this.setMode('insert')
  }

  isEnabled() { return this._enabled }

  setShortcutsCallback(fn) { this._onShortcuts = fn }

  setMode(mode) {
    const leavingInsert = this.mode === 'insert' && mode !== 'insert'
    if (leavingInsert && this._view && this._insertBefore !== null) {
      const afterText = this._view.state.doc.textContent
      if (afterText !== this._insertBefore) {
        this._lastChange = { type: 'insert', before: this._insertBefore, after: afterText }
      }
      this._insertBefore = null
    }
    this.mode = mode
    if (mode === 'insert' && this._view) {
      this._insertBefore = this._view.state.doc.textContent
    }
    this.pendingOp = null
    this.pendingCount = ''
    this._pendingFind = null
    this._pendingReplace = false
    this._inCommandMode = false
    this._commandBuf = ''
    this._updateIndicator()
  }

  _updateIndicator() {
    const el = document.getElementById('vim-mode-indicator')
    if (!el) return
    const labels = { normal: '-- NORMAL --', insert: '-- INSERT --', visual: '-- VISUAL --' }
    let text = labels[this.mode] || ''
    if (this._inCommandMode) text = `:${this._commandBuf}`
    else if (this.pendingOp) text = `-- NORMAL [${this.pendingOp}${this.pendingCount}] --`
    else if (this._pendingFind) text = `-- NORMAL [${this._pendingFind.key}] --`
    else if (this._pendingReplace) text = '-- NORMAL [r] --'
    else if (this.pendingCount) text = `-- NORMAL [${this.pendingCount}] --`
    el.textContent = text
    el.style.display = this._enabled ? '' : 'none'
  }

  handleKeydown(view, event) {
    if (!this._enabled) return false
    this._view = view
    const key = event.key
    const ctrl = event.ctrlKey
    const shift = event.shiftKey

    if (this.mode === 'insert') {
      if (key === 'Escape' || (ctrl && key === '[')) {
        event.preventDefault()
        this.setMode('normal')
        const { $head } = view.state.selection
        if ($head.parentOffset > 0) {
          const pos = view.state.selection.head - 1
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)))
        }
        return true
      }
      return false
    }

    if (this._inCommandMode) {
      if (key === 'Enter') {
        this._execCommand(this._commandBuf, view)
        this._inCommandMode = false; this._commandBuf = ''
        this._updateIndicator(); event.preventDefault(); return true
      }
      if (key === 'Escape') {
        this._inCommandMode = false; this._commandBuf = ''
        this._updateIndicator(); event.preventDefault(); return true
      }
      if (key === 'Backspace') {
        this._commandBuf = this._commandBuf.slice(0, -1)
        this._updateIndicator(); event.preventDefault(); return true
      }
      if (key.length === 1) {
        this._commandBuf += key; this._updateIndicator(); event.preventDefault(); return true
      }
      return false
    }

    if (this.mode === 'normal') return this._handleNormal(view, key, ctrl, shift, event)
    if (this.mode === 'visual') return this._handleVisual(view, key, ctrl, shift, event)
    return false
  }

  _handleNormal(view, key, ctrl, shift, event) {
    const state = view.state
    const { $head } = state.selection
    event.preventDefault()

    // ── Pending find char (f/F/t/T) ──────────────────────────────────────
    if (this._pendingFind && key.length === 1 && !ctrl) {
      const find = { ...this._pendingFind, char: key }
      this._pendingFind = null
      this._lastFind = find
      const count = parseInt(this.pendingCount) || 1
      this.pendingCount = ''
      this._execFind(view, find, count)
      this._updateIndicator()
      return true
    }

    // ── Pending replace char (r) ──────────────────────────────────────────
    if (this._pendingReplace && key.length === 1 && !ctrl) {
      this._pendingReplace = false
      if ($head.pos < state.doc.content.size - 1) {
        view.dispatch(state.tr.replaceWith($head.pos, $head.pos + 1, state.schema.text(key)))
        this._lastChange = { type: 'replace_char', char: key }
      }
      this._updateIndicator()
      return true
    }

    // ── Numeric prefix ────────────────────────────────────────────────────
    if (/^[1-9]$/.test(key) || (key === '0' && this.pendingCount && !this.pendingOp)) {
      this.pendingCount += key
      this._updateIndicator()
      return true
    }

    const count = parseInt(this.pendingCount) || 1
    const clearCount = () => { this.pendingCount = '' }

    // ── Pending operator dispatch (d, c, y) ───────────────────────────────
    if (this.pendingOp === 'd') {
      this.pendingOp = null; this._updateIndicator()
      if (key === 'd') {
        for (let i = 0; i < count; i++) this._deleteLine(view)
        this._lastChange = { type: 'delete_line', count }
        clearCount(); return true
      }
      clearCount(); return true
    }

    if (this.pendingOp === 'y') {
      this.pendingOp = null; this._updateIndicator()
      const { $head: h } = view.state.selection
      if (key === 'y') {
        const from = h.start(h.depth); const to = h.end(h.depth)
        this._register = state.doc.textBetween(from, to) + '\n'
      } else if (key === 'w') {
        const from = h.pos
        this._moveWord(view, 'forward', count)
        const to = view.state.selection.$head.pos
        this._register = state.doc.textBetween(from, to)
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from)))
      } else if (key === '$') {
        this._register = state.doc.textBetween(h.pos, h.end(h.depth))
      }
      clearCount(); return true
    }

    if (this.pendingOp === 'c') {
      this.pendingOp = null; this._updateIndicator()
      const { $head: h } = view.state.selection
      if (key === 'c') {
        const from = h.start(h.depth); const to = h.end(h.depth)
        if (to > from) view.dispatch(state.tr.delete(from, to))
        this._enterInsert(view)
      } else if (key === 'w') {
        const from = h.pos
        this._moveWord(view, 'forward', count)
        const to = view.state.selection.$head.pos
        if (to > from) view.dispatch(view.state.tr.delete(from, to))
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from)))
        this._enterInsert(view)
      } else if (key === 'b') {
        const to = h.pos
        this._moveWord(view, 'backward', count)
        const from = view.state.selection.$head.pos
        if (to > from) view.dispatch(view.state.tr.delete(from, to))
        this._enterInsert(view)
      } else if (key === '$') {
        const from = h.pos; const to = h.end(h.depth)
        if (to > from) view.dispatch(state.tr.delete(from, to))
        this._enterInsert(view)
      } else if (key === '0') {
        const from = h.start(h.depth); const to = h.pos
        if (to > from) view.dispatch(state.tr.delete(from, to))
        this._enterInsert(view)
      }
      clearCount(); return true
    }

    if (this.pendingOp === 'g') {
      this.pendingOp = null; this._updateIndicator()
      if (key === 'g') {
        view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, 0)))
      }
      clearCount(); return true
    }

    // ── Main key dispatch ─────────────────────────────────────────────────
    switch (key) {
      // Movement
      case 'h': this._move(view, 'left', count); clearCount(); return true
      case 'l': this._move(view, 'right', count); clearCount(); return true
      case 'j': this._move(view, 'down', count); clearCount(); return true
      case 'k': this._move(view, 'up', count); clearCount(); return true
      case 'w': this._moveWord(view, 'forward', count); clearCount(); return true
      case 'b': this._moveWord(view, 'backward', count); clearCount(); return true
      case 'e': this._moveWordEnd(view, count); clearCount(); return true
      case '0': this._moveLineStart(view, false); clearCount(); return true
      case '^': this._moveLineStart(view, true); clearCount(); return true
      case '$': this._moveLineEnd(view); clearCount(); return true
      case 'G': {
        const endPos = state.doc.content.size
        view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, endPos)))
        clearCount(); return true
      }
      case 'g': this.pendingOp = 'g'; this._updateIndicator(); return true

      // Find char on line
      case 'f': this._pendingFind = { dir: 1, till: false, key: 'f' }; this._updateIndicator(); return true
      case 'F': this._pendingFind = { dir: -1, till: false, key: 'F' }; this._updateIndicator(); return true
      case 't': this._pendingFind = { dir: 1, till: true, key: 't' }; this._updateIndicator(); return true
      case 'T': this._pendingFind = { dir: -1, till: true, key: 'T' }; this._updateIndicator(); return true
      case ';': if (this._lastFind) { this._execFind(view, this._lastFind, count) } clearCount(); return true
      case ',': if (this._lastFind) { this._execFind(view, { ...this._lastFind, dir: -this._lastFind.dir }, count) } clearCount(); return true

      // Matching bracket
      case '%': this._matchBracket(view); clearCount(); return true

      // Insert mode entry
      case 'i': this._enterInsert(view); return true
      case 'I': this._moveLineStart(view, true); this._enterInsert(view); return true
      case 'a': {
        const pos = Math.min($head.pos + 1, state.doc.content.size)
        view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, pos)))
        this._enterInsert(view); return true
      }
      case 'A': this._moveLineEnd(view); this._enterInsert(view); return true
      case 'o': {
        const end = $head.end($head.depth)
        view.dispatch(state.tr.insert(end, state.schema.nodes.paragraph.create()))
        const newPos = end + 1
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, newPos)))
        this._enterInsert(view); return true
      }
      case 'O': {
        const start = $head.start($head.depth) - 1
        const insertPos = Math.max(0, start)
        view.dispatch(state.tr.insert(insertPos, state.schema.nodes.paragraph.create()))
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, insertPos + 1)))
        this._enterInsert(view); return true
      }

      // Edit
      case 'x': {
        if ($head.pos < state.doc.content.size - 1) {
          view.dispatch(state.tr.delete($head.pos, $head.pos + 1))
          this._lastChange = { type: 'delete_char' }
        }
        clearCount(); return true
      }
      case 'd': this.pendingOp = 'd'; this._updateIndicator(); return true
      case 'c': this.pendingOp = 'c'; this._updateIndicator(); return true
      case 'C': {
        const from = $head.pos; const to = $head.end($head.depth)
        if (to > from) view.dispatch(state.tr.delete(from, to))
        this._enterInsert(view); return true
      }

      // Replace single char
      case 'r': {
        if (ctrl) { redo(view.state, view.dispatch); return true }
        this._pendingReplace = true; this._updateIndicator(); return true
      }

      // Yank / paste
      case 'y': this.pendingOp = 'y'; this._updateIndicator(); return true
      case 'p': {
        if (this._register) {
          const text = this._register.replace(/\n$/, '')
          const pos = Math.min($head.pos + 1, state.doc.content.size)
          view.dispatch(state.tr.insertText(text, pos))
          this._lastChange = { type: 'paste', text }
        }
        clearCount(); return true
      }
      case 'P': {
        if (this._register) {
          const text = this._register.replace(/\n$/, '')
          view.dispatch(state.tr.insertText(text, $head.pos))
          this._lastChange = { type: 'paste', text }
        }
        clearCount(); return true
      }

      // Repeat last change
      case '.': {
        this._repeatLastChange(view)
        clearCount(); return true
      }

      // Undo
      case 'u': undo(view.state, view.dispatch); return true

      // Visual
      case 'v': this.setMode('visual'); return true
      case 'V': {
        const lineStart = $head.start($head.depth)
        const lineEnd = $head.end($head.depth)
        view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, lineStart, lineEnd)))
        this.setMode('visual'); return true
      }

      // Search
      case '/': this._onFind(); return true
      case 'n': this._onFindNext(); return true
      case 'N': this._onFindPrev(); return true

      // Shortcuts panel
      case '?': this._onShortcuts(); return true

      // Command mode
      case ':': this._inCommandMode = true; this._commandBuf = ''; this._updateIndicator(); return true

      case 'Escape': {
        view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, $head.pos)))
        this.pendingOp = null; clearCount(); this._updateIndicator(); return true
      }
    }
    return true
  }

  _handleVisual(view, key, ctrl, shift, event) {
    event.preventDefault()
    const state = view.state
    const sel = state.selection

    switch (key) {
      case 'Escape': this.setMode('normal'); return true
      case 'h': {
        const to = Math.max(sel.from, sel.to - 1)
        view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, sel.from, to)))
        return true
      }
      case 'l': {
        const to = Math.min(state.doc.content.size, sel.to + 1)
        view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, sel.from, to)))
        return true
      }
      case 'd':
      case 'x': {
        view.dispatch(state.tr.deleteSelection())
        this.setMode('normal'); return true
      }
      case 'y': {
        this._register = state.doc.textBetween(sel.from, sel.to)
        view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, sel.from)))
        this.setMode('normal'); return true
      }
    }
    return true
  }

  // ── Enter insert mode, record pre-insert doc ──────────────────────────────
  _enterInsert(view) {
    this._insertBefore = view.state.doc.textContent
    this.mode = 'insert'
    this.pendingOp = null; this.pendingCount = ''
    this._updateIndicator()
  }

  // ── Repeat last change ────────────────────────────────────────────────────
  _repeatLastChange(view) {
    if (!this._lastChange) return
    const state = view.state
    const { $head } = state.selection
    const lc = this._lastChange

    if (lc.type === 'delete_char') {
      if ($head.pos < state.doc.content.size - 1) {
        view.dispatch(state.tr.delete($head.pos, $head.pos + 1))
      }
    } else if (lc.type === 'delete_line') {
      for (let i = 0; i < lc.count; i++) this._deleteLine(view)
    } else if (lc.type === 'replace_char') {
      const { $head: h } = view.state.selection
      if (h.pos < view.state.doc.content.size - 1) {
        view.dispatch(view.state.tr.replaceWith(h.pos, h.pos + 1, state.schema.text(lc.char)))
      }
    } else if (lc.type === 'insert') {
      // Find what was inserted: common-prefix diff
      const { before, after } = lc
      let pfxLen = 0
      while (pfxLen < before.length && pfxLen < after.length && before[pfxLen] === after[pfxLen]) pfxLen++
      const sfxLen = before.length - pfxLen
      const inserted = after.slice(pfxLen, after.length - (sfxLen || 0))
      if (inserted) {
        view.dispatch(view.state.tr.insertText(inserted, view.state.selection.from))
      }
    } else if (lc.type === 'paste') {
      const pos = Math.min(view.state.selection.$head.pos + 1, view.state.doc.content.size)
      view.dispatch(view.state.tr.insertText(lc.text, pos))
    }
  }

  // ── Delete current line block ──────────────────────────────────────────────
  _deleteLine(view) {
    const state = view.state
    const { $head } = state.selection
    const nodeStart = $head.before($head.depth)
    const nodeEnd = $head.after($head.depth)
    view.dispatch(state.tr.delete(
      Math.max(0, nodeStart),
      Math.min(state.doc.content.size, nodeEnd)
    ))
  }

  // ── Find char on current line ─────────────────────────────────────────────
  _execFind(view, { dir, till, char }, count = 1) {
    const state = view.state
    const { $head } = state.selection
    const lineStart = $head.start($head.depth)
    const lineEnd = $head.end($head.depth)
    const lineText = state.doc.textBetween(lineStart, lineEnd)
    const cursorOffset = $head.pos - lineStart

    let pos = cursorOffset
    let found = 0
    if (dir === 1) {
      for (let i = cursorOffset + 1; i < lineText.length; i++) {
        if (lineText[i] === char) {
          found++
          if (found >= count) { pos = till ? i - 1 : i; break }
        }
      }
    } else {
      for (let i = cursorOffset - 1; i >= 0; i--) {
        if (lineText[i] === char) {
          found++
          if (found >= count) { pos = till ? i + 1 : i; break }
        }
      }
    }
    if (found >= count) {
      view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, lineStart + pos)))
    }
  }

  // ── Match bracket ─────────────────────────────────────────────────────────
  _matchBracket(view) {
    const state = view.state
    const { $head } = state.selection
    const lineStart = $head.start($head.depth)
    const lineEnd = $head.end($head.depth)
    const lineText = state.doc.textBetween(lineStart, lineEnd)
    const offset = $head.pos - lineStart
    const char = lineText[offset]
    if (!char) return

    const open = '([{'
    const close = ')]}'
    const pair = { '(': ')', '[': ']', '{': '}', ')': '(', ']': '[', '}': '{' }
    if (!pair[char]) return

    const isOpen = open.includes(char)
    const target = pair[char]
    let depth = 1

    if (isOpen) {
      for (let i = offset + 1; i < lineText.length; i++) {
        if (lineText[i] === char) depth++
        else if (lineText[i] === target) {
          depth--
          if (depth === 0) { view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, lineStart + i))); return }
        }
      }
    } else {
      for (let i = offset - 1; i >= 0; i--) {
        if (lineText[i] === char) depth++
        else if (lineText[i] === target) {
          depth--
          if (depth === 0) { view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, lineStart + i))); return }
        }
      }
    }
  }

  // ── Movement helpers ──────────────────────────────────────────────────────
  _move(view, dir, count = 1) {
    for (let i = 0; i < count; i++) {
      const state = view.state
      const { $head } = state.selection
      let newPos = $head.pos
      if (dir === 'left')  newPos = Math.max(0, $head.pos - 1)
      else if (dir === 'right') newPos = Math.min(state.doc.content.size, $head.pos + 1)
      else if (dir === 'down' || dir === 'up') {
        const coords = view.coordsAtPos($head.pos)
        const targetY = dir === 'down' ? coords.bottom + 4 : coords.top - 4
        const result = view.posAtCoords({ left: coords.left, top: targetY })
        if (result) newPos = result.pos
        else newPos = dir === 'down' ? state.doc.content.size : 0
      }
      view.dispatch(state.tr.setSelection(TextSelection.create(view.state.doc, newPos)))
    }
  }

  _moveWord(view, dir, count = 1) {
    for (let i = 0; i < count; i++) {
      const state = view.state
      const text = state.doc.textContent
      let pos = state.selection.$head.pos - 1
      if (dir === 'forward') {
        while (pos < text.length - 1 && /\w/.test(text[pos])) pos++
        while (pos < text.length - 1 && /\s/.test(text[pos])) pos++
      } else {
        pos--
        while (pos > 0 && /\s/.test(text[pos])) pos--
        while (pos > 0 && /\w/.test(text[pos - 1])) pos--
      }
      const docPos = Math.max(1, Math.min(state.doc.content.size - 1, pos + 1))
      view.dispatch(state.tr.setSelection(TextSelection.create(view.state.doc, docPos)))
    }
  }

  _moveWordEnd(view, count = 1) {
    for (let i = 0; i < count; i++) {
      const state = view.state
      const text = state.doc.textContent
      let pos = state.selection.$head.pos
      while (pos < text.length && /\s/.test(text[pos])) pos++
      while (pos < text.length - 1 && /\w/.test(text[pos + 1])) pos++
      const docPos = Math.min(state.doc.content.size - 1, pos + 1)
      view.dispatch(state.tr.setSelection(TextSelection.create(view.state.doc, docPos)))
    }
  }

  _moveLineStart(view, skipWhitespace) {
    const state = view.state
    const $head = state.selection.$head
    let pos = $head.start($head.depth)
    if (skipWhitespace) {
      const text = state.doc.textBetween(pos, $head.end($head.depth))
      const first = text.search(/\S/)
      if (first > 0) pos += first
    }
    view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, pos)))
  }

  _moveLineEnd(view) {
    const state = view.state
    const $head = state.selection.$head
    view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, $head.end($head.depth))))
  }

  _execCommand(cmd, view) {
    cmd = cmd.trim()
    if (cmd === 'w' || cmd === 'w!') { this._onSave(); this.setMode('normal') }
    else if (cmd === 'q' || cmd === 'q!') this.setMode('normal')
    else if (cmd === 'wq') { this._onSave(); this.setMode('normal') }
    else this.setMode('normal')
  }
}

export const vim = new VimPlugin()
```

- [ ] **Step 2: Build**

```bash
cd /Users/dghosef/editor && npx vite build 2>&1 | tail -5
```

Expected: `✓ built in` with no errors.

- [ ] **Step 3: Manual test in Tauri dev**

Run `npm run tauri dev`, enable Vim mode. Test in normal mode:

1. **Count prefix**: Type `5j` — cursor moves 5 lines down.
2. **f/F**: Type `fa` — cursor jumps to next `a` on current line. Type `F` then a char — jumps backward.
3. **t/T**: Type `ta` — cursor lands one before the `a`.
4. **;/,**: After `fa`, type `;` — repeats find next, `,` — reverses.
5. **%**: Place cursor on `(`, type `%` — jumps to matching `)`.
6. **r**: Type `ra` — replaces char under cursor with `a`.
7. **count + d**: `2dd` — deletes two consecutive lines.

- [ ] **Step 4: Commit**

```bash
cd /Users/dghosef/editor && git add src/vim.js && git commit -m "feat: vim count prefixes, f/F/t/T, %, r, c, y/p, dot-repeat"
```

---

## Task 9: Markdown live preview

**Files:**
- Modify: `src/markdown.js` (replace entirely)

- [ ] **Step 1: Replace `src/markdown.js`**

```js
// src/markdown.js — three-state markdown mode with live preview and syntax highlighting
import { defaultMarkdownParser, defaultMarkdownSerializer } from 'prosemirror-markdown'
import { marked } from 'marked'

// Configure marked: synchronous, safe renderer
marked.setOptions({ breaks: true, gfm: true })

// States: 'off' → 'split' → 'source' → 'off'
const STATES = ['off', 'split', 'source']
const LABELS = { off: 'MD', split: 'MD ⫿', source: 'MD src' }

let _state = 'off'
let _view = null
let _previewTimer = null

export function initMarkdown(view) { _view = view }
export function isMarkdownMode() { return _state !== 'off' }
export function getMarkdownState() { return _state }

export function cycleMarkdownMode() {
  const idx = STATES.indexOf(_state)
  const next = STATES[(idx + 1) % STATES.length]

  // Leaving markdown mode (any → off): parse source back into ProseMirror
  if (next === 'off') {
    const srcEl = document.getElementById('md-source-input')
    if (srcEl && _view) {
      const text = srcEl.innerText
      const doc = _parseMarkdown(text)
      if (doc) {
        const end = _view.state.doc.content.size
        _view.dispatch(_view.state.tr.replaceWith(0, end, doc.content))
      }
    }
  }

  _state = next
  _applyState()
}

// Legacy: called from editor.js for old toggle behavior
export function toggleMarkdownMode() { cycleMarkdownMode() }

export function serializeToMarkdown(state) {
  try { return defaultMarkdownSerializer.serialize(state.doc) } catch { return state.doc.textContent }
}

export function parseFromMarkdown(text) {
  return _parseMarkdown(text)
}

function _parseMarkdown(text) {
  try { return defaultMarkdownParser.parse(text) } catch { return null }
}

function _applyState() {
  const editorEl  = document.getElementById('editor')
  const pageEl    = document.getElementById('page')
  const splitEl   = document.getElementById('md-split-pane')
  const srcEl     = document.getElementById('md-source-input')
  const hlEl      = document.getElementById('md-highlight')
  const prevEl    = document.getElementById('md-preview')
  const btn       = document.getElementById('btn-markdown')

  if (btn) { btn.textContent = LABELS[_state]; btn.classList.toggle('active', _state !== 'off') }

  if (_state === 'off') {
    editorEl  && (editorEl.style.display = '')
    pageEl    && pageEl.style.removeProperty('padding')
    splitEl   && splitEl.classList.remove('visible')
    _view?.focus()
    return
  }

  // Entering a markdown state: serialize current ProseMirror doc
  const md = _view ? serializeToMarkdown(_view.state) : ''
  editorEl  && (editorEl.style.display = 'none')
  pageEl    && (pageEl.style.padding = '0')
  splitEl   && splitEl.classList.add('visible')

  if (srcEl) {
    srcEl.innerText = md
    _updateHighlight(md)
  }
  if (_state === 'split') {
    prevEl && (prevEl.style.display = 'flex')
    _renderPreview(md)
  } else {
    prevEl && (prevEl.style.display = 'none')
  }

  _setupSourceListeners()
}

// Only attach listeners once
let _listenersAttached = false
function _setupSourceListeners() {
  if (_listenersAttached) return
  _listenersAttached = true
  const srcEl = document.getElementById('md-source-input')
  const hlEl  = document.getElementById('md-highlight')
  if (!srcEl) return

  srcEl.addEventListener('input', () => {
    const text = srcEl.innerText
    _updateHighlight(text)
    clearTimeout(_previewTimer)
    _previewTimer = setTimeout(() => {
      if (_state === 'split') _renderPreview(text)
    }, 150)
  })

  srcEl.addEventListener('scroll', () => {
    if (hlEl) hlEl.scrollTop = srcEl.scrollTop
  })

  // Sync scroll the other way too
  srcEl.addEventListener('keyup', () => {
    if (hlEl) hlEl.scrollTop = srcEl.scrollTop
  })
}

function _renderPreview(md) {
  const el = document.getElementById('md-preview')
  if (el) el.innerHTML = marked.parse(md)
}

// ── Syntax highlighting overlay ───────────────────────────────────────────────

function _esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function _highlightLine(line) {
  if (/^######/.test(line)) return `<span class="md-h6">${_esc(line)}</span>`
  if (/^#####/.test(line))  return `<span class="md-h5">${_esc(line)}</span>`
  if (/^####/.test(line))   return `<span class="md-h4">${_esc(line)}</span>`
  if (/^###/.test(line))    return `<span class="md-h3">${_esc(line)}</span>`
  if (/^##/.test(line))     return `<span class="md-h2">${_esc(line)}</span>`
  if (/^#/.test(line))      return `<span class="md-h1">${_esc(line)}</span>`
  if (/^>/.test(line))      return `<span class="md-quote">${_esc(line)}</span>`
  if (/^[-*+] /.test(line) || /^\d+\. /.test(line)) return `<span class="md-list">${_esc(line)}</span>`
  if (/^```/.test(line))    return `<span class="md-fence">${_esc(line)}</span>`
  // Inline highlighting on plain lines
  let l = _esc(line)
  l = l.replace(/\*\*(.+?)\*\*/g, '<span class="md-strong">**$1**</span>')
  l = l.replace(/\*(.+?)\*/g,     '<span class="md-em">*$1*</span>')
  l = l.replace(/`(.+?)`/g,       '<span class="md-code">`$1`</span>')
  l = l.replace(/\[(.+?)\]\((.+?)\)/g, '<span class="md-link">[$1]($2)</span>')
  return l
}

function _updateHighlight(text) {
  const hlEl = document.getElementById('md-highlight')
  if (!hlEl) return
  const highlighted = text.split('\n').map(_highlightLine).join('\n')
  hlEl.innerHTML = highlighted
  // Sync scroll
  const srcEl = document.getElementById('md-source-input')
  if (srcEl) hlEl.scrollTop = srcEl.scrollTop
}
```

- [ ] **Step 2: Update the markdown button wiring in `editor.js`**

In `wireToolbar()`, replace the existing `on('btn-markdown', ...)` handler with:

```js
  on('btn-markdown', () => {
    cycleMarkdownMode()
  })
```

And update the import at the top of `editor.js`:

```js
import { initMarkdown, cycleMarkdownMode, isMarkdownMode, serializeToMarkdown, parseFromMarkdown } from './markdown.js'
```

Remove the old `toggleMarkdownMode` import if unused elsewhere.

- [ ] **Step 3: Update the `__menuCmd` markdown case**

In `setupMenuCmd`, find `case 'markdown': toggleMarkdownMode(); return` and change to:

```js
case 'markdown': cycleMarkdownMode(); return
```

- [ ] **Step 4: Build**

```bash
cd /Users/dghosef/editor && npx vite build 2>&1 | tail -5
```

Expected: `✓ built in` with no errors.

- [ ] **Step 5: Manual test**

Run `npm run tauri dev`. Test:

1. Type some text with headings (`# Heading`, `**bold**`, etc.).
2. Click "MD" button once → button shows "MD ⫿", split view appears. Left pane shows syntax-highlighted markdown source (headings in blue, bold in orange). Right pane shows rendered HTML preview.
3. Edit text in the left pane → preview updates after 150ms.
4. Click "MD ⫿" → shows "MD src", only source pane visible (no preview).
5. Click "MD src" → shows "MD", back to rich text editor with content preserved.

- [ ] **Step 6: Commit**

```bash
cd /Users/dghosef/editor && git add src/markdown.js src/editor.js && git commit -m "feat: markdown three-state toggle with live preview and syntax highlighting"
```

---

## Task 10: Final integration — wire missing connections + run all tests

**Files:**
- Modify: `src/editor.js` (final wiring cleanup)

This task ties together anything that wasn't fully wired in previous tasks.

- [ ] **Step 1: Verify `initMarkdown` is called correctly**

In `editor.js`, find where `initMarkdown` is called. It should be called in `boot()` after `buildEditor()`:

```js
  buildEditor(true)
  initMarkdown(view)   // pass the view reference
  wireToolbar()
  // ...
```

If the signature changed (from old `initMarkdown(view, onToggle)` to new `initMarkdown(view)`), confirm the call site is updated.

- [ ] **Step 2: Ensure `vim.setShortcutsCallback` is called**

In `boot()`, after `setupMenuCmd()`:

```js
  vim.setShortcutsCallback(openShortcutPanel)
```

- [ ] **Step 3: Run all unit tests**

```bash
cd /Users/dghosef/editor && npm test
```

Expected: 12 tests pass (7 readability + 5 typography).

- [ ] **Step 4: Build production bundle**

```bash
cd /Users/dghosef/editor && npx vite build 2>&1 | tail -10
```

Expected: `✓ built in` — no errors.

- [ ] **Step 5: Run Rust tests**

```bash
cd /Users/dghosef/editor && cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | tail -5
```

Expected: all existing Rust tests pass.

- [ ] **Step 6: End-to-end smoke test**

Run `npm run tauri dev`. Verify:
- [ ] Code block: type ` ``` ` at line start → code block appears; Escape exits.
- [ ] Task list: click "☑ Tasks" → task item with checkbox; click checkbox → strikethrough.
- [ ] Paragraph spacing: select paragraph, change ↑ to 12pt → visible top margin.
- [ ] Footnote: click "FN₁" → `[1]` appears at cursor, cursor jumps to footnote def.
- [ ] 2-column: click "⊳⊲ 2-Col" → two-column grid; "▐ 1-Col" → back to single.
- [ ] Smart typography: type `--` → `—`; `(c)` → `©`.
- [ ] Paste plain: copy formatted text, Cmd+Shift+V → plain text pasted.
- [ ] Selection stats: select text → status bar shows "N words selected".
- [ ] Readability: type a sentence → FK score appears after 500ms.
- [ ] Shortcut panel: Cmd+/ → panel opens; Escape closes.
- [ ] Vim count: enable vim, `3w` → 3 words forward.
- [ ] Vim f: `fa` → cursor to next `a` on line.
- [ ] Vim %: cursor on `(`, `%` → jumps to `)`.
- [ ] Vim r: `ra` → replaces char.
- [ ] Vim c: `cc` → deletes line content, enters insert mode.
- [ ] Vim yank/paste: `yy` → line yanked; `p` → pastes below.
- [ ] Vim `.` repeat: `x`, then `.` → deletes another char.
- [ ] Markdown split: click MD → split view with highlighted source + preview.

- [ ] **Step 7: Final commit**

```bash
cd /Users/dghosef/editor && git add src/editor.js && git commit -m "feat: final integration wiring for feature pack"
```
