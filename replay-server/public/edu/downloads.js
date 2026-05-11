export const STUDENT_RELEASE_ID = '0.1.1-20260511.2108-windows-key-recapture-signed'

export const STUDENT_DOWNLOADS = Object.freeze({
  macosAppleSilicon: Object.freeze({
    key: 'macosAppleSilicon',
    href: '/downloads/Handtyped-EDU-Student-macos.dmg',
    filename: 'Handtyped-EDU-Student-macos.dmg',
    label: 'Download for Apple Silicon Mac',
    compactLabel: 'Student app (Apple Silicon)',
    detectedLabel: 'Apple Silicon Mac',
  }),
  macosIntel: Object.freeze({
    key: 'macosIntel',
    href: '/downloads/Handtyped-EDU-Student-macos-intel.dmg',
    filename: 'Handtyped-EDU-Student-macos-intel.dmg',
    label: 'Download for Intel Mac',
    compactLabel: 'Student app (Intel Mac)',
    detectedLabel: 'Intel Mac',
  }),
  windowsX64: Object.freeze({
    key: 'windowsX64',
    href: '/downloads/Handtyped-EDU-Student-windows-x86_64.zip',
    filename: 'Handtyped-EDU-Student-windows-x86_64.zip',
    label: 'Download for Windows',
    compactLabel: 'Student app (Windows)',
    detectedLabel: 'Windows',
  }),
})

const DEFAULT_DOWNLOAD_KEY = 'macosAppleSilicon'

function normalize(value) {
  return String(value || '').toLowerCase()
}

function downloadFor(key) {
  return STUDENT_DOWNLOADS[key] || STUDENT_DOWNLOADS[DEFAULT_DOWNLOAD_KEY]
}

function versionedHref(download) {
  return `${download.href}?v=${encodeURIComponent(STUDENT_RELEASE_ID)}`
}

function targetFromMacArchitecture(architecture, confidence = 'high') {
  const normalized = normalize(architecture)
  if (normalized.includes('arm') || normalized.includes('aarch64')) {
    return { key: 'macosAppleSilicon', confidence, source: 'architecture' }
  }
  if (normalized.includes('x86') || normalized.includes('x64') || normalized.includes('amd64')) {
    return { key: 'macosIntel', confidence, source: 'architecture' }
  }
  return null
}

export function detectMacTargetFromRenderer(renderer) {
  const normalized = normalize(renderer)
  if (!normalized) return null
  if (/\bapple silicon\b|\bapple m\d/.test(normalized) && !/intel|amd|radeon|nvidia/.test(normalized)) {
    return { key: 'macosAppleSilicon', confidence: 'medium', source: 'webgl-renderer' }
  }
  if (/intel|amd|radeon|nvidia/.test(normalized)) {
    return { key: 'macosIntel', confidence: 'medium', source: 'webgl-renderer' }
  }
  return null
}

function readWebglRenderer(documentLike) {
  if (!documentLike?.createElement) return ''
  const canvas = documentLike.createElement('canvas')
  const gl = canvas.getContext?.('webgl') || canvas.getContext?.('experimental-webgl')
  if (!gl?.getParameter) return ''
  const debugInfo = gl.getExtension?.('WEBGL_debug_renderer_info')
  if (debugInfo?.UNMASKED_RENDERER_WEBGL) {
    return gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || ''
  }
  return gl.getParameter(gl.RENDERER) || ''
}

async function targetFromUserAgentData(userAgentData) {
  if (!userAgentData) return null
  const lowPlatform = normalize(userAgentData.platform)
  let platform = lowPlatform
  let architecture = ''
  if (typeof userAgentData.getHighEntropyValues === 'function') {
    try {
      const values = await userAgentData.getHighEntropyValues(['platform', 'architecture', 'bitness'])
      platform = normalize(values.platform || platform)
      architecture = normalize(values.architecture || values.bitness)
    } catch {
      platform = lowPlatform
    }
  }

  if (platform.includes('windows')) {
    return { key: 'windowsX64', confidence: 'high', source: 'user-agent-client-hints' }
  }
  if (platform.includes('mac')) {
    return targetFromMacArchitecture(architecture) || null
  }
  return null
}

function targetFromUserAgent(navigatorLike) {
  const userAgent = normalize(navigatorLike?.userAgent)
  const platform = normalize(navigatorLike?.platform)
  const combined = `${userAgent} ${platform}`
  if (combined.includes('windows')) {
    return { key: 'windowsX64', confidence: 'high', source: 'user-agent' }
  }
  if (platform.includes('macintel')) {
    return { key: 'macosIntel', confidence: 'low', source: 'user-agent' }
  }
  if (combined.includes('macintosh') || combined.includes('mac os') || combined.includes('macintel')) {
    return { key: DEFAULT_DOWNLOAD_KEY, confidence: 'low', source: 'user-agent' }
  }
  return null
}

export async function detectStudentDownloadTarget(environment = globalThis) {
  const navigatorLike = environment.navigator || globalThis.navigator || {}
  const clientHintsTarget = await targetFromUserAgentData(navigatorLike.userAgentData)
  if (clientHintsTarget) return clientHintsTarget

  const userAgentTarget = targetFromUserAgent(navigatorLike)
  if (userAgentTarget?.key === 'windowsX64') return userAgentTarget

  if (userAgentTarget?.key === 'macosAppleSilicon' || userAgentTarget?.key === 'macosIntel') {
    const renderer = typeof environment.webglRenderer === 'function'
      ? environment.webglRenderer()
      : environment.webglRenderer || readWebglRenderer(environment.document || globalThis.document)
    return detectMacTargetFromRenderer(renderer) || userAgentTarget
  }

  return { key: DEFAULT_DOWNLOAD_KEY, confidence: 'fallback', source: 'default' }
}

function labelFor(download, mode) {
  if (mode === 'compact') return download.compactLabel
  return download.label
}

export function applyStudentDownloadTarget(root, target) {
  const download = downloadFor(target?.key)
  root.querySelectorAll('[data-student-download-auto]').forEach((button) => {
    button.setAttribute('href', versionedHref(download))
    button.setAttribute('download', download.filename)
    button.textContent = labelFor(download, button.dataset.studentDownloadLabel)
    button.dataset.detectedPlatform = download.key
    button.dataset.detectedConfidence = target?.confidence || 'fallback'
    button.dataset.releaseId = STUDENT_RELEASE_ID
  })

  root.querySelectorAll('[data-student-download-option]').forEach((option) => {
    const optionDownload = downloadFor(option.dataset.studentDownloadOption)
    option.setAttribute('href', versionedHref(optionDownload))
    option.setAttribute('download', optionDownload.filename)
    option.dataset.releaseId = STUDENT_RELEASE_ID
    option.setAttribute('aria-current', option.dataset.studentDownloadOption === download.key ? 'true' : 'false')
  })

  root.querySelectorAll('[data-student-download-note]').forEach((note) => {
    if (target?.confidence === 'low' || target?.confidence === 'fallback') {
      note.textContent = `We picked the default Mac download. Choose another version if this is not your computer. Student app release ${STUDENT_RELEASE_ID}.`
    } else {
      note.textContent = `Detected ${download.detectedLabel}. Other versions are still available. Student app release ${STUDENT_RELEASE_ID}.`
    }
  })

  return download
}

export async function setupStudentDownloadLinks(root = document, environment = globalThis) {
  const target = await detectStudentDownloadTarget(environment)
  return applyStudentDownloadTarget(root, target)
}

if (typeof document !== 'undefined') {
  setupStudentDownloadLinks().catch(() => {
    applyStudentDownloadTarget(document, { key: DEFAULT_DOWNLOAD_KEY, confidence: 'fallback' })
  })
}
