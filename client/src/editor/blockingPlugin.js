import { Plugin } from 'prosemirror-state'
import { logEvent } from './sessionLog'

export function createBlockingPlugin(onStrike) {
  return new Plugin({
    props: {
      handleDOMEvents: {
        paste(view, event) {
          event.preventDefault()
          logEvent('paste_attempt')
          if (onStrike) onStrike('paste')
          return true
        },
        copy(view, event) {
          event.preventDefault()
          logEvent('copy_attempt')
          if (onStrike) onStrike('copy')
          return true
        },
        cut(view, event) {
          event.preventDefault()
          logEvent('cut_attempt')
          if (onStrike) onStrike('cut')
          return true
        },
        contextmenu(view, event) {
          event.preventDefault()
          return true
        }
      }
    }
  })
}
