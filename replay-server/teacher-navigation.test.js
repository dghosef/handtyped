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
  focusLossEvents,
  focusLossSummary,
  formatClockTime,
  formatWindowSummary,
  isSessionActive,
  localDateTimeInputValue,
  nextLocalTimeAtOrAfter,
  parseTimestamp,
  recentEditActivity,
  recentEditActivityCurve,
  reconcileTeacherNavigation,
  replayLocalDateInputValue,
  sessionPresenceTimestamp,
  sessionStatusLabel,
  sessionsForAssignment,
  sortSessionsForDisplay,
  studentRejoinHistorySummary,
  timeAgoLabel,
  todayAtLocalTime,
  todayAtLocalTimeIso,
  wholeClassExtensionLabel,
} from './public/edu/app-ui.js'

const teacherAppHtml = fs.readFileSync(path.join(process.cwd(), 'public', 'edu', 'app.html'), 'utf8')
const eduLandingHtml = fs.readFileSync(path.join(process.cwd(), 'public', 'edu', 'index.html'), 'utf8')
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
    expect(teacherAppHtml).toContain('<a class="teacher-brand" href="https://edu.handtyped.app">Handtyped EDU</a>')
    expect(teacherAppHtml).toContain('id="student-download-button"')
    expect(teacherAppHtml).toContain('data-student-download-auto')
    expect(teacherAppHtml).toContain('data-student-download-label="compact"')
    expect(teacherAppHtml).toContain('src="/edu/downloads.js"')
    expect(teacherAppHtml).toContain('id="student-download-apple-silicon-button"')
    expect(teacherAppHtml).toContain('data-student-download-option="macosAppleSilicon"')
    expect(teacherAppHtml).toContain('href="/downloads/Handtyped-EDU-Student-macos.dmg"')
    expect(teacherAppHtml).toContain('download="Handtyped-EDU-Student-macos.dmg"')
    expect(teacherAppHtml).toContain('id="student-download-intel-button"')
    expect(teacherAppHtml).toContain('data-student-download-option="macosIntel"')
    expect(teacherAppHtml).toContain('href="/downloads/Handtyped-EDU-Student-macos-intel.dmg"')
    expect(teacherAppHtml).toContain('download="Handtyped-EDU-Student-macos-intel.dmg"')
    expect(teacherAppHtml).toContain('id="student-download-windows-button"')
    expect(teacherAppHtml).toContain('data-student-download-option="windowsX64"')
    expect(teacherAppHtml).toContain('href="/downloads/Handtyped-EDU-Student-windows-x86_64.zip"')
    expect(teacherAppHtml).toContain('download="Handtyped-EDU-Student-windows-x86_64.zip"')
    expect(teacherAppHtml).toContain('<section id="classes-view">')
    expect(teacherAppHtml).toContain('<section id="assignments-view" hidden>')
    expect(teacherAppHtml).toContain('<section class="review-layout" id="review-layout">')
    expect(teacherAppHtml).toContain('<aside class="teacher-panel review-workspace" id="review-workspace" hidden>')
    expect(teacherAppHtml).toContain('id="review-close-button"')
    expect(teacherAppHtml).toContain('id="review-back-button"')
    expect(teacherAppHtml).not.toContain('data-filter="violations"')
    expect(teacherAppHtml).not.toContain('id="review-highlight-date"')
    expect(teacherAppHtml).not.toContain('id="review-highlight-dates"')
    expect(teacherAppHtml).not.toContain('id="review-highlight-start-time"')
    expect(teacherAppHtml).not.toContain('id="review-highlight-end-time"')
    expect(teacherAppHtml).not.toContain('name="review-highlight-weekday"')
    expect(teacherAppHtml).not.toContain('id="review-highlight-preset-after-school"')
    expect(teacherAppHtml).not.toContain('id="review-highlight-all"')
    expect(teacherAppHtml).not.toContain('id="review-realtime-debug"')
    expect(teacherAppHtml).not.toContain('TODO remove later')
    expect(teacherAppHtml).not.toContain('id="review-comment-mode"')
    expect(teacherAppHtml).toContain('id="review-add-annotation"')
    expect(teacherAppHtml).toContain('Add comment')
    expect(teacherAppHtml).not.toContain('Add to draft')
    expect(teacherAppHtml).not.toContain('id="review-suggest-mode"')
    expect(teacherAppHtml).not.toContain('id="review-composer-replacement"')
    expect(teacherAppHtml).toContain('id="review-publish-feedback"')
    expect(teacherAppHtml).toContain('Publish feedback')
    expect(teacherAppHtml).toContain('id="review-delete-feedback"')
    expect(teacherAppHtml).toContain('Delete feedback')
    expect(teacherAppJs).toContain('async function publishCurrentReviewFeedback()')
    expect(teacherAppJs).toContain('async function deleteCurrentReviewFeedback()')
    expect(teacherAppJs).toContain("method: 'DELETE'")
    expect(teacherAppJs).toContain("publish_feedback: Boolean(publishFeedback || reviewState.feedbackStatus === 'published')")
    expect(teacherAppHtml).toContain('id="access-request-list"')
    expect(teacherAppJs).toContain('data-dismiss-feedback-request')
    expect(teacherAppJs).toContain("request(`/api/edu/assignments/${assignment.id}/feedback-requests/${encodeURIComponent(entry.student_name)}`")
    expect(teacherAppHtml).toContain('id="feedback-button"')
    expect(teacherAppHtml).toContain('id="feedback-modal"')
    expect(teacherAppHtml).toContain('support@handtyped.app')
    expect(teacherAppHtml).toContain('Locked line spacing')
    expect(teacherAppHtml).toContain('Keep students in Handtyped until the writing window ends')
    expect(teacherAppHtml).toContain('The first quit is allowed; the second quit in the same window locks re-entry until approved.')
    expect(teacherAppHtml.indexOf('Teacher mode editor')).toBeLessThan(teacherAppHtml.indexOf('Rubric and feedback'))
    expect(teacherAppHtml.indexOf('<section id="assignments-view" hidden>')).toBeGreaterThan(
      teacherAppHtml.indexOf('</section>\n\n      <!-- Assignments View -->'),
    )
  })

  it('exposes the notarized student app download on the edu landing page', () => {
    expect(eduLandingHtml).toContain('id="student-download-button"')
    expect(eduLandingHtml).toContain('data-student-download-auto')
    expect(eduLandingHtml).toContain('Download student app')
    expect(eduLandingHtml).toContain('src="/edu/downloads.js"')
    expect(eduLandingHtml).toContain('<h1>Handtyped EDU</h1>')
    expect(eduLandingHtml).not.toContain('Work in progress')
    expect(eduLandingHtml).not.toContain('currently under active development')
    expect(eduLandingHtml).toContain('id="student-download-apple-silicon-button"')
    expect(eduLandingHtml).toContain('data-student-download-option="macosAppleSilicon"')
    expect(eduLandingHtml).toContain('Mac with Apple chip (M1 or newer, late 2020+)')
    expect(eduLandingHtml).toContain('href="/downloads/Handtyped-EDU-Student-macos.dmg"')
    expect(eduLandingHtml).toContain('download="Handtyped-EDU-Student-macos.dmg"')
    expect(eduLandingHtml).toContain('id="student-download-intel-button"')
    expect(eduLandingHtml).toContain('data-student-download-option="macosIntel"')
    expect(eduLandingHtml).toContain('Intel Mac (2019 or earlier, or some 2020 models)')
    expect(eduLandingHtml).toContain('href="/downloads/Handtyped-EDU-Student-macos-intel.dmg"')
    expect(eduLandingHtml).toContain('download="Handtyped-EDU-Student-macos-intel.dmg"')
    expect(eduLandingHtml).toContain('id="student-download-windows-button"')
    expect(eduLandingHtml).toContain('data-student-download-option="windowsX64"')
    expect(eduLandingHtml).toContain('Windows x86-64')
    expect(eduLandingHtml).toContain('href="/downloads/Handtyped-EDU-Student-windows-x86_64.zip"')
    expect(eduLandingHtml).toContain('download="Handtyped-EDU-Student-windows-x86_64.zip"')
  })

  it('temporarily exposes realtime diagnostics and keeps review draft spacing stable', () => {
    expect(teacherAppJs).toContain('function renderRealtimeDebug')
    expect(teacherAppJs).toContain('function markRealtimeEvent')
    expect(teacherAppJs).toContain("markFallbackRefresh('assignment-view')")
    expect(teacherAppHtml).toContain('id="assignment-monitoring-status"')
    expect(teacherAppJs).toContain('function renderAssignmentMonitoringStatus')
    expect(teacherAppJs).toContain('function retryRealtimeConnection')
    expect(teacherAppJs).toContain("teacherSession?.tenant_id || 'default'")
    expect(teacherAppJs).toContain('Monitoring: fallback refresh used')
    expect(teacherAppJs).toContain('Monitoring: realtime updates active')
    expect(teacherStylesCss).toContain('.monitoring-path-status[data-tone="fallback"]')
    expect(teacherAppJs).not.toContain('TODO remove later:')
    expect(teacherAppJs).toContain('let reviewDraftSurfaceHtml')
    expect(teacherAppJs).toContain('if (reviewDraftSurfaceHtml !== nextHtml)')
    expect(teacherAppJs).toContain('function textWithPreservedParagraphSpacing')
    expect(teacherAppJs).toContain('function handtypedMarkdownDisplayModel')
    expect(teacherAppJs).toContain("replace(/\\n{2,}/g, '\\n')")
    expect(teacherStylesCss).toContain('.review-draft-surface .review-highlight')
    expect(teacherStylesCss).toContain('.review-draft-heading-h1')
    expect(teacherStylesCss).toContain('line-height: inherit;')
  })

  it('removes the teacher-facing replay highlight-by-time interface', () => {
    expect(teacherAppHtml).not.toContain('class="review-time-tools"')
    expect(teacherAppHtml).not.toContain('id="review-highlight-start-time"')
    expect(teacherAppHtml).not.toContain('id="review-highlight-end-time"')
    expect(teacherAppHtml).not.toContain('id="review-highlight-date"')
    expect(teacherAppHtml).not.toContain('id="review-highlight-dates"')
    expect(teacherAppHtml).not.toContain('name="review-highlight-weekday"')
    expect(teacherAppHtml).not.toContain('id="review-highlight-preset-window"')
    expect(teacherAppHtml).not.toContain('id="review-highlight-preset-after-school"')
    expect(teacherAppHtml).not.toContain('id="review-highlight-preset-evening"')
    expect(teacherAppHtml).not.toContain('id="review-highlight-preset-weekdays"')
    expect(teacherAppHtml).not.toContain('id="review-highlight-all"')
    expect(teacherAppHtml).not.toContain('id="review-highlight-clear"')
    expect(teacherAppHtml).not.toContain('id="review-highlight-meta"')
    expect(teacherStylesCss).not.toContain('.review-time-field-compact')
    expect(teacherAppJs).toContain('sourceIndex')
    expect(teacherAppJs).toContain('function replayTeacherDateInputValue')
    expect(teacherAppJs).toContain('function annotateReplayHistoryWithEventTimes')
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
    expect(teacherStylesCss).toContain('#assignment-view.is-review-open #back-to-assignments-button')
    expect(teacherStylesCss).toContain('display: none;')
    expect(teacherStylesCss).toContain('.student-card-footer > .button')
    expect(teacherStylesCss).toContain('flex-wrap: wrap;')
    expect(teacherStylesCss).toContain('.review-highlight-pending')
  })

  it('keeps recent browser URLs visually compact while preserving the full URL', () => {
    expect(teacherAppJs).toContain('title="${escapeHtml(url)}"')
    expect(teacherStylesCss).toContain('.student-urls li')
    expect(teacherStylesCss).toContain('text-overflow: ellipsis;')
    expect(teacherStylesCss).toContain('white-space: nowrap;')
    expect(teacherStylesCss).toContain('.student-card {\n  border: 1px solid var(--line);')
    expect(teacherStylesCss).toContain('min-width: 0;')
  })

  it('hides internal blank placeholder pages from recent browser URLs', () => {
    expect(teacherAppJs).toContain('function isDisplayableBrowserUrl(url)')
    expect(teacherAppJs).toContain("return normalized !== 'about:blank'")
    expect(teacherAppJs).toContain('.filter((item) => isDisplayableBrowserUrl(item?.url))')
  })

  it('shows reference document names instead of internal document URLs', () => {
    expect(teacherAppJs).toContain('function browserVisitDisplayLabel(item, assignment = getSelectedAssignment())')
    expect(teacherAppJs).toContain('handtyped:\\/\\/reference-document\\/')
    expect(teacherAppJs).toContain('(assignment?.reference_documents || []).find((entry) => entry.id === referenceDocumentId)')
    expect(teacherAppJs).toContain("return document?.title || 'Reference PDF'")
    expect(teacherAppJs).toContain('${escapeHtml(label)}')
    expect(teacherAppJs).toContain('<ul class="student-urls">${summarizeUrls(session, selectedAssignment)}</ul>')
  })

  it('refreshes the dashboard promptly by default and faster when a review opens', () => {
    expect(teacherAppJs).toContain('const DASHBOARD_IDLE_REFRESH_MS = 15000')
    expect(teacherAppJs).toContain('const DASHBOARD_REVIEW_REFRESH_MS = 5000')
    expect(teacherAppJs).toContain('const ASSIGNMENT_VIEW_SUMMARY_REFRESH_MS = 5000')
    expect(teacherAppJs).toContain('const TEACHER_STATUS_TICK_MS = 1000')
    expect(teacherAppJs).toContain('const REALTIME_EVENT_STALE_FALLBACK_MS = 7000')
    expect(teacherAppJs).toContain('function renderReviewWorkspaceMeta')
    expect(teacherAppJs).toContain('function refreshStudentCardLiveLabels')
    expect(teacherAppJs).toContain("const MISSING_SELECTED_REVIEW_SESSION = Symbol('missing-selected-review-session')")
    expect(teacherAppJs).toContain('scheduleDashboardRefresh()')
    expect(teacherAppJs).toContain('statusTickTimer = window.setInterval(() => {')
    expect(teacherAppJs).toContain('refreshStudentCardLiveLabels()')
    expect(teacherAppJs).toContain('refreshStudentEditActivityGraphs()')
    expect(teacherAppJs).toContain('data-student-last-activity')
    expect(teacherAppJs).toContain('data-student-status-badge')
    expect(teacherAppJs).toContain('selectedAssignmentId = button.dataset.assignmentId\n      clearSelectedReviewSession()\n      showAssignmentView()')
    expect(teacherAppJs).toContain('await refreshDashboard()')
    expect(teacherAppJs).toContain('function syncRealtimeSubscriptions()')
    expect(teacherAppJs).toContain("new EventSource(url)")
    expect(teacherAppJs).toContain('function shouldUseFallbackRefresh()')
    expect(teacherAppJs).toContain('function realtimeStatusIsHealthy(label)')
    expect(teacherAppJs).toContain('function realtimeHasRecentEvent(label, eventName)')
    expect(teacherAppJs).toContain("return !realtimeHasRecentEvent('assignment', 'assignment') || !realtimeStatusIsHealthy('replay')")
    expect(teacherAppJs).toContain("return !realtimeHasRecentEvent('assignment', 'assignment')")
    expect(teacherAppJs).toContain("return !realtimeHasRecentEvent('teacher', 'dashboard')")
    expect(teacherAppJs).toContain('if (!document.hidden && shouldUseFallbackRefresh())')
    expect(teacherAppJs).toContain("source.addEventListener('access-request'")
    expect(teacherAppJs).toContain('function handleRealtimeAccessRequest')
    expect(teacherAppJs).toContain('accessRequest: handleRealtimeAccessRequest')
    expect(teacherAppJs).toContain('function activeReviewEditorElement()')
    expect(teacherAppJs).toContain('/api/edu/live-replays/')
    expect(teacherAppJs).toContain('function isFullDashboardPayload(payload)')
    expect(teacherAppJs).toContain('if (isFullDashboardPayload(delta)) {')
    expect(teacherAppJs).toContain("if (error.message === 'Not found') {")
    expect(teacherAppJs).toContain('clearSelectedReviewSession()')
    expect(teacherAppJs).toContain('function preserveSelectedReviewSessionInSummaries')
    expect(teacherAppJs).toContain('function normalizedPendingReviewSelection')
    expect(teacherAppJs).toContain("classes.push('review-highlight-pending')")
    expect(teacherAppJs).toContain('selectedAnnotationId = nextAnnotation.id')
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

  it('locks assignment submission while create or save is already in flight', () => {
    expect(teacherAppJs).toContain('let assignmentFormSubmitting = false')
    expect(teacherAppJs).toContain('function setAssignmentFormSubmitting(isSubmitting, isEditing = false)')
    expect(teacherAppJs).toContain("if (assignmentFormSubmitting) {")
    expect(teacherAppJs).toContain("'Creating...'")
    expect(teacherAppJs).toContain("'Saving...'")
  })

  it('shows classroom creation progress on the submit button while the request is in flight', () => {
    expect(teacherAppHtml).toContain('id="classroom-form-submit"')
    expect(teacherAppJs).toContain('let classroomFormSubmitting = false')
    expect(teacherAppJs).toContain('function setClassroomFormSubmitting(isSubmitting)')
    expect(teacherAppJs).toContain("if (classroomFormSubmitting) {")
    expect(teacherAppJs).toContain("'Creating...'")
    expect(teacherAppJs).toContain("'Create class'")
  })

  it('populates the edit assignment modal through named form controls', () => {
    expect(teacherAppJs).toContain("const field = (name) => form.elements.namedItem(name)")
    expect(teacherAppJs).toContain("field('title').value = assignment.title || ''")
    expect(teacherAppJs).not.toContain('form.title.value')
  })

  it('hides image permissions while image support is paused', () => {
    expect(teacherAppHtml).toContain('type="hidden" name="images_allowed"')
    expect(teacherAppHtml).not.toContain('Allow images in the document')
    expect(teacherAppJs).toContain('images_allowed: false')
    expect(teacherAppJs).not.toContain("['images_allowed', 'Allow images']")
    expect(teacherAppJs).not.toContain('data-override-policy="images_allowed"')
  })

  it('loads the selected assignment before opening the edit modal when state is stale', () => {
    expect(teacherAppJs).toContain('async function selectedAssignmentForEditing()')
    expect(teacherAppJs).toContain("request(`/api/edu/assignments/${encodeURIComponent(selectedAssignmentId)}`)")
    expect(teacherAppJs).toContain('upsertAssignmentInState(fetched)')
    expect(teacherAppJs).toContain('const assignment = await selectedAssignmentForEditing()')
    expect(teacherAppJs).toContain('Could not load assignment:')
  })

  it('uses extend for reopening instead of offering an indefinite reopen button', () => {
    expect(teacherAppJs).toContain('data-close-student-access')
    expect(teacherAppJs).toContain("const closeAccessButton = accessRevoked")
    expect(teacherAppJs).toContain("'Extend this student'")
    expect(teacherAppJs).toContain("'Extending…'")
    expect(teacherAppJs).not.toContain('data-toggle-student-access')
    expect(teacherAppJs).not.toContain('toggleSelectedAssignmentStudentAccess')
    expect(teacherAppJs).not.toContain("'Reopen access'")
  })

  it('saves inline draft comments immediately when the teacher clicks add comment', () => {
    expect(teacherAppJs).toContain('async function addReviewAnnotation()')
    expect(teacherAppJs).toContain('const composerOpen = Boolean(selection)')
    expect(teacherAppJs).toContain('await flushReviewSave()')
    expect(teacherAppJs).toContain('Could not save comment:')
  })

  it('closes the review workspace before waiting on pending saves', () => {
    const source = teacherAppJs.match(/async function closeReviewWorkspace\(\) \{[\s\S]*?\n\}/)?.[0] || ''
    expect(source).toContain('const pendingSave = saveReviewSnapshotBeforeSwitch()')
    expect(source).toContain('clearSelectedReviewSession()')
    expect(source).toContain('renderStudentCards()')
    expect(source).not.toContain('await flushReviewSave()')
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
              document_history_tail: [{ t: 300, pos: 9, del: '', ins: '\n\nDraft two', absolute_wall_ms: 1_700_000_000_300 }],
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
        { t: 300, pos: 9, del: '', ins: '\n\nDraft two', absolute_wall_ms: 1_700_000_000_300 },
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
    expect(teacherAppHtml).toContain('id="quick-extend-date" type="date"')
    expect(teacherAppHtml).toContain('id="quick-extend-time" type="time"')
    expect(teacherAppJs).toContain('function defaultAccessExtensionTarget')
    expect(teacherAppJs).toContain('now.getTime() + 60 * 60 * 1000')
    expect(teacherAppJs).toContain('function selectedExtensionTarget')
    expect(teacherAppJs).toContain('data-access-request-date')
    expect(teacherAppJs).toContain('Choose an extension date and time after the current time.')
  })

  it('formats saved ISO temporary access timestamps for assignment edit forms', () => {
    expect(localDateTimeInputValue('2026-04-27T18:45:00.000Z')).toMatch(/^2026-04-27T\d{2}:45$/)
    expect(localDateTimeInputValue('not-a-date')).toBe('')
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

  it('indicates active whole-class extensions on assignment cards and assignment meta', () => {
    const now = new Date(2026, 3, 27, 12, 15)
    const extendedAssignment = {
      id: 'extended-assignment',
      classroom_id: 'english-11',
      title: 'Extended essay',
      course: 'English 11',
      temporary_access_until: new Date(2026, 3, 27, 13, 0).toISOString(),
    }

    expect(wholeClassExtensionLabel(extendedAssignment, now)).toBe('Class extended until 1:00 PM')
    expect(assignmentViewMeta(extendedAssignment, classrooms[0], [], now.getTime())).toContain(
      'Class extended until 1:00 PM',
    )
    expect(teacherAppJs).toContain('function wholeClassExtensionBadge')
    expect(teacherAppJs).toContain('assignment-card-badges')
    expect(teacherStylesCss).toContain('.assignment-card-badges')
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

  it('keeps the full edit graph shape when refreshed sessions also carry recent edit counts', () => {
    const activity = recentEditActivity(
      {
        recent_edit_count: 25,
        document_history: [
          { t: 100_000, pos: 0, del: '', ins: 'A' },
          { t: 130_000, pos: 1, del: '', ins: 'B' },
          { t: 190_000, pos: 2, del: '', ins: 'C' },
        ],
      },
      {
        windowMs: 120_000,
        bucketMs: 30_000,
      },
    )

    expect(activity.totalEdits).toBe(3)
    expect(activity.buckets).toEqual([1, 1, 0, 1])
  })

  it('renders edit activity as binary 5-second edit windows', () => {
    const activity = recentEditActivityCurve(
      {
        last_activity_at: new Date(120_000).toISOString(),
        document_history: [
          { t: 100_000, absolute_wall_ms: 100_000, pos: 0, del: '', ins: 'A' },
          { t: 102_000, absolute_wall_ms: 102_000, pos: 1, del: '', ins: 'B' },
          { t: 110_000, absolute_wall_ms: 110_000, pos: 1, del: '', ins: 'B' },
        ],
      },
      {
        windowMs: 20_000,
        sampleMs: 5_000,
        nowMs: 120_000,
      },
    )

    expect(activity.totalEdits).toBe(3)
    expect(activity.points).toEqual([1, 0, 1, 0])
  })

  it('anchors edit activity windows to clock intervals so bars do not flicker between renders', () => {
    const session = {
      document_history: [
        { t: 1, absolute_wall_ms: 101_000, pos: 0, del: '', ins: 'A' },
        { t: 2, absolute_wall_ms: 106_000, pos: 1, del: '', ins: 'B' },
        { t: 3, absolute_wall_ms: 111_000, pos: 2, del: '', ins: 'C' },
      ],
    }
    const first = recentEditActivityCurve(session, {
      windowMs: 30_000,
      sampleMs: 5_000,
      nowMs: 113_000,
    })
    const second = recentEditActivityCurve(session, {
      windowMs: 30_000,
      sampleMs: 5_000,
      nowMs: 114_500,
    })
    const nextInterval = recentEditActivityCurve(session, {
      windowMs: 30_000,
      sampleMs: 5_000,
      nowMs: 115_500,
    })

    expect(first.points).toEqual(second.points)
    expect(first.points).toEqual([0, 0, 0, 1, 1, 1])
    expect(nextInterval.points).toEqual([0, 0, 1, 1, 1, 0])
  })

  it('uses per-entry absolute edit times even when older history entries only have relative times', () => {
    const session = {
      last_activity_at: new Date(115_000).toISOString(),
      document_history: [
        { t: 1, pos: 0, del: '', ins: 'old relative' },
        { t: 2, absolute_wall_ms: 101_000, pos: 0, del: '', ins: 'A' },
        { t: 3, absolute_wall_ms: 106_000, pos: 1, del: '', ins: 'B' },
        { t: 4, absolute_wall_ms: 111_000, pos: 2, del: '', ins: 'C' },
      ],
    }

    const activity = recentEditActivityCurve(session, {
      windowMs: 30_000,
      sampleMs: 5_000,
      nowMs: 114_500,
    })

    expect(activity.points).toEqual([0, 0, 0, 1, 1, 1])
  })

  it('counts only text insertion, deletion, and formatting document history entries', () => {
    const now = Date.parse('2026-05-04T15:00:00.000Z')
    const activity = recentEditActivityCurve(
      {
        last_activity_at: new Date(now).toISOString(),
        document_history: [
          { t: 100, absolute_wall_ms: now - 18_000, selection: { from: 0, to: 0 } },
          { t: 200, absolute_wall_ms: now - 14_000, pos: 0, del: '', ins: 'A' },
          { t: 300, absolute_wall_ms: now - 9_000, pos: 1, del: 'A', ins: '' },
          { t: 400, absolute_wall_ms: now - 4_000, pos: 1, del: '', ins: '', marks: { bold: true } },
          { t: 500, absolute_wall_ms: now - 2_000, url: 'https://example.com' },
        ],
      },
      {
        windowMs: 20_000,
        sampleMs: 5_000,
        nowMs: now,
      },
    )

    expect(activity.totalEdits).toBe(3)
    expect(activity.points).toEqual([0, 1, 1, 1])
  })

  it('uses wall-clock time for edit activity so offline edits do not appear recent', () => {
    const now = Date.parse('2026-05-04T15:00:00.000Z')
    const activity = recentEditActivityCurve(
      {
        last_activity_at: new Date(now - 19 * 60_000).toISOString(),
        document_history: [
          { t: 100_000, pos: 0, del: '', ins: 'A' },
          { t: 110_000, pos: 1, del: '', ins: 'B' },
          { t: 140_000, pos: 2, del: '', ins: 'C' },
        ],
      },
      {
        windowMs: 5 * 60_000,
        sampleMs: 5_000,
        nowMs: now,
      },
    )

    expect(activity.totalEdits).toBe(0)
    expect(activity.points.every((point) => point === 0)).toBe(true)
  })

  it('uses explicit edit wall times when available for recent edit activity', () => {
    const now = Date.parse('2026-05-04T15:00:00.000Z')
    const activity = recentEditActivityCurve(
      {
        last_activity_at: new Date(now - 19 * 60_000).toISOString(),
        document_history: [
          { t: 100_000, absolute_wall_ms: now - 20_000, pos: 0, del: '', ins: 'A' },
          { t: 110_000, absolute_wall_ms: now - 10_000, pos: 1, del: '', ins: 'B' },
          { t: 140_000, absolute_wall_ms: now - 19 * 60_000, pos: 2, del: '', ins: 'old' },
        ],
      },
      {
        windowMs: 5 * 60_000,
        sampleMs: 5_000,
        nowMs: now,
      },
    )

    expect(activity.totalEdits).toBe(2)
    expect(Math.max(...activity.points)).toBeGreaterThan(0)
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

  it('treats only schedule-open, fresh presence heartbeats as active and labels focus state accordingly', () => {
    const now = Date.UTC(2026, 3, 28, 12, 0, 0)
    const activeFocused = {
      schedule_open: true,
      focused: true,
      updated_at: new Date(now - 5_000).toISOString(),
      last_activity_at: new Date(now - 60_000).toISOString(),
    }
    const activeUnfocused = {
      schedule_open: true,
      focused: false,
      updated_at: new Date(now - 3_000).toISOString(),
      last_activity_at: new Date(now - 60_000).toISOString(),
    }
    const stale = {
      schedule_open: true,
      focused: true,
      updated_at: new Date(now - 16_000).toISOString(),
    }
    const closed = {
      schedule_open: false,
      focused: true,
      updated_at: new Date(now - 1_000).toISOString(),
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

  it('falls back to last edit time only when no presence heartbeat exists', () => {
    const now = Date.UTC(2026, 3, 28, 12, 0, 0)
    expect(
      isSessionActive(
        {
          schedule_open: true,
          focused: true,
          last_activity_at: new Date(now - 5_000).toISOString(),
        },
        now,
      ),
    ).toBe(true)
  })

  it('uses the freshest presence timestamp to avoid active-status flicker', () => {
    const now = Date.UTC(2026, 3, 28, 12, 0, 0)
    const session = {
      schedule_open: true,
      focused: true,
      updated_at: new Date(now - 20_000).toISOString(),
      last_activity_at: new Date(now - 1_000).toISOString(),
    }

    expect(sessionPresenceTimestamp(session)).toBe(now - 1_000)
    expect(isSessionActive(session, now)).toBe(true)
    expect(sessionStatusLabel(session, now)).toBe('Focused')
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

  it('summarizes student quit and rejoin history with visible timestamps', () => {
    const summary = studentRejoinHistorySummary(
      {
        student_rejoin_history: {
          'ada lovelace': {
            student_name: 'Ada Lovelace',
            close_count: 2,
            events: [
              { type: 'opened', at: '2026-05-07T19:00:00.000Z' },
              { type: 'closed', at: '2026-05-07T19:05:00.000Z' },
              { type: 'opened', at: '2026-05-07T19:08:00.000Z' },
              { type: 'locked', at: '2026-05-07T19:12:00.000Z' },
            ],
          },
        },
      },
      'Ada Lovelace',
    )

    expect(summary).toContain('2 quits this window')
    expect(summary).toContain('left at')
    expect(summary).toContain('locked at')
    expect(summary).toMatch(/May 7/)
  })

  it('summarizes every focus loss with visible timestamps', () => {
    const losses = focusLossEvents({
      focus_events: [
        { t: Date.UTC(2026, 4, 7, 21, 14, 25), state: 'focused' },
        {
          t: Date.UTC(2026, 4, 7, 21, 14, 28),
          state: 'blurred',
          reason: 'Attempted to leave the window with the Windows key.',
        },
        {
          t: Date.UTC(2026, 4, 7, 21, 15, 2),
          state: 'hidden',
          reason: 'Attempted to leave fullscreen.',
        },
        { t: Date.UTC(2026, 4, 7, 21, 15, 30), state: 'foreground' },
      ],
    })

    expect(losses).toHaveLength(2)
    expect(losses.map((event) => event.state)).toEqual(['blurred', 'hidden'])
    expect(focusLossSummary({ focus_events: losses })).toMatch(/2 focus losses/)
    expect(focusLossSummary({ focus_events: losses })).toMatch(/May 7/)
    expect(focusLossSummary({ focus_events: losses })).toMatch(/Windows key/)
    expect(focusLossSummary({ focus_events: losses })).toMatch(/leave fullscreen/)
  })

  it('includes lockout reasons in rejoin history summaries', () => {
    const summary = studentRejoinHistorySummary(
      {
        student_rejoin_history: {
          'ada lovelace': {
            student_name: 'Ada Lovelace',
            close_count: 0,
            entry_count: 1,
            events: [
              {
                type: 'focus_lost_locked',
                at: '2026-05-07T21:14:28.000Z',
                reason: 'Attempted to leave the window with the Windows key + G.',
              },
            ],
          },
        },
      },
      'Ada Lovelace',
    )

    expect(summary).toMatch(/Windows key \+ G/)
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
    expect(teacherAppHtml).not.toContain('id="session-filter-bar"')
    expect(teacherAppHtml).not.toContain('data-filter="offline"')
    expect(teacherAppHtml).not.toContain('id="session-search-input"')
    expect(teacherAppHtml).not.toContain('id="monitoring-overview"')
    expect(teacherAppHtml).not.toContain('id="overview-edits"')
    expect(teacherAppHtml).toContain('id="assignment-assigned-options"')
    expect(teacherAppHtml).not.toContain('id="assignment-assigned-extra"')
    expect(teacherAppHtml).toContain('id="assignment-student-override-list"')
    expect(teacherAppHtml).toContain('id="assignment-add-student-override"')
    expect(teacherAppHtml).not.toContain('assignment-student-override-suggestions')
    expect(teacherAppHtml).toContain('id="assignment-linked-options"')
    expect(teacherAppHtml).toContain('id="assignment-reference-upload"')
    expect(teacherAppHtml).toContain('id="assignment-reference-document-list"')
    expect(teacherAppHtml).not.toContain('name="temporary_access_until" type="datetime-local"')
    expect(teacherAppHtml).toContain('name="allow_dictation"')
    expect(teacherAppHtml).toContain('name="require_lockdown" checked')
    expect(teacherAppHtml).toContain('name="browser_allowed_domains"')
    expect(teacherAppHtml).not.toContain('name="browser_home_url"')
    expect(teacherAppHtml).not.toContain('Home URL')
    expect(teacherAppJs).not.toContain('data-override-home-enabled')
    expect(teacherAppJs).not.toContain('normalizeHttpUrlInput')
    expect(teacherAppJs).not.toContain('placeholder="https://example.com"')
    expect(teacherAppHtml).toContain('name="editor_font_size"')
    expect(teacherAppHtml).toContain('name="starter_document"')
    expect(teacherAppHtml).toContain('id="starter-document-toolbar"')
    expect(teacherAppHtml).toContain('data-starter-command="bold" aria-pressed="false"')
    expect(teacherAppHtml).not.toContain('data-starter-command="clear"')
    expect(teacherAppJs).toContain('function populateAssignmentFontSizeOptions()')
    expect(teacherAppJs).toContain('function updateStarterDocumentToolbarState()')
    expect(teacherAppJs).toContain("button.setAttribute('aria-pressed', isActive ? 'true' : 'false')")
    expect(teacherAppJs).toContain("button.addEventListener('mousedown', (event) => {")
    expect(teacherStylesCss).toContain('.teacher-editor-toolbar .button[aria-pressed="true"]')
    expect(teacherAppJs).toContain('STUDENT_OVERRIDE_FONT_SIZE_OPTIONS')
    expect(teacherAppJs).toContain('reviewSessionHasAccess(')
    expect(teacherAppJs).toContain('handleReferenceDocumentUpload(')
  })

  it('wires edit-frequency controls globally and renders one graph per student card', () => {
    expect(teacherAppHtml).toContain('id="assignment-edit-activity-panel"')
    expect(teacherAppHtml).not.toContain('id="edit-activity-graph"')
    expect(teacherAppHtml).toContain('data-edit-activity-window="5"')
    expect(teacherAppHtml).toContain('data-edit-activity-window="60"')
    expect(teacherAppHtml).not.toContain('id="edit-activity-custom-minutes"')
    expect(teacherAppHtml).not.toContain('edit-activity-custom')
    expect(teacherAppHtml).not.toContain('id="edit-activity-x-axis"')
    expect(teacherAppHtml).not.toContain('id="edit-activity-y-axis"')
    expect(teacherAppJs).toContain('renderStudentEditActivity(session)')
    expect(teacherAppJs).toContain('${renderStudentEditActivity(session)}')
    expect(teacherAppHtml).toContain('id="review-edit-activity"')
    expect(teacherAppJs).toContain('renderReviewEditActivity(session)')
    expect(teacherAppJs).toContain('recentEditActivityCurve,')
    expect(teacherAppJs).toContain('nowMs: Date.now()')
    expect(teacherAppJs).toContain('function refreshStudentEditActivityGraphs()')
    expect(teacherAppJs).toContain("querySelectorAll('.student-card[data-review-session]')")
    expect(teacherAppJs).toContain("activityBlock.outerHTML = renderStudentEditActivity(session)")
    expect(teacherAppJs).toContain('return 2500')
    expect(teacherAppJs).toContain('return 30000')
    expect(teacherAppJs).toContain('windowMs <= 5 * 60_000')
    expect(teacherAppJs).toContain('editActivitySampleLabel(sampleMs)')
    expect(teacherAppJs).toContain('${editActivitySampleLabel(sampleMs)} edit/no-edit windows')
    expect(teacherAppJs).toContain('function editActivityDensityClass(pointCount)')
    expect(teacherAppJs).toContain('edit-activity-graph${editActivityDensityClass(activity.points.length)}')
    expect(teacherAppJs).toContain('minmax(0, 1fr)')
    expect(teacherAppJs).toContain('editActivityStartLabel()')
    expect(teacherAppJs).not.toContain('editActivityCustomMinutes')
    expect(teacherStylesCss).not.toContain('.edit-activity-custom')
    expect(teacherStylesCss).toContain('.assignment-edit-activity-panel')
    expect(teacherStylesCss).toContain('.student-card .edit-activity-block')
    expect(teacherStylesCss).toContain('.review-edit-activity-card')
  })

  it('opens draft review from the student card instead of a separate review button', () => {
    expect(teacherAppJs).not.toContain('Review draft')
    expect(teacherAppJs).not.toContain('data-open-review=')
    expect(teacherAppJs).toContain("await selectReviewSession(card.dataset.reviewSession)")
    expect(teacherAppJs).toContain("if (event.target.closest('button, a')) return")
  })

  it('keeps the edit-frequency graph compact and shows zero-count samples as baseline marks', () => {
    expect(teacherAppJs).toContain("count > 0 ? '100%' : '3px'")
    expect(teacherAppJs).toContain("count === 0 ? ' is-zero' : ''")
    expect(teacherStylesCss).toContain('grid-template-columns: 1fr;')
    expect(teacherStylesCss).toContain('justify-content: space-between;')
    expect(teacherStylesCss).not.toContain('writing-mode: vertical-rl;')
    expect(teacherStylesCss).not.toContain('transform: rotate(180deg);')
    expect(teacherStylesCss).toContain('.edit-activity-bar.is-zero')
    expect(teacherStylesCss).not.toContain('.edit-activity-axis-y')
    expect(teacherStylesCss).toContain('.edit-activity-graph.is-dense')
    expect(teacherStylesCss).toContain('overflow: hidden;')
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

  it('treats missing delta summaries or missing local state as non-fatal no-refresh cases', () => {
    expect(dashboardDeltaNeedsFullRefresh(null, { summary: { live_sessions: 1, audits_recorded: 1 } })).toBe(false)
    expect(dashboardDeltaNeedsFullRefresh({ live_sessions: [], assignment_audits: [] }, null)).toBe(false)
    expect(dashboardDeltaNeedsFullRefresh({ live_sessions: [], assignment_audits: [] }, { summary: null })).toBe(
      false,
    )
  })

  it('parses timestamps defensively and formats human-relative age labels', () => {
    const now = Date.UTC(2026, 3, 28, 12, 0, 0)
    expect(parseTimestamp('2026-04-28T11:59:55.000Z')).toBe(Date.UTC(2026, 3, 28, 11, 59, 55))
    expect(parseTimestamp('not-a-time')).toBeNull()
    expect(timeAgoLabel('2026-04-28T12:00:00.000Z', now)).toBe('just now')
    expect(timeAgoLabel('2026-04-28T11:59:59.000Z', now)).toBe('1s ago')
    expect(timeAgoLabel('2026-04-28T11:59:57.000Z', now)).toBe('3s ago')
    expect(timeAgoLabel('2026-04-28T11:59:20.000Z', now)).toBe('40s ago')
    expect(timeAgoLabel('2026-04-28T11:15:00.000Z', now)).toBe('45m ago')
    expect(timeAgoLabel('2026-04-28T09:00:00.000Z', now)).toBe('3h ago')
    expect(timeAgoLabel('2026-04-25T12:00:00.000Z', now)).toBe('3d ago')
    expect(timeAgoLabel('bad input', now)).toBe('Unknown')
  })

  it('summarizes assignment windows for both configured and missing schedules', () => {
    expect(
      formatWindowSummary({
        windows: [
          {
            days: {
              monday: true,
              tuesday: true,
              wednesday: false,
              thursday: true,
              friday: false,
              saturday: false,
              sunday: false,
            },
            start_hour: 8,
            start_minute: 5,
            end_hour: 14,
            end_minute: 30,
            end_date: '2026-05-01',
          },
        ],
      }),
    ).toBe('mon, tue, thu • 8:05 AM–2:30 PM until 2026-05-01')
    expect(formatClockTime(0, 5)).toBe('12:05 AM')
    expect(formatClockTime(12, 0)).toBe('12:00 PM')
    expect(formatClockTime(23, 59)).toBe('11:59 PM')
    expect(formatWindowSummary({ windows: [] })).toBe('No writing window configured.')
  })

  it('supports overnight writing windows that cross midnight', () => {
    const overnight = {
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
          start_hour: 22,
          start_minute: 0,
          end_hour: 1,
          end_minute: 30,
        },
      ],
    }

    expect(assignmentIsOpenNow(overnight, new Date(2026, 3, 27, 22, 15))).toBe(true)
    expect(assignmentIsOpenNow(overnight, new Date(2026, 3, 28, 0, 45))).toBe(true)
    expect(assignmentIsOpenNow(overnight, new Date(2026, 3, 28, 2, 0))).toBe(false)
  })

  it('keeps active-session meta empty when no classroom or assignment is selected', () => {
    expect(assignmentViewMeta(null, classrooms[0], [])).toBe('')
    expect(assignmentViewMeta(assignments[0], null, [])).toBe('')
  })

  it('accepts precomputed recent edit counts when sessions already carry bucket totals', () => {
    const activity = aggregateRecentEditActivity([
      { recent_edit_count: 5 },
      { recent_edit_count: 0 },
      { recent_edit_count: 3 },
    ])

    expect(activity.totalEdits).toBe(8)
    expect(activity.activeStudents).toBe(2)
    expect(activity.buckets).toEqual([8, 0, 0, 0, 0])
  })

  it('merges empty replay update polls without losing accumulated history', () => {
    expect(
      applyLiveReplayUpdates(
        {
          current_text: 'Existing draft',
          document_history: [{ t: 100, pos: 0, del: '', ins: 'Existing draft' }],
          url_history: [{ t: 120, url: 'https://example.org', allowed: true }],
          last_seq: 2,
        },
        {
          last_seq: 2,
          events: [],
          current_url: 'https://example.org',
          current_url_title: 'Example',
        },
      ),
    ).toMatchObject({
      current_text: 'Existing draft',
      document_history: [{ t: 100, pos: 0, del: '', ins: 'Existing draft' }],
      url_history: [{ t: 120, url: 'https://example.org', allowed: true }],
      current_url: 'https://example.org',
      current_url_title: 'Example',
      last_seq: 2,
    })
  })

  it('normalizes unknown navigation views back to the classes page', () => {
    expect(
      reconcileTeacherNavigation({
        classrooms,
        assignments,
        selectedClassroomId: 'english-11',
        selectedAssignmentId: 'essay-1',
        currentView: 'mystery-view',
      }),
    ).toEqual({
      selectedClassroomId: 'english-11',
      selectedAssignmentId: null,
      currentView: 'classes',
    })
  })

  it('counts blank current text as a small risk even for otherwise active sessions', () => {
    const now = Date.UTC(2026, 3, 28, 12, 0, 0)
    const risk = deriveSessionRisk(
      {
        schedule_open: true,
        focused: true,
        hid_active: true,
        current_text: '',
        last_activity_at: new Date(now - 2_000).toISOString(),
        violations: [],
        focus_events: [],
      },
      now,
    )

    expect(risk.score).toBeGreaterThan(0)
    expect(risk.reasons).toContain('No current writing')
    expect(risk.needsAttention).toBe(false)
  })

  it('counts non-focused foreground transitions as focus leaves in risk summaries', () => {
    const now = Date.UTC(2026, 3, 28, 12, 0, 0)
    const risk = deriveSessionRisk(
      {
        schedule_open: true,
        focused: false,
        hid_active: true,
        current_text: 'Draft text',
        last_activity_at: new Date(now - 2_000).toISOString(),
        violations: [],
        focus_events: [{ state: 'foreground' }, { state: 'background' }, { state: 'blurred' }],
      },
      now,
    )

    expect(risk.focusLeaves).toBe(2)
    expect(risk.reasons).toContain('2 focus changes')
    expect(risk.needsAttention).toBe(true)
  })

  it('treats sessions without parseable activity timestamps as offline', () => {
    const now = Date.UTC(2026, 3, 28, 12, 0, 0)
    const session = {
      schedule_open: true,
      focused: true,
      last_activity_at: 'definitely-not-a-timestamp',
      updated_at: '',
    }

    expect(isSessionActive(session, now)).toBe(false)
    expect(sessionStatusLabel(session, now)).toBe('Offline')
  })
})
