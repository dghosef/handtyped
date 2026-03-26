import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { history, undo, redo } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import { baseKeymap } from 'prosemirror-commands'
import { schema } from 'prosemirror-schema-basic'
import { logTransaction } from './sessionLog'
import { createBlockingPlugin } from './blockingPlugin'

function extractContext(doc, pos, windowSize = 50) {
  const fullText = doc.textContent
  const before = fullText.slice(Math.max(0, pos - windowSize), pos)
  const after = fullText.slice(pos, pos + windowSize)
  return { before, after }
}

export function createEditor(domNode, onTransaction, onStrike) {
  const state = EditorState.create({
    schema,
    plugins: [
      history(),
      keymap({ 'Mod-z': undo, 'Mod-y': redo, 'Mod-Shift-z': redo }),
      keymap(baseKeymap),
      createBlockingPlugin(onStrike),
    ]
  })

  const view = new EditorView(domNode, {
    state,
    dispatchTransaction(tr) {
      if (tr.docChanged) {
        const oldDoc = view.state.doc
        tr.steps.forEach((step) => {
          const stepMap = step.getMap()
          stepMap.forEach((oldStart, oldEnd, newStart, newEnd) => {
            const deletedText = oldDoc.textBetween(oldStart, oldEnd, '\n', '')
            // For the inserted text we look at what the step produces
            const insertedText = tr.doc.textBetween(newStart, newEnd, '\n', '')
            const { before, after } = extractContext(oldDoc, oldStart)
            logTransaction({
              position: newStart,
              deletedText,
              insertedText,
              surroundingBefore: before,
              surroundingAfter: after
            })
          })
        })
        if (onTransaction) onTransaction(tr)
      }
      const newState = view.state.apply(tr)
      view.updateState(newState)
    }
  })

  return view
}
