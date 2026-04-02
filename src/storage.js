import { invoke } from './bridge.js'
import { schema } from './schema.js'
import { EditorState } from 'prosemirror-state'

const TEXT_ENCODER = new TextEncoder()
const TEXT_DECODER = new TextDecoder()

let _storeKeyPromise = null

function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64')
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64ToBytes(b64) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'))
  const binary = atob(b64)
  return Uint8Array.from(binary, ch => ch.charCodeAt(0))
}

async function importStoreKey(keyB64) {
  return crypto.subtle.importKey(
    'raw',
    base64ToBytes(keyB64),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  )
}

async function getStoreKey() {
  if (!_storeKeyPromise) {
    _storeKeyPromise = invoke('get_document_store_key')
      .then(importStoreKey)
      .catch(err => {
        _storeKeyPromise = null
        throw err
      })
  }
  return _storeKeyPromise
}

export function makeDocumentSnapshot(state) {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    doc: state.doc.toJSON(),
  }
}

export async function encryptDocumentSnapshot(snapshot) {
  const key = await getStoreKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = TEXT_ENCODER.encode(JSON.stringify(snapshot))
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plaintext,
  ))
  return bytesToBase64(TEXT_ENCODER.encode(JSON.stringify({
    version: 1,
    algorithm: 'AES-GCM',
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertext),
  })))
}

export async function decryptDocumentSnapshot(payloadB64) {
  if (!payloadB64) return null
  const envelope = JSON.parse(TEXT_DECODER.decode(base64ToBytes(payloadB64)))
  const key = await getStoreKey()
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(envelope.iv) },
    key,
    base64ToBytes(envelope.ciphertext),
  )
  return JSON.parse(TEXT_DECODER.decode(new Uint8Array(plaintext)))
}

export async function saveDocumentSnapshot(state) {
  const payloadB64 = await encryptDocumentSnapshot(makeDocumentSnapshot(state))
  await invoke('save_session_payload', { payloadB64 })
}

export async function loadDocumentSnapshot() {
  const payloadB64 = await invoke('load_session_payload')
  return decryptDocumentSnapshot(payloadB64)
}

export function restoreDocumentSnapshot(view, snapshot) {
  if (!snapshot?.doc) return false
  const doc = schema.nodeFromJSON(snapshot.doc)
  const nextState = EditorState.create({
    schema,
    doc,
    plugins: view.state.plugins,
  })
  view.updateState(nextState)
  return true
}
