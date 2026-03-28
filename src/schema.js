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
