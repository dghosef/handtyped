import { describe, expect, it } from 'vitest'

import { schema } from './schema.js'

describe('schema additions', () => {
  it('paragraph stores alignment, line height, and spacing attrs', () => {
    const node = schema.nodes.paragraph.create({
      align: 'justify',
      lineHeight: '2',
      spaceBefore: 12,
      spaceAfter: 6,
    }, schema.text('Hello'))

    const dom = schema.nodes.paragraph.spec.toDOM(node)
    expect(dom[0]).toBe('p')
    expect(dom[1].style).toContain('text-align: justify')
    expect(dom[1].style).toContain('line-height: 2')
    expect(dom[1].style).toContain('margin-top: 12pt')
    expect(dom[1].style).toContain('margin-bottom: 6pt')
  })

  it('supports task lists and checked task items', () => {
    const item = schema.nodes.task_item.create({ checked: true }, schema.text('Done'))
    const list = schema.nodes.task_list.create(null, [item])

    expect(list.type).toBe(schema.nodes.task_list)
    expect(list.childCount).toBe(1)
    expect(item.attrs.checked).toBe(true)
    expect(schema.nodes.task_item.spec.toDOM(item)[1]).toHaveProperty('data-checked')
  })

  it('supports footnotes and column layouts', () => {
    const ref = schema.nodes.footnote_mark.create({ number: 2 })
    const def = schema.nodes.footnote_def.create({ number: 2 }, schema.text('Footnote body'))
    const columns = schema.nodes.column_block.create(null, [
      schema.nodes.column.create(null, [schema.nodes.paragraph.create(null, schema.text('Left'))]),
      schema.nodes.column.create(null, [schema.nodes.paragraph.create(null, schema.text('Right'))]),
    ])

    expect(ref.attrs.number).toBe(2)
    expect(def.attrs.number).toBe(2)
    expect(columns.childCount).toBe(2)
    expect(columns.firstChild.type).toBe(schema.nodes.column)
  })

  it('supports code blocks and page breaks', () => {
    const code = schema.nodes.code_block.create({ language: '' }, schema.text('const x = 1'))
    const pageBreak = schema.nodes.page_break.create()

    expect(code.type).toBe(schema.nodes.code_block)
    expect(pageBreak.isAtom).toBe(true)
    expect(schema.nodes.page_break.spec.toDOM(pageBreak)[1].class).toBe('page-break')
  })
})
