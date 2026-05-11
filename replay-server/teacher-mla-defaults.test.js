import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { buildAssignment } from './edu-schema.js'

const teacherAppHtml = fs.readFileSync(path.join(process.cwd(), 'public', 'edu', 'app.html'), 'utf8')
const teacherAppJs = fs.readFileSync(path.join(process.cwd(), 'public', 'edu', 'app.js'), 'utf8')

describe('teacher MLA assignment defaults', () => {
  it('defaults new assignments to Times New Roman, 12 point, and double spacing', () => {
    expect(buildAssignment({ editor_policy: {} }).editor_policy).toMatchObject({
      font_family: 'times',
      font_size: 12,
      line_height: 'double',
    })
    expect(buildAssignment({
      editor_policy: {
        font_family: 'arial',
        font_size: 12,
        line_height: 'relaxed',
        font_locked: false,
      },
    }).editor_policy).toMatchObject({
      font_family: 'times',
      font_size: 12,
      line_height: 'double',
    })
    expect(teacherAppHtml).toMatch(/<option value="times" selected>Times New Roman<\/option>/)
    expect(teacherAppHtml).toMatch(/<option value="double" selected>Double<\/option>/)
    expect(teacherAppJs).toContain("namedItem('editor_font_family').value = 'times'")
    expect(teacherAppJs).toContain("namedItem('editor_line_height').value = 'double'")
    expect(teacherAppJs).toContain("font_family: String(form.get('editor_font_family') || 'times')")
    expect(teacherAppJs).toContain("line_height: String(form.get('editor_line_height') || 'double')")
  })
})
