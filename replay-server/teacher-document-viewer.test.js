import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const eduPublic = join(process.cwd(), 'public', 'edu')

describe('teacher formatted document viewer', () => {
  it('loads the shared viewer and releases it when the modal closes', () => {
    const html = readFileSync(join(eduPublic, 'app.html'), 'utf8')
    const app = readFileSync(join(eduPublic, 'app.js'), 'utf8')

    expect(html).toContain('href="/edu/document-viewer.css"')
    expect(html).toContain('id="review-view-document"')
    expect(html).toContain('id="document-modal"')
    expect(html).toContain('id="document-viewer"')
    expect(app).toContain("await import('./document-viewer.js')")
    expect(app).toMatch(/function closeDocumentViewer\(\) \{\s*openViewer\?\.destroy\(\)/)
    expect(app).toContain("if (modal.id === 'document-modal') closeDocumentViewer()")
  })

  it('ships the viewer and both page styles as static teacher assets', () => {
    const viewer = join(eduPublic, 'document-viewer.js')
    const viewerStyles = join(eduPublic, 'document-viewer.css')
    const pageStyles = join(eduPublic, 'editor-page.css')

    expect(existsSync(viewer)).toBe(true)
    expect(existsSync(viewerStyles)).toBe(true)
    expect(existsSync(pageStyles)).toBe(true)
    expect(readFileSync(viewer, 'utf8')).toContain('mountDocumentViewer')
    expect(readFileSync(viewerStyles, 'utf8')).toContain('@import "./editor-page.css"')
  })
})
