import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

import {
  applyLiveReplayUpdates,
  assignmentViewMeta,
  aggregateRecentEditActivity,
  assignmentIsOpenNow,
  buildAfterSchoolRanges,
  dashboardDeltaNeedsFullRefresh,
  deriveSessionRisk,
  isSessionActive,
  localDateTimeInputValue,
  nextLocalTimeAtOrAfter,
  recentEditActivity,
  reconcileTeacherNavigation,
  replayLocalDateInputValue,
  sessionStatusLabel,
  sessionsForAssignment,
  sortSessionsForDisplay,
  todayAtLocalTime,
  todayAtLocalTimeIso,
} from './public/edu/app-ui.js'

const teacherAppHtml = fs.readFileSync(path.join(process.cwd(), 'public', 'edu', 'app.html'), 'utf8')
const teacherStylesCss = fs.readFileSync(path.join(process.cwd(), 'public', 'edu', 'styles.css'), 'utf8')
const teacherAppJs = fs.readFileSync(path.join(process.cwd(), 'public', 'edu', 'app.js'), 'utf8')

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
    expect(teacherAppHtml).toContain('id="review-back-button"')
    expect(teacherAppHtml).not.toContain('data-filter="violations"')
    expect(teacherAppHtml).toContain('id="review-highlight-date"')
    expect(teacherAppHtml).toContain('id="review-highlight-after-school-day"')
    expect(teacherAppHtml).toContain('id="review-highlight-after-school-all"')
    expect(teacherAppHtml).toContain('id="review-comment-mode"')
    expect(teacherAppHtml).toContain('id="review-suggest-mode"')
    expect(teacherAppHtml).toContain('id="review-composer-replacement"')
    expect(teacherAppHtml).toContain('id="access-request-list"')
    expect(teacherAppHtml).toContain('id="feedback-button"')
    expect(teacherAppHtml).toContain('id="feedback-modal"')
    expect(teacherAppHtml).toContain('support@handtyped.app')
    expect(teacherAppHtml).toContain('Keep students in Handtyped until the writing window ends')
    expect(teacherAppHtml).toContain('leave Handtyped and come back on their own later')
    expect(teacherAppHtml.indexOf('Teacher mode editor')).toBeLessThan(teacherAppHtml.indexOf('Rubric and feedback'))
    expect(teacherAppHtml.indexOf('<section id="assignments-view" hidden>')).toBeGreaterThan(
      teacherAppHtml.indexOf('</section>\n\n      <!-- Assignments View -->'),
    )
  })

  it('forces hidden review workspaces to stay fully collapsed', () => {
    expect(teacherStylesCss).toContain('.review-workspace[hidden]')
    expect(teacherStylesCss).toContain('display: none !important;')
  })

  it('keeps student previews in a grid and expands review to a full page state', () => {
    expect(teacherStylesCss).toContain('.review-layout .student-grid')
    expect(teacherStylesCss).toContain('repeat(auto-fit, minmax(280px, 1fr))')
    expect(teacherStylesCss).toContain('.review-layout.is-review-open')
    expect(teacherStylesCss).toContain('#assignment-view.is-review-open #session-grid')
    expect(teacherStylesCss).toContain('.student-card-footer > .button')
    expect(teacherStylesCss).toContain('flex-wrap: wrap;')
  })

  it('refreshes the dashboard slowly by default and immediately when a review opens', () => {
    expect(teacherAppJs).toContain('const DASHBOARD_IDLE_REFRESH_MS = 15000')
    expect(teacherAppJs).toContain('const DASHBOARD_REVIEW_REFRESH_MS = 1000')
    expect(teacherAppJs).toContain('scheduleDashboardRefresh()')
    expect(teacherAppJs).toContain('await refreshDashboard()')
    expect(teacherAppJs).toContain('function activeReviewEditorElement()')
    expect(teacherAppJs).toContain('/api/edu/live-replays/')
  })

  it('renders student override names from a dropdown instead of free text input', () => {
    expect(teacherAppJs).toContain('function studentOverrideNameSelect')
    expect(teacherAppJs).toContain('<select data-override-student-name>')
    expect(teacherAppJs).not.toContain('list="assignment-student-override-suggestions"')
  })

  it('opens a support email draft from the teacher feedback form', () => {
    expect(teacherAppJs).toContain('function openFeedbackDraft')
    expect(teacherAppJs).toContain('mailto:support@handtyped.app')
    expect(teacherAppJs).toContain('feedbackContextSummary')
  })

  it('merges selected-student live replay updates without replaying the full document each poll', () => {
    expect(
      applyLiveReplayUpdates(
        {
          current_text: 'Draft one',
          document_history: [{ t: 100, pos: 0, del: '', ins: 'Draft one' }],
          url_history: [],
          last_seq: 1,
        },
        {
          last_seq: 3,
          events: [
            {
              seq: 2,
              current_text: 'Draft one\n\nDraft two',
              document_history_tail: [{ t: 300, pos: 9, del: '', ins: '\n\nDraft two' }],
              url_history_tail: [{ t: 320, url: 'https://example.com', allowed: true }],
            },
            {
              seq: 3,
              current_text: 'Draft one\n\nDraft two revised',
              document_history_tail: [{ t: 450, pos: 18, del: '', ins: ' revised' }],
              url_history_tail: [],
            },
          ],
        },
      ),
    ).toMatchObject({
      current_text: 'Draft one\n\nDraft two revised',
      last_seq: 3,
      document_history: [
        { t: 100, pos: 0, del: '', ins: 'Draft one' },
        { t: 300, pos: 9, del: '', ins: '\n\nDraft two' },
        { t: 450, pos: 18, del: '', ins: ' revised' },
      ],
      url_history: [{ t: 320, url: 'https://example.com', allowed: true }],
    })
  })

  it('keeps the lockdown rule worded in student-return language for overrides too', () => {
    expect(teacherAppHtml).toContain('name="require_lockdown" checked')
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

  it('drops stale classroom and assignment selections when dashboard data refreshes', () => {
    expect(
      reconcileTeacherNavigation({
        classrooms,
        assignments,
        selectedClassroomId: 'missing-classroom',
        selectedAssignmentId: 'essay-1',
        currentView: 'assignment',
      }),
    ).toEqual({
      selectedClassroomId: null,
      selectedAssignmentId: null,
      currentView: 'classes',
    })
  })

  it('keeps the classroom selected but clears assignments that no longer belong to it', () => {
    expect(
      reconcileTeacherNavigation({
        classrooms,
        assignments,
        selectedClassroomId: 'english-11',
        selectedAssignmentId: 'article-1',
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

  it('builds after-school ranges with a fallback hour when no classroom window exists for that replay day', () => {
    const assignment = {
      windows: [
        {
          label: 'Weekday block',
          days: {
            monday: true,
            tuesday: true,
            wednesday: true,
            thursday: true,
            friday: true,
            saturday: false,
            sunday: false,
          },
          start_hour: 9,
          start_minute: 0,
          end_hour: 14,
          end_minute: 45,
        },
      ],
    }

    expect(
      buildAfterSchoolRanges([], assignment, {
        dateInput: '2026-05-02',
        offsetMinutes: -240,
        fallbackHour: 16,
      }),
    ).toEqual([
      {
        date: '2026-05-02',
        startMs: Date.UTC(2026, 4, 2, 20, 0),
        endMs: Date.UTC(2026, 4, 3, 3, 59, 59, 999),
      },
    ])
  })

  it('deduplicates replay dates and keeps each after-school range anchored to that replay-local day', () => {
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
          start_hour: 8,
          start_minute: 30,
          end_hour: 15,
          end_minute: 0,
        },
      ],
    }
    const insertedAtMs = [
      Date.UTC(2026, 3, 27, 21, 0),
      Date.UTC(2026, 3, 27, 22, 15),
      Date.UTC(2026, 3, 28, 20, 45),
    ]

    expect(
      buildAfterSchoolRanges(insertedAtMs, assignment, {
        offsetMinutes: -240,
        allDates: true,
      }),
    ).toEqual([
      {
        date: '2026-04-27',
        startMs: Date.UTC(2026, 3, 27, 19, 0),
        endMs: Date.UTC(2026, 3, 28, 3, 59, 59, 999),
      },
      {
        date: '2026-04-28',
        startMs: Date.UTC(2026, 3, 28, 19, 0),
        endMs: Date.UTC(2026, 3, 29, 3, 59, 59, 999),
      },
    ])
  })

  it('treats active temporary access or a live window as open for whole-class access approvals', () => {
    const assignment = {
      temporary_access_until: null,
      windows: [
        {
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
          end_hour: 11,
          end_minute: 0,
        },
      ],
    }

    expect(assignmentIsOpenNow(assignment, new Date(2026, 3, 27, 10, 30))).toBe(true)
    expect(assignmentIsOpenNow(assignment, new Date(2026, 3, 27, 8, 30))).toBe(false)
    expect(
      assignmentIsOpenNow(
        {
          ...assignment,
          temporary_access_until: new Date(2026, 3, 27, 13, 0).toISOString(),
        },
        new Date(2026, 3, 27, 12, 15),
      ),
    ).toBe(true)
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

  it('treats only schedule-open, fresh sessions as active and labels focus state accordingly', () => {
    const now = Date.UTC(2026, 3, 28, 12, 0, 0)
    const activeFocused = {
      schedule_open: true,
      focused: true,
      last_activity_at: new Date(now - 5_000).toISOString(),
    }
    const activeUnfocused = {
      schedule_open: true,
      focused: false,
      last_activity_at: new Date(now - 10_000).toISOString(),
    }
    const stale = {
      schedule_open: true,
      focused: true,
      last_activity_at: new Date(now - 20_000).toISOString(),
    }
    const closed = {
      schedule_open: false,
      focused: true,
      last_activity_at: new Date(now - 1_000).toISOString(),
    }

    expect(isSessionActive(activeFocused, now)).toBe(true)
    expect(isSessionActive(activeUnfocused, now)).toBe(true)
    expect(isSessionActive(stale, now)).toBe(false)
    expect(isSessionActive(closed, now)).toBe(false)
    expect(sessionStatusLabel(activeFocused, now)).toBe('Focused')
    expect(sessionStatusLabel(activeUnfocused, now)).toBe('Unfocused')
    expect(sessionStatusLabel(stale, now)).toBe('Offline')
  })

  it('treats the freshness cutoff as inclusive and falls back to updated_at when needed', () => {
    const now = Date.UTC(2026, 3, 28, 12, 0, 0)
    const thresholdActive = {
      schedule_open: true,
      focused: true,
      updated_at: new Date(now - 15_000).toISOString(),
    }
    const thresholdStale = {
      schedule_open: true,
      focused: true,
      updated_at: new Date(now - 15_001).toISOString(),
    }

    expect(isSessionActive(thresholdActive, now)).toBe(true)
    expect(isSessionActive(thresholdStale, now)).toBe(false)
    expect(sessionStatusLabel(thresholdActive, now)).toBe('Focused')
  })

  it('filters sessions by both assignment id and classroom name', () => {
    expect(
      sessionsForAssignment(
        [
          { id: 'a', assignment_id: 'essay-1', classroom: 'English 11' },
          { id: 'b', assignment_id: 'essay-1', classroom: 'Journalism' },
          { id: 'c', assignment_id: 'essay-2', classroom: 'English 11' },
        ],
        'English 11',
        'essay-1',
      ).map((session) => session.id),
    ).toEqual(['a', 'b'])
  })

  it('derives assignment meta from the count of active sessions only', () => {
    const now = Date.UTC(2026, 3, 28, 12, 0, 0)
    const selectedAssignment = { id: 'essay-1', course: 'English 11' }
    const selectedClassroom = { id: 'english-11', name: 'English 11' }
    const sessions = [
      {
        assignment_id: 'essay-1',
        classroom: 'English 11',
        schedule_open: true,
        focused: true,
        last_activity_at: new Date(now - 3_000).toISOString(),
      },
      {
        assignment_id: 'essay-1',
        classroom: 'English 11',
        schedule_open: true,
        focused: false,
        last_activity_at: new Date(now - 4_000).toISOString(),
      },
      {
        assignment_id: 'essay-1',
        classroom: 'English 11',
        schedule_open: true,
        focused: true,
        last_activity_at: new Date(now - 30_000).toISOString(),
      },
    ]

    expect(assignmentViewMeta(selectedAssignment, selectedClassroom, sessions, now)).toBe(
      'English 11 • 2 active students',
    )
  })

  it('scores stale or suspicious sessions above calm active sessions and sorts accordingly', () => {
    const now = Date.UTC(2026, 3, 28, 12, 0, 0)
    const calm = {
      id: 'calm',
      schedule_open: true,
      focused: true,
      hid_active: true,
      current_text: 'Draft text',
      last_activity_at: new Date(now - 2_000).toISOString(),
      violations: [],
      focus_events: [],
    }
    const suspicious = {
      id: 'suspicious',
      schedule_open: true,
      focused: false,
      hid_active: false,
      current_text: '',
      last_activity_at: new Date(now - 1_000).toISOString(),
      violations: [{ kind: 'blocked_url' }],
      focus_events: [{ state: 'background' }, { state: 'focused' }, { state: 'blurred' }],
    }
    const stale = {
      id: 'stale',
      schedule_open: true,
      focused: true,
      hid_active: true,
      current_text: 'Old work',
      last_activity_at: new Date(now - 40_000).toISOString(),
      violations: [],
      focus_events: [],
    }

    const suspiciousRisk = deriveSessionRisk(suspicious, now)
    const calmRisk = deriveSessionRisk(calm, now)
    const staleRisk = deriveSessionRisk(stale, now)

    expect(suspiciousRisk.needsAttention).toBe(true)
    expect(suspiciousRisk.score).toBeGreaterThan(calmRisk.score)
    expect(staleRisk.reasons).toContain('Offline or stale')
    expect(sortSessionsForDisplay([calm, suspicious, stale], now).map((session) => session.id)).toEqual([
      'suspicious',
      'stale',
      'calm',
    ])
  })

  it('uses latest activity to break ties when students have the same risk score', () => {
    const now = Date.UTC(2026, 3, 28, 12, 0, 0)
    const calmer = {
      id: 'calmer',
      schedule_open: true,
      focused: true,
      hid_active: true,
      current_text: 'Draft text',
      last_activity_at: new Date(now - 6_000).toISOString(),
    }
    const freshest = {
      id: 'freshest',
      schedule_open: true,
      focused: true,
      hid_active: true,
      current_text: 'Draft text',
      last_activity_at: new Date(now - 2_000).toISOString(),
    }

    expect(deriveSessionRisk(calmer, now).score).toBe(0)
    expect(deriveSessionRisk(freshest, now).score).toBe(0)
    expect(sortSessionsForDisplay([calmer, freshest], now).map((session) => session.id)).toEqual([
      'freshest',
      'calmer',
    ])
  })

  it('counts explicit violation totals even when individual violation details are absent', () => {
    const now = Date.UTC(2026, 3, 28, 12, 0, 0)
    const risk = deriveSessionRisk(
      {
        schedule_open: true,
        focused: true,
        hid_active: true,
        current_text: 'Draft text',
        last_activity_at: new Date(now - 2_000).toISOString(),
        violation_count: 3,
        violations: [],
      },
      now,
    )

    expect(risk.violationCount).toBe(3)
    expect(risk.reasons).toContain('3 violations')
    expect(risk.needsAttention).toBe(true)
  })

  it('ignores malformed or too-old history entries when computing recent edits', () => {
    const activity = recentEditActivity({
      document_history: [
        { t: 10_000, pos: 0, del: '', ins: 'old' },
        { t: 'not-a-number', pos: 1, del: '', ins: 'bad' },
        { t: -50, pos: 2, del: '', ins: 'bad' },
        { t: 400_000, pos: 3, del: '', ins: 'fresh' },
      ],
    })

    expect(activity.totalEdits).toBe(1)
    expect(activity.buckets).toEqual([0, 0, 0, 0, 1])
    expect(activity.latestT).toBe(400_000)
  })

  it('derives activity buckets with custom windows without leaking older edits forward', () => {
    const activity = recentEditActivity(
      {
        document_history: [
          { t: 9_000, pos: 0, del: '', ins: 'too old' },
          { t: 70_000, pos: 1, del: '', ins: 'early' },
          { t: 115_000, pos: 2, del: '', ins: 'middle' },
          { t: 160_000, pos: 3, del: '', ins: 'late' },
          { t: 190_000, pos: 4, del: '', ins: 'latest' },
        ],
      },
      {
        windowMs: 180_000,
        bucketMs: 45_000,
      },
    )

    expect(activity.totalEdits).toBe(4)
    expect(activity.buckets).toEqual([0, 1, 1, 2])
    expect(activity.latestT).toBe(190_000)
  })

  it('keeps monitoring and assignment settings controls wired into the dashboard shell', () => {
    expect(teacherAppHtml).toContain('id="session-filter-bar"')
    expect(teacherAppHtml).toContain('data-filter="offline"')
    expect(teacherAppHtml).toContain('id="session-search-input"')
    expect(teacherAppHtml).toContain('id="overview-edits"')
    expect(teacherAppHtml).toContain('id="assignment-assigned-options"')
    expect(teacherAppHtml).not.toContain('id="assignment-assigned-extra"')
    expect(teacherAppHtml).toContain('id="assignment-student-override-list"')
    expect(teacherAppHtml).toContain('id="assignment-add-student-override"')
    expect(teacherAppHtml).not.toContain('assignment-student-override-suggestions')
    expect(teacherAppHtml).toContain('id="assignment-linked-options"')
    expect(teacherAppHtml).not.toContain('name="temporary_access_until" type="datetime-local"')
    expect(teacherAppHtml).toContain('name="allow_dictation"')
    expect(teacherAppHtml).toContain('name="require_lockdown" checked')
    expect(teacherAppHtml).toContain('name="browser_allowed_domains"')
  })

  it('requests a full refresh when delta summary counts shrink below local merged state', () => {
    expect(
      dashboardDeltaNeedsFullRefresh(
        {
          live_sessions: [{ id: 'live-1' }, { id: 'live-2' }],
          assignment_audits: [{ id: 'audit-1' }, { id: 'audit-2' }],
        },
        {
          summary: {
            live_sessions: 1,
            audits_recorded: 1,
          },
        },
      ),
    ).toBe(true)

    expect(
      dashboardDeltaNeedsFullRefresh(
        {
          live_sessions: [{ id: 'live-1' }],
          assignment_audits: [{ id: 'audit-1' }],
        },
        {
          summary: {
            live_sessions: 1,
            audits_recorded: 1,
          },
        },
      ),
    ).toBe(false)
  })
})
