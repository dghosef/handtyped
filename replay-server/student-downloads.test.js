import { describe, expect, it } from 'vitest'
import { Window } from 'happy-dom'
import { readFileSync } from 'node:fs'

import {
  applyStudentDownloadTarget,
  detectMacTargetFromRenderer,
  detectStudentDownloadTarget,
  setupStudentDownloadLinks,
  STUDENT_DOWNLOADS,
  STUDENT_RELEASE_ID,
} from './public/edu/downloads.js'

const studentReleaseManifest = JSON.parse(
  readFileSync(new URL('./public/downloads/student-release.json', import.meta.url), 'utf8'),
)

describe('student download auto-detection', () => {
  it('detects Windows from the user agent', async () => {
    const target = await detectStudentDownloadTarget({
      navigator: {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        platform: 'Win32',
      },
    })

    expect(target.key).toBe('windowsX64')
    expect(target.confidence).toBe('high')
  })

  it('detects Mac architecture from User-Agent Client Hints when available', async () => {
    const appleSilicon = await detectStudentDownloadTarget({
      navigator: {
        userAgentData: {
          platform: 'macOS',
          getHighEntropyValues: async () => ({ platform: 'macOS', architecture: 'arm' }),
        },
      },
    })
    const intel = await detectStudentDownloadTarget({
      navigator: {
        userAgentData: {
          platform: 'macOS',
          getHighEntropyValues: async () => ({ platform: 'macOS', architecture: 'x86' }),
        },
      },
    })

    expect(appleSilicon.key).toBe('macosAppleSilicon')
    expect(intel.key).toBe('macosIntel')
  })

  it('uses explicit WebGL renderer hints for Safari-style Mac detection', () => {
    expect(detectMacTargetFromRenderer('Apple M2')).toMatchObject({
      key: 'macosAppleSilicon',
      confidence: 'medium',
    })
    expect(detectMacTargetFromRenderer('Intel Iris OpenGL Engine')).toMatchObject({
      key: 'macosIntel',
      confidence: 'medium',
    })
    expect(detectMacTargetFromRenderer('AMD Radeon Pro 5500M')).toMatchObject({
      key: 'macosIntel',
      confidence: 'medium',
    })
    expect(detectMacTargetFromRenderer('Apple GPU')).toBeNull()
  })

  it('defaults Safari-style MacIntel user agents to the Intel download when architecture is ambiguous', async () => {
    const target = await detectStudentDownloadTarget({
      navigator: {
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',
        platform: 'MacIntel',
      },
      webglRenderer: 'Apple GPU',
    })

    expect(target).toMatchObject({
      key: 'macosIntel',
      confidence: 'low',
      source: 'user-agent',
    })
  })

  it('rewrites the primary download link and marks the selected fallback', () => {
    const window = new Window()
    window.document.body.innerHTML = `
      <a data-student-download-auto href="/downloads/Handtyped-EDU-Student-macos.dmg" download="Handtyped-EDU-Student-macos.dmg">Download student app</a>
      <a data-student-download-option="macosAppleSilicon"></a>
      <a data-student-download-option="macosIntel"></a>
      <a data-student-download-option="windowsX64"></a>
      <div data-student-download-note></div>
    `

    const download = applyStudentDownloadTarget(window.document, {
      key: 'windowsX64',
      confidence: 'high',
    })

    const button = window.document.querySelector('[data-student-download-auto]')
    expect(download.filename).toBe('Handtyped-EDU-Student-windows-x86_64.zip')
    expect(button.getAttribute('href')).toBe(`/downloads/Handtyped-EDU-Student-windows-x86_64.zip?v=${STUDENT_RELEASE_ID}`)
    expect(button.getAttribute('download')).toBe('Handtyped-EDU-Student-windows-x86_64.zip')
    expect(button.dataset.releaseId).toBe(STUDENT_RELEASE_ID)
    expect(button.textContent).toBe('Download for Windows')
    const windowsOption = window.document.querySelector('[data-student-download-option="windowsX64"]')
    expect(windowsOption.getAttribute('aria-current')).toBe('true')
    expect(windowsOption.getAttribute('href')).toBe(`/downloads/Handtyped-EDU-Student-windows-x86_64.zip?v=${STUDENT_RELEASE_ID}`)
    expect(window.document.querySelector('[data-student-download-note]').textContent).toContain(`release ${STUDENT_RELEASE_ID}`)
  })

  it('sets compact labels in the teacher header', async () => {
    const window = new Window()
    window.document.body.innerHTML = `
      <a data-student-download-auto data-student-download-label="compact" href="/downloads/Handtyped-EDU-Student-macos.dmg" download="Handtyped-EDU-Student-macos.dmg">Student app</a>
    `

    await setupStudentDownloadLinks(window.document, {
      navigator: {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        platform: 'Win32',
      },
    })

    expect(window.document.querySelector('[data-student-download-auto]').textContent).toBe('Student app (Windows)')
  })

  it('keeps the published release manifest aligned with the download links', () => {
    expect(studentReleaseManifest.studentReleaseId).toBe(STUDENT_RELEASE_ID)
    for (const [key, download] of Object.entries(STUDENT_DOWNLOADS)) {
      expect(studentReleaseManifest.downloads[key]).toMatchObject({
        href: download.href,
        filename: download.filename,
      })
      expect(studentReleaseManifest.downloads[key].sha256).toMatch(/^[a-f0-9]{64}$/)
    }
  })
})
