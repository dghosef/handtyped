import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import { TextSelection } from 'prosemirror-state'

export const findKey = new PluginKey('find')

export const findPlugin = new Plugin({
  key: findKey,
  state: {
    init() {
      return { query: '', matches: [], index: -1, decorations: DecorationSet.empty }
    },
    apply(tr, prev) {
      const meta = tr.getMeta(findKey)
      if (meta !== undefined) {
        return buildState(tr.doc, meta.query, meta.index ?? 0)
      }
      if (tr.docChanged) {
        return buildState(tr.doc, prev.query, prev.index)
      }
      return prev
    }
  },
  props: {
    decorations(state) {
      return findKey.getState(state).decorations
    }
  }
})

function buildState(doc, query, index) {
  if (!query) return { query: '', matches: [], index: -1, decorations: DecorationSet.empty }

  const q = query.toLowerCase()
  const matches = []
  doc.descendants((node, pos) => {
    if (!node.isText) return
    const text = node.text.toLowerCase()
    let i = 0
    while ((i = text.indexOf(q, i)) !== -1) {
      matches.push({ from: pos + i, to: pos + i + q.length })
      i += q.length
    }
  })

  const safeIndex = matches.length ? Math.min(Math.max(index, 0), matches.length - 1) : -1
  const decorations = DecorationSet.create(doc, matches.map((m, i) =>
    Decoration.inline(m.from, m.to, { class: i === safeIndex ? 'find-match current' : 'find-match' })
  ))
  return { query, matches, index: safeIndex, decorations }
}

export function findSearch(view, query) {
  view.dispatch(view.state.tr.setMeta(findKey, { query, index: 0 }))
}

export function findNext(view) {
  const s = findKey.getState(view.state)
  if (!s.matches.length) return
  const next = (s.index + 1) % s.matches.length
  view.dispatch(view.state.tr.setMeta(findKey, { query: s.query, index: next }))
  scrollToMatch(view, next)
}

export function findPrev(view) {
  const s = findKey.getState(view.state)
  if (!s.matches.length) return
  const prev = (s.index - 1 + s.matches.length) % s.matches.length
  view.dispatch(view.state.tr.setMeta(findKey, { query: s.query, index: prev }))
  scrollToMatch(view, prev)
}

export function findClear(view) {
  view.dispatch(view.state.tr.setMeta(findKey, { query: '', index: -1 }))
}

function scrollToMatch(view, index) {
  const s = findKey.getState(view.state)
  const match = s.matches[index]
  if (!match) return
  const sel = TextSelection.create(view.state.doc, match.from, match.to)
  view.dispatch(view.state.tr.setSelection(sel).scrollIntoView())
}

export function getFindState(view) {
  return findKey.getState(view.state)
}

export function replaceNext(view, replacement) {
  const s = findKey.getState(view.state)
  if (!s.matches.length || s.index < 0) return
  const match = s.matches[s.index]
  if (!match) return
  const { schema } = view.state
  let tr = view.state.tr
  // Replace the text at the match range
  if (replacement) {
    tr = tr.replaceWith(match.from, match.to, schema.text(replacement))
  } else {
    tr = tr.delete(match.from, match.to)
  }
  view.dispatch(tr)
  // Re-run search to update matches
  findSearch(view, s.query)
}

export function replaceAll(view, replacement) {
  const s = findKey.getState(view.state)
  if (!s.matches.length) return
  const { schema } = view.state
  let tr = view.state.tr
  // Replace from end to start to preserve positions
  const sorted = [...s.matches].sort((a, b) => b.from - a.from)
  for (const match of sorted) {
    if (replacement) {
      tr = tr.replaceWith(match.from, match.to, schema.text(replacement))
    } else {
      tr = tr.delete(match.from, match.to)
    }
  }
  view.dispatch(tr)
  findSearch(view, s.query)
}
