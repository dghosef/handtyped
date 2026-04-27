import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

import {
  aggregateRecentEditActivity,
  localDateTimeInputValue,
  recentEditActivity,
  reconcileTeacherNavigation,
  todayAtLocalTime,
  todayAtLocalTimeIso,
} from './public/edu/app-ui.js'

const teacherAppHtml = fs.readFileSync(path.join(process.cwd(), 'public', 'edu', 'app.html'), 'utf8')

const classrooms = [
  { id: 'english-11', name: 'English 11' },
  { id: 'journalism', name: 'Journalism' },
]

const assignments = [
  { id: 'essay-1', classroom_id: 'english-11', title: 'Essay 1' },
  { id: 'essay-2', classroom_id: 'english-11', title: 'Essay 2' },
  { id: 'article-1', classroom_id: 'journalism', title: 'Article 1' },
]

describe('teacher navigation', () => {
  it('renders class and assignment selection as separate top-level pages', () => {
    expect(teacherAppHtml).toContain('<section id="classes-view">')
    expect(teacherAppHtml).toContain('<section id="assignments-view" hidden>')
    expect(teacherAppHtml.indexOf('<section id="assignments-view" hidden>')).toBeGreaterThan(
      teacherAppHtml.indexOf('</section>\n\n      <!-- Assignments View -->'),
    )
  })

  it('does not auto-select the first classroom or assignment on the classes page', () => {
    expect(
      reconcileTeacherNavigation({
        classrooms,
        assignments,
        selectedClassroomId: null,
        selectedAssignmentId: null,
        currentView: 'classes',
      }),
    ).toEqual({
      selectedClassroomId: null,
      selectedAssignmentId: null,
      currentView: 'classes',
    })
  })

  it('keeps a selected classroom on the assignment picker without selecting an assignment', () => {
    expect(
      reconcileTeacherNavigation({
        classrooms,
        assignments,
        selectedClassroomId: 'english-11',
        selectedAssignmentId: null,
        currentView: 'assignments',
      }),
    ).toEqual({
      selectedClassroomId: 'english-11',
      selectedAssignmentId: null,
      currentView: 'assignments',
    })
  })

  it('returns to the assignment picker when the selected assignment disappears', () => {
    expect(
      reconcileTeacherNavigation({
        classrooms,
        assignments,
        selectedClassroomId: 'english-11',
        selectedAssignmentId: 'missing',
        currentView: 'assignment',
      }),
    ).toEqual({
      selectedClassroomId: 'english-11',
      selectedAssignmentId: null,
      currentView: 'assignments',
    })
  })

  it('builds quick access targets for a selected local clock time today', () => {
    const now = new Date(2026, 3, 27, 9, 5, 0)
    const target = todayAtLocalTime(14, 30, now)

    expect(localDateTimeInputValue(target)).toBe('2026-04-27T14:30')
    expect(todayAtLocalTimeIso(14, 30, now)).toBe(target.toISOString())
  })

  it('derives recent edit activity buckets from relative document-history timestamps', () => {
    const activity = recentEditActivity({
      document_history: [
        { t: 100_000, pos: 0, del: '', ins: 'old' },
        { t: 220_000, pos: 1, del: '', ins: 'A' },
        { t: 280_000, pos: 2, del: '', ins: 'B' },
        { t: 340_000, pos: 3, del: '', ins: 'C' },
        { t: 410_000, pos: 4, del: '', ins: 'D' },
        { t: 500_000, pos: 5, del: '', ins: 'E' },
      ],
    })

    expect(activity.totalEdits).toBe(5)
    expect(activity.buckets).toEqual([1, 1, 1, 1, 1])
  })

  it('aggregates recent edit activity across visible students', () => {
    const activity = aggregateRecentEditActivity([
      {
        document_history: [
          { t: 120_000, pos: 0, del: '', ins: 'A' },
          { t: 250_000, pos: 1, del: '', ins: 'B' },
          { t: 420_000, pos: 2, del: '', ins: 'C' },
        ],
      },
      {
        document_history: [
          { t: 0, pos: 0, del: '', ins: 'old' },
          { t: 180_000, pos: 1, del: '', ins: 'A' },
          { t: 240_000, pos: 2, del: '', ins: 'B' },
        ],
      },
      {
        document_history: [],
      },
    ])

    expect(activity.totalEdits).toBe(6)
    expect(activity.activeStudents).toBe(2)
    expect(activity.buckets).toEqual([2, 0, 1, 1, 2])
  })
})
