import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

import {
  aggregateRecentEditActivity,
  buildAfterSchoolRanges,
  localDateTimeInputValue,
  nextLocalTimeAtOrAfter,
  recentEditActivity,
  reconcileTeacherNavigation,
  replayLocalDateInputValue,
  todayAtLocalTime,
  todayAtLocalTimeIso,
} from './public/edu/app-ui.js'

const teacherAppHtml = fs.readFileSync(path.join(process.cwd(), 'public', 'edu', 'app.html'), 'utf8')
const teacherStylesCss = fs.readFileSync(path.join(process.cwd(), 'public', 'edu', 'styles.css'), 'utf8')

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
    expect(teacherAppHtml).toContain('<section class="review-layout" id="review-layout">')
    expect(teacherAppHtml).toContain('<aside class="teacher-panel review-workspace" id="review-workspace" hidden>')
    expect(teacherAppHtml).toContain('id="review-close-button"')
    expect(teacherAppHtml).not.toContain('data-filter="violations"')
    expect(teacherAppHtml).toContain('id="review-highlight-date"')
    expect(teacherAppHtml).toContain('id="review-highlight-after-school-day"')
    expect(teacherAppHtml).toContain('id="review-highlight-after-school-all"')
    expect(teacherAppHtml.indexOf('Teacher mode editor')).toBeLessThan(teacherAppHtml.indexOf('Rubric and feedback'))
    expect(teacherAppHtml.indexOf('<section id="assignments-view" hidden>')).toBeGreaterThan(
      teacherAppHtml.indexOf('</section>\n\n      <!-- Assignments View -->'),
    )
  })

  it('forces hidden review workspaces to stay fully collapsed', () => {
    expect(teacherStylesCss).toContain('.review-workspace[hidden]')
    expect(teacherStylesCss).toContain('display: none !important;')
  })

  it('keeps student previews in a grid beside the review workspace', () => {
    expect(teacherStylesCss).toContain('.review-layout .student-grid')
    expect(teacherStylesCss).toContain('repeat(auto-fit, minmax(280px, 1fr))')
    expect(teacherStylesCss).toContain('.review-layout.is-review-open')
    expect(teacherStylesCss).toContain('.student-card-footer > .button')
    expect(teacherStylesCss).toContain('flex-wrap: wrap;')
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

  it('rolls a student quick extension forward to tomorrow when today has already passed', () => {
    const now = new Date(2026, 3, 27, 18, 5, 0)
    const target = nextLocalTimeAtOrAfter(15, 30, now)

    expect(localDateTimeInputValue(target)).toBe('2026-04-28T15:30')
  })

  it('formats replay-local dates and builds after-school ranges from assignment windows', () => {
    const assignment = {
      windows: [
        {
          label: 'Class block',
          days: {
            monday: true,
            tuesday: true,
            wednesday: true,
            thursday: true,
            friday: true,
            saturday: false,
            sunday: false,
          },
          start_hour: 10,
          start_minute: 0,
          end_hour: 15,
          end_minute: 15,
        },
      ],
    }
    const insertedAtMs = [
      Date.UTC(2026, 3, 27, 20, 0),
      Date.UTC(2026, 3, 28, 21, 30),
    ]

    expect(replayLocalDateInputValue(insertedAtMs[0], -240)).toBe('2026-04-27')
    expect(
      buildAfterSchoolRanges(insertedAtMs, assignment, {
        offsetMinutes: -240,
        dateInput: '2026-04-27',
      }),
    ).toEqual([
      {
        date: '2026-04-27',
        startMs: Date.UTC(2026, 3, 27, 19, 15),
        endMs: Date.UTC(2026, 3, 28, 3, 59, 59, 999),
      },
    ])
    expect(
      buildAfterSchoolRanges(insertedAtMs, assignment, {
        offsetMinutes: -240,
        allDates: true,
      }).map((range) => range.date),
    ).toEqual(['2026-04-27', '2026-04-28'])
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
