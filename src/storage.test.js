import { beforeEach, describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { EditorState } from 'prosemirror-state'
import { schema } from './schema.js'

const invokeMock = vi.fn()

vi.mock('./bridge.js', () => ({
  invoke: (...args) => invokeMock(...args),
}))

beforeEach(() => {
  vi.resetModules()
  invokeMock.mockReset()
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true,
  })
})

describe('encrypted document storage', () => {
  it('encrypts and decrypts snapshots without leaking plaintext into the envelope', async () => {
    invokeMock.mockResolvedValueOnce(Buffer.alloc(32, 9).toString('base64'))

    const { encryptDocumentSnapshot, decryptDocumentSnapshot } = await import('./storage.js')
    const snapshot = {
      version: 1,
      savedAt: '2026-03-28T00:00:00.000Z',
      doc: schema.topNodeType.createAndFill().toJSON(),
    }

    const payloadB64 = await encryptDocumentSnapshot(snapshot)
    const decoded = Buffer.from(payloadB64, 'base64').toString('utf8')

    expect(decoded).not.toContain('savedAt')
    expect(decoded).not.toContain('2026-03-28')

    const roundTrip = await decryptDocumentSnapshot(payloadB64)
    expect(roundTrip).toEqual(snapshot)
  })

  it('saves and loads snapshots through tauri commands', async () => {
    const keyB64 = Buffer.alloc(32, 4).toString('base64')
    let storedPayload = null

    invokeMock.mockImplementation(async (command, args = {}) => {
      if (command === 'get_document_store_key') return keyB64
      if (command === 'save_session_payload') {
        storedPayload = args.payload_b64
        return null
      }
      if (command === 'load_session_payload') return storedPayload
      throw new Error(`unexpected command: ${command}`)
    })

    const { loadDocumentSnapshot, saveDocumentSnapshot } = await import('./storage.js')
    const state = EditorState.create({ schema })

    await saveDocumentSnapshot(state)
    const snapshot = await loadDocumentSnapshot()

    expect(storedPayload).toBeTruthy()
    expect(snapshot.version).toBe(1)
    expect(snapshot.doc).toEqual(state.doc.toJSON())
    expect(typeof snapshot.savedAt).toBe('string')
  })

  it('restores a saved document into an editor view', async () => {
    const { restoreDocumentSnapshot } = await import('./storage.js')
    const original = EditorState.create({ schema })
    const updatedDoc = schema.node('doc', null, [
      schema.node('heading', { level: 1 }, schema.text('Recovered')),
      schema.node('paragraph', null, schema.text('Encrypted autosave')),
    ])
    const updatedState = {
      doc: updatedDoc,
    }

    const view = {
      state: original,
      updateState: vi.fn(),
    }

    const restored = restoreDocumentSnapshot(view, {
      version: 1,
      savedAt: '2026-03-28T00:00:00.000Z',
      doc: updatedState.doc.toJSON(),
    })

    expect(restored).toBe(true)
    expect(view.updateState).toHaveBeenCalledOnce()
    expect(view.updateState.mock.calls[0][0].doc.textContent).toContain('Recovered')
  })
})
