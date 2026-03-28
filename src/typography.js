import { inputRules, InputRule } from 'prosemirror-inputrules'

export const TYPOGRAPHY_RULES = [
  { id: 'em-dash', pattern: /--$/, replacement: '—' },
  { id: 'ellipsis', pattern: /\.\.\.$/, replacement: '…' },
  { id: 'copyright', pattern: /\(c\)$/i, replacement: '©' },
  { id: 'registered', pattern: /\(r\)$/i, replacement: '®' },
  { id: 'trademark', pattern: /\(tm\)$/i, replacement: '™' },
  { id: 'double-quote', pattern: /"$/, replacement: null },
  { id: 'single-quote', pattern: /'$/, replacement: null },
]

function simpleRule(pattern, replacement) {
  return new InputRule(pattern, (state, _match, start, end) =>
    state.tr.insertText(replacement, start, end)
  )
}

function quoteRule(pattern, open, close) {
  return new InputRule(pattern, (state, _match, start, end) => {
    const charBefore = start > 0 ? state.doc.textBetween(start - 1, start, '', '') : ''
    const isOpening = charBefore === '' || /[\s([{]/.test(charBefore)
    return state.tr.insertText(isOpening ? open : close, start, end)
  })
}

export function makeTypographyPlugin() {
  return inputRules({
    rules: [
      simpleRule(/--$/, '—'),
      simpleRule(/\.\.\.$/, '…'),
      simpleRule(/\(c\)$/i, '©'),
      simpleRule(/\(r\)$/i, '®'),
      simpleRule(/\(tm\)$/i, '™'),
      quoteRule(/"$/, '\u201C', '\u201D'),
      quoteRule(/'$/, '\u2018', '\u2019'),
    ],
  })
}
