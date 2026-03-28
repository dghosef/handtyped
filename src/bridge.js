import { invoke as tauriInvoke } from '@tauri-apps/api/core'

export function invoke(command, args = {}) {
  return tauriInvoke(command, args)
}
