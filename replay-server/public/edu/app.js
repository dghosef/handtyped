import {
  applyLiveReplayUpdates,
  aggregateRecentEditActivity,
  assignmentIsOpenNow,
  assignmentViewMeta,
  buildAfterSchoolRanges,
  dashboardDeltaNeedsFullRefresh,
  deriveSessionRisk,
  formatWindowSummary,
  isSessionActive,
  localDateTimeInputValue,
  nextLocalTimeAtOrAfter,
  reconcileTeacherNavigation,
  replayLocalDateInputValue,
  sessionStatusLabel,
  sessionsForAssignment,
  sortSessionsForDisplay,
  timeAgoLabel,
  todayAtLocalTime,
  todayAtLocalTimeIso,
} from './app-ui.js'
import { buildAttributedDocument, latestTextFromHistory } from '../replay-view.js'

const DASHBOARD_IDLE_REFRESH_MS = 15000
const DASHBOARD_REVIEW_REFRESH_MS = 5000
const ASSIGNMENT_VIEW_SUMMARY_REFRESH_MS = 5000
const ASSIGNMENT_VIEW_AUDIT_REFRESH_MS = 30000
const TEACHER_STATUS_TICK_MS = 1000
const REVIEW_SYNC_RETRY_MS = 2000
const COMMENT_CONTEXT_WINDOW = 24

let dashboardState = null
let refreshTimer = null
let statusTickTimer = null
let refreshInFlight = false
let refreshQueued = false
let selectedClassroomId = null
let selectedAssignmentId = null
let currentView = 'classes'
let teacherSession = null
let dashboardCursor = ''
let sessionFilter = 'all'
let sessionSearch = ''
const pendingStudentAccessActions = new Map()
const pendingAccessRequestApprovals = new Set()
let assignmentStudentOverrideDrafts = []
let assignmentReferenceDocuments = []
let selectedReviewSessionId = null
let selectedReviewSessionSnapshot = null
let reviewWorkspaceOpen = false
let reviewState = null
let reviewSaveTimer = null
let reviewSaveInFlight = false
let reviewSavePromise = null
let selectedAnnotationId = null
const reviewReplayCache = new Map()
const MISSING_SELECTED_REVIEW_SESSION = Symbol('missing-selected-review-session')
let dashboardVisibilityRefreshBound = false
let lastAssignmentViewSummaryRefreshAt = 0
let lastAssignmentViewAuditRefreshAt = 0
let teacherRealtime = null
let assignmentRealtime = null
let replayRealtime = null
let teacherRealtimeKey = ''
let assignmentRealtimeKey = ''
let replayRealtimeKey = ''
let assignmentFormSubmitting = false

const elements = {
  authPanel: document.getElementById('auth-panel'),
  feedbackButton: document.getElementById('feedback-button'),
  logoutButton: document.getElementById('logout-button'),
  classesView: document.getElementById('classes-view'),
  assignmentsView: document.getElementById('assignments-view'),
  assignmentView: document.getElementById('assignment-view'),
  classroomStage: document.getElementById('classroom-stage'),
  classroomGrid: document.getElementById('classroom-grid'),
  assignmentStage: document.getElementById('assignment-stage'),
  assignmentStageTitle: document.getElementById('assignment-stage-title'),
  assignmentStageMeta: document.getElementById('assignment-stage-meta'),
  assignmentGrid: document.getElementById('assignment-grid'),
  sessionGrid: document.getElementById('session-grid'),
  sessionFilterBar: document.getElementById('session-filter-bar'),
  sessionSearchInput: document.getElementById('session-search-input'),
  newClassroomButton: document.getElementById('new-classroom-button'),
  deleteClassroomButton: document.getElementById('delete-classroom-button'),
  newAssignmentButton: document.getElementById('new-assignment-button'),
  editAssignmentButton: document.getElementById('edit-assignment-button'),
  deleteAssignmentButton: document.getElementById('delete-assignment-button'),
  quickExtendButton: document.getElementById('quick-extend-button'),
  quickExtendTime: document.getElementById('quick-extend-time'),
  quickExtendStatus: document.getElementById('quick-extend-status'),
  classroomForm: document.getElementById('classroom-form'),
  assignmentForm: document.getElementById('assignment-form'),
  assignmentIdInput: document.getElementById('assignment-id-input'),
  assignmentModalLabel: document.getElementById('assignment-modal-label'),
  assignmentModalTitle: document.getElementById('assignment-modal-title'),
  assignmentFormSubmit: document.getElementById('assignment-form-submit'),
  assignmentFormCancel: document.getElementById('assignment-form-cancel'),
  assignmentAssignedOptions: document.getElementById('assignment-assigned-options'),
  assignmentStudentOverrideList: document.getElementById('assignment-student-override-list'),
  assignmentAddStudentOverride: document.getElementById('assignment-add-student-override'),
  assignmentLinkedOptions: document.getElementById('assignment-linked-options'),
  assignmentReferenceUpload: document.getElementById('assignment-reference-upload'),
  assignmentReferenceDocumentList: document.getElementById('assignment-reference-document-list'),
  assignmentRubricList: document.getElementById('assignment-rubric-list'),
  assignmentAddRubric: document.getElementById('assignment-add-rubric'),
  starterDocumentToolbar: document.getElementById('starter-document-toolbar'),
  starterDocumentEditor: document.getElementById('starter-document-editor'),
  starterDocumentField: document.getElementById('starter-document-field'),
  classroomModal: document.getElementById('classroom-modal'),
  assignmentModal: document.getElementById('assignment-modal'),
  feedbackModal: document.getElementById('feedback-modal'),
  feedbackForm: document.getElementById('feedback-form'),
  feedbackFormCancel: document.getElementById('feedback-form-cancel'),
  modalCloseButtons: document.querySelectorAll('[data-close-modal]'),
  overviewStudents: document.getElementById('overview-students'),
  overviewStudentsMeta: document.getElementById('overview-students-meta'),
  overviewAttention: document.getElementById('overview-attention'),
  overviewAttentionMeta: document.getElementById('overview-attention-meta'),
  overviewUnfocused: document.getElementById('overview-unfocused'),
  overviewUnfocusedMeta: document.getElementById('overview-unfocused-meta'),
  overviewOffline: document.getElementById('overview-offline'),
  overviewOfflineMeta: document.getElementById('overview-offline-meta'),
  overviewEdits: document.getElementById('overview-edits'),
  overviewEditsMeta: document.getElementById('overview-edits-meta'),
  accessRequestList: document.getElementById('access-request-list'),
  reviewWorkspace: document.getElementById('review-workspace'),
  reviewLayout: document.getElementById('review-layout'),
  reviewWorkspaceEmpty: document.getElementById('review-workspace-empty'),
  reviewWorkspaceContent: document.getElementById('review-workspace-content'),
  reviewWorkspaceTitle: document.getElementById('review-workspace-title'),
  reviewWorkspaceMeta: document.getElementById('review-workspace-meta'),
  reviewActivityStatus: document.getElementById('review-activity-status'),
  reviewSyncStatus: document.getElementById('review-sync-status'),
  reviewGradeLabel: document.getElementById('review-grade-label'),
  reviewGradeScore: document.getElementById('review-grade-score'),
  reviewRubricTotal: document.getElementById('review-rubric-total'),
  reviewRubricList: document.getElementById('review-rubric-list'),
  reviewTeacherComment: document.getElementById('review-teacher-comment'),
  reviewReturned: document.getElementById('review-returned'),
  reviewDraftMeta: document.getElementById('review-draft-meta'),
  reviewDraftSurface: document.getElementById('review-draft-surface'),
  reviewSelectionCount: document.getElementById('review-selection-count'),
  reviewSelectionPanel: document.getElementById('review-selection-panel'),
  reviewSelectionQuote: document.getElementById('review-selection-quote'),
  reviewHighlightDate: document.getElementById('review-highlight-date'),
  reviewHighlightAfterSchoolDay: document.getElementById('review-highlight-after-school-day'),
  reviewHighlightAfterSchoolAll: document.getElementById('review-highlight-after-school-all'),
  reviewHighlightClear: document.getElementById('review-highlight-clear'),
  reviewHighlightMeta: document.getElementById('review-highlight-meta'),
  reviewCommentMode: document.getElementById('review-comment-mode'),
  reviewComposer: document.getElementById('review-composer'),
  reviewComposerLabel: document.getElementById('review-composer-label'),
  reviewComposerNote: document.getElementById('review-composer-note'),
  reviewAddAnnotation: document.getElementById('review-add-annotation'),
  reviewCancelAnnotation: document.getElementById('review-cancel-annotation'),
  reviewAnnotationMeta: document.getElementById('review-annotation-meta'),
  reviewAnnotationList: document.getElementById('review-annotation-list'),
  reviewCloseButton: document.getElementById('review-close-button'),
  reviewBackButton: document.getElementById('review-back-button'),
}

const STUDENT_OVERRIDE_BOOLEAN_FIELDS = [
  ['allow_dictation', 'Allow dictation'],
  ['allow_offline_editing', 'Allow offline editing'],
  ['copy_paste_allowed', 'Allow copy/paste'],
  ['export_allowed', 'Allow export'],
  ['images_allowed', 'Allow images'],
  ['require_lockdown', 'Keep in Handtyped'],
  ['require_permission_to_rejoin', 'Require teacher re-entry'],
  ['show_rubric_to_student', 'Show rubric to student'],
  ['browser_enabled', 'Enable study browser'],
]

const STUDENT_OVERRIDE_FONT_OPTIONS = [
  ['arial', 'Arial'],
  ['serif', 'Serif'],
  ['sans', 'Sans'],
  ['mono', 'Mono'],
]

const STUDENT_OVERRIDE_FONT_SIZE_OPTIONS = Array.from({ length: 91 }, (_, index) => String(index + 10))

const STUDENT_OVERRIDE_LINE_HEIGHT_OPTIONS = [
  ['single', 'Single'],
  ['relaxed', '1.15'],
  ['one-half', '1.5'],
  ['double', 'Double'],
]

function populateAssignmentFontSizeOptions() {
  const fontSizeSelect = elements.assignmentForm?.elements?.namedItem('editor_font_size')
  if (!(fontSizeSelect instanceof HTMLSelectElement)) {
    return
  }
  const currentValue = STUDENT_OVERRIDE_FONT_SIZE_OPTIONS.includes(fontSizeSelect.value)
    ? fontSizeSelect.value
    : '12'
  fontSizeSelect.innerHTML = STUDENT_OVERRIDE_FONT_SIZE_OPTIONS
    .map((value) => `<option value="${value}">${value} px</option>`)
    .join('')
  fontSizeSelect.value = currentValue
}

function escapeInlineHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function renderStarterInlineMarkdown(value = '') {
  return escapeInlineHtml(value)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/__([^_]+)__/g, '<u>$1</u>')
}

function starterMarkdownToHtml(markdown = '') {
  const text = String(markdown || '').replace(/\r/g, '').trim()
  if (!text) {
    return ''
  }
  const lines = text.split('\n')
  const blocks = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) {
      index += 1
      continue
    }
    if (/^###\s+/.test(line)) {
      blocks.push(`<h3>${renderStarterInlineMarkdown(line.replace(/^###\s+/, ''))}</h3>`)
      index += 1
      continue
    }
    if (/^##\s+/.test(line)) {
      blocks.push(`<h2>${renderStarterInlineMarkdown(line.replace(/^##\s+/, ''))}</h2>`)
      index += 1
      continue
    }
    if (/^#\s+/.test(line)) {
      blocks.push(`<h1>${renderStarterInlineMarkdown(line.replace(/^#\s+/, ''))}</h1>`)
      index += 1
      continue
    }
    if (/^>\s?/.test(line)) {
      const quoteLines = []
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quoteLines.push(renderStarterInlineMarkdown(lines[index].replace(/^>\s?/, '')))
        index += 1
      }
      blocks.push(`<blockquote><p>${quoteLines.join('<br>')}</p></blockquote>`)
      continue
    }
    if (/^[-*]\s+/.test(line)) {
      const items = []
      while (index < lines.length && /^[-*]\s+/.test(lines[index])) {
        items.push(`<li>${renderStarterInlineMarkdown(lines[index].replace(/^[-*]\s+/, ''))}</li>`)
        index += 1
      }
      blocks.push(`<ul>${items.join('')}</ul>`)
      continue
    }
    if (/^\d+\.\s+/.test(line)) {
      const items = []
      while (index < lines.length && /^\d+\.\s+/.test(lines[index])) {
        items.push(`<li>${renderStarterInlineMarkdown(lines[index].replace(/^\d+\.\s+/, ''))}</li>`)
        index += 1
      }
      blocks.push(`<ol>${items.join('')}</ol>`)
      continue
    }
    const paragraphLines = []
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^(#{1,3}\s+|>\s?|[-*]\s+|\d+\.\s+)/.test(lines[index])
    ) {
      paragraphLines.push(renderStarterInlineMarkdown(lines[index]))
      index += 1
    }
    blocks.push(`<p>${paragraphLines.join('<br>')}</p>`)
  }
  return blocks.join('')
}

function starterInlineHtmlToMarkdown(node) {
  if (!node) {
    return ''
  }
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent || ''
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return ''
  }
  const tag = node.tagName.toLowerCase()
  const childText = Array.from(node.childNodes).map((child) => starterInlineHtmlToMarkdown(child)).join('')
  if (tag === 'strong' || tag === 'b') {
    return `**${childText}**`
  }
  if (tag === 'em' || tag === 'i') {
    return `*${childText}*`
  }
  if (tag === 'u') {
    return `__${childText}__`
  }
  if (tag === 'a') {
    const href = node.getAttribute('href') || ''
    return href ? `[${childText}](${href})` : childText
  }
  if (tag === 'br') {
    return '\n'
  }
  return childText
}

function starterBlockHtmlToMarkdown(node) {
  if (!node) {
    return ''
  }
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent || '').trim()
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return ''
  }
  const tag = node.tagName.toLowerCase()
  if (tag === 'h1') {
    return `# ${Array.from(node.childNodes).map((child) => starterInlineHtmlToMarkdown(child)).join('').trim()}`
  }
  if (tag === 'h2') {
    return `## ${Array.from(node.childNodes).map((child) => starterInlineHtmlToMarkdown(child)).join('').trim()}`
  }
  if (tag === 'h3') {
    return `### ${Array.from(node.childNodes).map((child) => starterInlineHtmlToMarkdown(child)).join('').trim()}`
  }
  if (tag === 'blockquote') {
    return Array.from(node.querySelectorAll('p'))
      .flatMap((paragraph) =>
        Array.from(paragraph.textContent.split('\n')).map((line) => `> ${line}`.trimEnd()),
      )
      .join('\n')
  }
  if (tag === 'ul') {
    return Array.from(node.children)
      .filter((child) => child.tagName?.toLowerCase() === 'li')
      .map((child) => `- ${Array.from(child.childNodes).map((nested) => starterInlineHtmlToMarkdown(nested)).join('').trim()}`)
      .join('\n')
  }
  if (tag === 'ol') {
    return Array.from(node.children)
      .filter((child) => child.tagName?.toLowerCase() === 'li')
      .map((child, index) => `${index + 1}. ${Array.from(child.childNodes).map((nested) => starterInlineHtmlToMarkdown(nested)).join('').trim()}`)
      .join('\n')
  }
  return Array.from(node.childNodes).map((child) => starterInlineHtmlToMarkdown(child)).join('').trim()
}

function syncStarterDocumentField() {
  if (!elements.starterDocumentEditor || !elements.starterDocumentField) {
    return ''
  }
  const markdown = Array.from(elements.starterDocumentEditor.childNodes)
    .map((node) => starterBlockHtmlToMarkdown(node))
    .filter(Boolean)
    .join('\n\n')
    .trim()
  elements.starterDocumentField.value = markdown
  return markdown
}

function setStarterDocumentMarkdown(markdown = '') {
  if (!elements.starterDocumentEditor || !elements.starterDocumentField) {
    return
  }
  elements.starterDocumentField.value = String(markdown || '')
  elements.starterDocumentEditor.innerHTML = starterMarkdownToHtml(markdown)
}

function execStarterDocumentCommand(command) {
  if (!elements.starterDocumentEditor) {
    return
  }
  elements.starterDocumentEditor.focus()
  switch (command) {
    case 'bold':
      document.execCommand('bold')
      break
    case 'italic':
      document.execCommand('italic')
      break
    case 'underline':
      document.execCommand('underline')
      break
    case 'bullet':
      document.execCommand('insertUnorderedList')
      break
    case 'number':
      document.execCommand('insertOrderedList')
      break
    case 'quote':
      document.execCommand('formatBlock', false, 'blockquote')
      break
    case 'h1':
      document.execCommand('formatBlock', false, 'h1')
      break
    case 'h2':
      document.execCommand('formatBlock', false, 'h2')
      break
    case 'clear':
      document.execCommand('removeFormat')
      document.execCommand('formatBlock', false, 'p')
      break
    default:
      return
  }
  syncStarterDocumentField()
}

function referenceDocumentLabel(document) {
  const size = Number(document?.size_bytes || 0)
  if (!size) {
    return 'PDF ready'
  }
  if (size >= 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB PDF`
  }
  return `${Math.max(1, Math.round(size / 1024))} KB PDF`
}

function renderReferenceDocumentList(documents = assignmentReferenceDocuments) {
  if (!elements.assignmentReferenceDocumentList) {
    return
  }
  assignmentReferenceDocuments = Array.isArray(documents) ? [...documents] : []
  elements.assignmentReferenceDocumentList.innerHTML = assignmentReferenceDocuments.length
    ? assignmentReferenceDocuments
        .map(
          (document) => `
            <div class="linked-assignment-item" data-reference-document-id="${escapeHtml(document.id)}">
              <div>
                <div class="linked-assignment-title">${escapeHtml(document.title || 'Reference PDF')}</div>
                <div class="linked-assignment-meta">${escapeHtml(referenceDocumentLabel(document))}</div>
              </div>
              <button class="button button-secondary small-button" type="button" data-remove-reference-document>Remove</button>
            </div>
          `,
        )
        .join('')
    : '<div class="linked-assignment-empty">No reference PDFs yet.</div>'

  elements.assignmentReferenceDocumentList.querySelectorAll('[data-remove-reference-document]').forEach((button) => {
    button.addEventListener('click', () => {
      const row = button.closest('[data-reference-document-id]')
      if (!row) {
        return
      }
      assignmentReferenceDocuments = assignmentReferenceDocuments.filter(
        (document) => document.id !== row.dataset.referenceDocumentId,
      )
      renderReferenceDocumentList(assignmentReferenceDocuments)
    })
  })
}

async function readReferencePdfFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`))
    reader.onload = () =>
      resolve({
        id: `refdoc-${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`,
        title: String(file.name || 'Reference PDF').replace(/\.pdf$/i, '') || 'Reference PDF',
        mime_type: 'application/pdf',
        data_url: typeof reader.result === 'string' ? reader.result : '',
        size_bytes: file.size || 0,
      })
    reader.readAsDataURL(file)
  })
}

async function handleReferenceDocumentUpload(fileList) {
  const files = Array.from(fileList || []).filter((file) => /pdf$/i.test(file.type) || /\.pdf$/i.test(file.name || ''))
  if (!files.length) {
    return
  }
  const nextDocuments = await Promise.all(files.map((file) => readReferencePdfFile(file)))
  renderReferenceDocumentList([...assignmentReferenceDocuments, ...nextDocuments])
  if (elements.assignmentReferenceUpload) {
    elements.assignmentReferenceUpload.value = ''
  }
}

function buildReviewReplayCacheEntry(replay) {
  const attributedDocument = buildAttributedDocument({
    ...replay,
    doc_history: replay.document_history || [],
    doc_text: replay.current_text || '',
  }) || {
    text: String(replay?.current_text || ''),
    runs: [],
    firstInsertedAtMs: null,
    lastInsertedAtMs: null,
  }
  return {
    replay,
    attributedDocument,
  }
}

function reviewSessionHasAccess(session, assignment = getSelectedAssignment()) {
  if (!session || !assignment) {
    return false
  }
  if (studentAccessRevokedFor(assignment, session.student_name)) {
    return false
  }
  const temporaryAccess = temporaryAccessUntilFor(assignment, session.student_name)
  const temporaryOpen = temporaryAccess ? Date.parse(temporaryAccess) > Date.now() : false
  return Boolean(session.schedule_open || temporaryOpen || assignmentIsOpenNow(assignment))
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  })

  let data = null
  try {
    data = await response.json()
  } catch {
    data = null
  }

  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/api/edu/auth/')) {
      window.location.href = '/edu/login'
      throw new Error('Authentication required')
    }
    throw new Error(data?.error || `Request failed: ${response.status}`)
  }

  return data
}

function closeRealtimeConnection(connection) {
  try {
    connection?.close()
  } catch {
    // Ignore shutdown errors.
  }
}

function openRealtimeConnection(channels, handlers = {}) {
  const selectedChannels = (channels || []).filter(Boolean)
  if (!selectedChannels.length) {
    return null
  }
  const url = new URL('/api/edu/realtime', window.location.origin)
  for (const channel of selectedChannels) {
    url.searchParams.append('channel', channel)
  }
  const source = new EventSource(url)
  source.addEventListener('dashboard', (event) => {
    handlers.dashboard?.(JSON.parse(event.data))
  })
  source.addEventListener('assignment', (event) => {
    handlers.assignment?.(JSON.parse(event.data))
  })
  source.addEventListener('replay', (event) => {
    handlers.replay?.(JSON.parse(event.data))
  })
  source.onerror = () => {
    handlers.error?.()
  }
  return source
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function getClassrooms() {
  return dashboardState?.classrooms || []
}

function getAssignments() {
  return dashboardState?.assignments || []
}

function getLiveSessions() {
  return dashboardState?.live_sessions || []
}

function getAssignmentAudits() {
  return dashboardState?.assignment_audits || []
}

function currentReviewSession() {
  return (
    getLiveSessions().find((session) => session.id === selectedReviewSessionId) ||
    (reviewWorkspaceOpen && selectedReviewSessionSnapshot?.id === selectedReviewSessionId
      ? selectedReviewSessionSnapshot
      : null)
  )
}

function annotationAnchorLabel(annotation) {
  switch (annotation?.anchorStatus) {
    case 'exact':
      return 'Anchored in draft'
    case 'mapped':
      return 'Tracked through edits'
    case 'quote':
      return 'Reattached after edits'
    case 'context':
      return 'Anchor drifted after new writing'
    case 'ambiguous':
      return 'Multiple matching passages need review'
    case 'orphaned':
      return 'Original anchor needs review'
    default:
      return annotation?.stale ? 'Anchor drifted after new writing' : 'Anchored in draft'
  }
}

function mergeReplayIntoSessionState(sessionId, replayPayload) {
  if (!dashboardState || !sessionId || !replayPayload) {
    return
  }
  const existing = getLiveSessions().find((session) => session.id === sessionId)
  if (!existing && selectedReviewSessionSnapshot?.id !== sessionId) {
    return
  }
  const nextSession = {
    ...(existing || selectedReviewSessionSnapshot || {}),
    current_text: String(replayPayload.current_text || ''),
    current_url: replayPayload.current_url ?? existing?.current_url ?? selectedReviewSessionSnapshot?.current_url ?? null,
    current_url_title:
      replayPayload.current_url_title ??
      existing?.current_url_title ??
      selectedReviewSessionSnapshot?.current_url_title ??
      null,
    last_activity_at:
      replayPayload.last_activity_at ||
      existing?.last_activity_at ||
      selectedReviewSessionSnapshot?.last_activity_at ||
      null,
    updated_at:
      replayPayload.updated_at ||
      existing?.updated_at ||
      selectedReviewSessionSnapshot?.updated_at ||
      null,
  }

  dashboardState = {
    ...dashboardState,
    live_sessions: mergeById(getLiveSessions(), [nextSession]),
  }

  if (selectedReviewSessionSnapshot?.id === sessionId) {
    selectedReviewSessionSnapshot = {
      ...selectedReviewSessionSnapshot,
      ...nextSession,
    }
  }
}

function syncSelectedReviewSessionSnapshot(session = currentReviewSession()) {
  if (!selectedReviewSessionId || !reviewWorkspaceOpen || !session || session.id !== selectedReviewSessionId) {
    return
  }
  selectedReviewSessionSnapshot = { ...session }
}

function sessionFreshnessValue(session) {
  const updatedAt = Date.parse(String(session?.updated_at || ''))
  if (Number.isFinite(updatedAt)) {
    return updatedAt
  }
  const lastActivityAt = Date.parse(String(session?.last_activity_at || ''))
  if (Number.isFinite(lastActivityAt)) {
    return lastActivityAt
  }
  return 0
}

function preferFresherSession(existing, incoming) {
  if (!existing) {
    return incoming
  }
  if (!incoming) {
    return existing
  }
  return sessionFreshnessValue(existing) >= sessionFreshnessValue(incoming) ? existing : incoming
}

function preserveSelectedReviewSessionInSummaries(summaries = []) {
  const selectedSession = currentReviewSession()
  if (!reviewWorkspaceOpen || !selectedReviewSessionId || !selectedSession || selectedSession.assignment_id !== selectedAssignmentId) {
    return summaries
  }
  const incomingSelected = summaries.find((session) => session.id === selectedReviewSessionId) || null
  return mergeById(summaries, [preferFresherSession(selectedSession, incomingSelected)])
}

function preserveSelectedReviewSessionInDashboardPayload(payload) {
  if (!Array.isArray(payload?.live_sessions)) {
    return payload
  }
  const selectedSession = currentReviewSession()
  if (!reviewWorkspaceOpen || !selectedReviewSessionId || !selectedSession) {
    return payload
  }
  const incomingSelected = payload.live_sessions.find((session) => session.id === selectedReviewSessionId) || null
  return {
    ...payload,
    live_sessions: mergeById(payload.live_sessions, [preferFresherSession(selectedSession, incomingSelected)]),
  }
}

function displaySessionText(session, replayData = null) {
  const direct = String(session?.current_text || '')
  if (direct) {
    return direct
  }
  const replayText = String(replayData?.attributedDocument?.text || '')
  if (replayText) {
    return replayText
  }
  return latestTextFromHistory({
    doc_history: Array.isArray(session?.document_history) ? session.document_history : [],
    doc_text: '',
  })
}

function normalizedInlineAnnotation(annotation = {}) {
  const start = Math.max(0, Number(annotation.start ?? 0) || 0)
  const end = Math.max(start, Number(annotation.end ?? start) || start)
  const originalStart = Math.max(0, Number(annotation.original_start ?? start) || 0)
  const originalEnd = Math.max(originalStart, Number(annotation.original_end ?? end) || end)
  return {
    id: annotation.id || `annotation_${Math.random().toString(36).slice(2, 10)}`,
    type: 'comment',
    start,
    end,
    original_start: originalStart,
    original_end: originalEnd,
    quote: String(annotation.quote || ''),
    note: String(annotation.note || ''),
    replacement: '',
    context_before: String(annotation.context_before || '').slice(-COMMENT_CONTEXT_WINDOW),
    context_after: String(annotation.context_after || '').slice(0, COMMENT_CONTEXT_WINDOW),
    created_at: annotation.created_at || new Date().toISOString(),
    updated_at: annotation.updated_at || annotation.created_at || new Date().toISOString(),
  }
}

function normalizedSessionGrading(session = {}) {
  const grading = session?.grading && typeof session.grading === 'object' ? session.grading : {}
  const inlineAnnotations = Array.isArray(grading.inline_annotations)
    ? grading.inline_annotations.map(normalizedInlineAnnotation).sort((a, b) => a.start - b.start || a.end - b.end)
    : []
  return {
    rubric_scores:
      grading.rubric_scores && typeof grading.rubric_scores === 'object' ? { ...grading.rubric_scores } : {},
    teacher_comment: String(grading.teacher_comment || ''),
    returned_for_revision: Boolean(grading.returned_for_revision),
    grade_label: String(grading.grade_label || ''),
    grade_score:
      grading.grade_score === '' || grading.grade_score == null || Number.isNaN(Number(grading.grade_score))
        ? ''
        : String(grading.grade_score),
    inline_annotations: inlineAnnotations,
    updated_at: grading.updated_at || null,
    actor_name: grading.actor_name || '',
    actor_email: grading.actor_email || '',
  }
}

function reviewSummaryForSession(session, assignment) {
  const grading = normalizedSessionGrading(session)
  const rubric = Array.isArray(assignment?.rubric) ? assignment.rubric : []
  const earnedPoints = rubric.reduce((sum, criterion) => sum + Number(grading.rubric_scores[criterion.id] || 0), 0)
  const totalPoints = rubric.reduce((sum, criterion) => sum + Math.max(1, Number(criterion.points || 0)), 0)
  return {
    grading,
    earnedPoints,
    totalPoints,
    annotationCount: grading.inline_annotations.length,
  }
}

function createReviewStateFromSession(session) {
  const grading = normalizedSessionGrading(session)
  return {
    sessionId: session.id,
    gradeLabel: grading.grade_label,
    gradeScore: grading.grade_score,
    rubricScores: { ...grading.rubric_scores },
    teacherComment: grading.teacher_comment,
    returnedForRevision: grading.returned_for_revision,
    inlineAnnotations: grading.inline_annotations,
    updatedAt: grading.updated_at,
    updatedBy: grading.actor_name || grading.actor_email || '',
    saveState: grading.updated_at ? 'saved' : 'idle',
    dirty: false,
    selection: null,
    composerMode: '',
    composerNote: '',
    replayLoadState: 'idle',
    replayError: '',
    replayData: null,
    highlightMode: 'none',
    highlightDate: '',
  }
}

function getAssignmentsForClassroom(classroomId = selectedClassroomId) {
  if (!dashboardState || !classroomId) return []
  return getAssignments().filter((assignment) => assignment.classroom_id === classroomId)
}

function getSelectedClassroom() {
  return getClassrooms().find((classroom) => classroom.id === selectedClassroomId) || null
}

function getSelectedAssignment() {
  return getAssignments().find((assignment) => assignment.id === selectedAssignmentId) || null
}

function tenantId() {
  return dashboardState?.summary?.tenant_id || 'tenant_demo'
}

function dashboardChannel() {
  return `tenant:${tenantId()}:dashboard`
}

function assignmentChannel(assignmentId = selectedAssignmentId) {
  return assignmentId ? `tenant:${tenantId()}:assignment:${assignmentId}` : ''
}

function replayChannel(sessionId = selectedReviewSessionId) {
  return sessionId ? `tenant:${tenantId()}:replay:${sessionId}` : ''
}

function getSelectedAssignmentAudits() {
  if (!selectedAssignmentId) return []
  return getAssignmentAudits().filter((audit) => audit.assignment_id === selectedAssignmentId)
}

function resetAssignmentViewRefreshState() {
  lastAssignmentViewSummaryRefreshAt = 0
  lastAssignmentViewAuditRefreshAt = 0
}

function syncSelectionState() {
  const previousAssignmentId = selectedAssignmentId
  const nextSelection = reconcileTeacherNavigation({
    classrooms: getClassrooms(),
    assignments: getAssignments(),
    selectedClassroomId,
    selectedAssignmentId,
    currentView,
  })
  selectedClassroomId = nextSelection.selectedClassroomId
  selectedAssignmentId = nextSelection.selectedAssignmentId
  currentView = nextSelection.currentView
  if (previousAssignmentId !== selectedAssignmentId) {
    resetAssignmentViewRefreshState()
  }
}

function badge(text, tone = 'default') {
  return `<span class="student-badge student-badge-${tone}">${escapeHtml(text)}</span>`
}

function normalizeStudentOverrideKey(studentName) {
  return String(studentName || '').trim().toLowerCase()
}

function createStudentOverrideDraft(input = {}) {
  return {
    id: input.id || `student_override_${Math.random().toString(36).slice(2, 10)}`,
    student_name: String(input.student_name || '').trim(),
    temporary_access_enabled: Boolean(input.temporary_access_enabled),
    temporary_access_until: String(input.temporary_access_until || ''),
    policy: {
      allow_dictation: input.policy?.allow_dictation || 'default',
      allow_offline_editing: input.policy?.allow_offline_editing || 'default',
      copy_paste_allowed: input.policy?.copy_paste_allowed || 'default',
      export_allowed: input.policy?.export_allowed || 'default',
      images_allowed: input.policy?.images_allowed || 'default',
      require_lockdown: input.policy?.require_lockdown || 'default',
      require_permission_to_rejoin: input.policy?.require_permission_to_rejoin || 'default',
      show_rubric_to_student: input.policy?.show_rubric_to_student || 'default',
      browser_enabled: input.policy?.browser_enabled || 'default',
    },
    editor_policy: {
      font_family: input.editor_policy?.font_family || 'default',
      font_size: input.editor_policy?.font_size || 'default',
      line_height: input.editor_policy?.line_height || 'default',
      font_locked: input.editor_policy?.font_locked || 'default',
    },
    browser_policy: {
      home_url_enabled: Boolean(input.browser_policy?.home_url_enabled),
      home_url: String(input.browser_policy?.home_url || ''),
      mode: input.browser_policy?.mode === 'blacklist' ? 'blacklist' : 'whitelist',
      allowed_domains_enabled: Boolean(input.browser_policy?.allowed_domains_enabled),
      allowed_domains: String(input.browser_policy?.allowed_domains || ''),
    },
  }
}

function boolOverrideValue(value) {
  if (value === true || value === 'true') return 'true'
  if (value === false || value === 'false') return 'false'
  return 'default'
}

function currentStudentOverrideDrafts() {
  if (!elements.assignmentStudentOverrideList) {
    return []
  }

  return [...elements.assignmentStudentOverrideList.querySelectorAll('[data-student-override-id]')]
    .map((card) => createStudentOverrideDraft({
      id: card.dataset.studentOverrideId,
      student_name: card.querySelector('[data-override-student-name]')?.value || '',
      temporary_access_enabled: card.querySelector('[data-override-temp-enabled]')?.checked,
      temporary_access_until: card.querySelector('[data-override-temp-value]')?.value || '',
      policy: {
        allow_dictation: card.querySelector('[data-override-policy="allow_dictation"]')?.value,
        allow_offline_editing: card.querySelector('[data-override-policy="allow_offline_editing"]')?.value,
        copy_paste_allowed: card.querySelector('[data-override-policy="copy_paste_allowed"]')?.value,
        export_allowed: card.querySelector('[data-override-policy="export_allowed"]')?.value,
        images_allowed: card.querySelector('[data-override-policy="images_allowed"]')?.value,
        require_lockdown: card.querySelector('[data-override-policy="require_lockdown"]')?.value,
        require_permission_to_rejoin: card.querySelector('[data-override-policy="require_permission_to_rejoin"]')?.value,
        show_rubric_to_student: card.querySelector('[data-override-policy="show_rubric_to_student"]')?.value,
        browser_enabled: card.querySelector('[data-override-policy="browser_enabled"]')?.value,
      },
      editor_policy: {
        font_family: card.querySelector('[data-override-editor="font_family"]')?.value,
        font_size: card.querySelector('[data-override-editor="font_size"]')?.value,
        line_height: card.querySelector('[data-override-editor="line_height"]')?.value,
        font_locked: card.querySelector('[data-override-editor="font_locked"]')?.value,
      },
      browser_policy: {
        home_url_enabled: card.querySelector('[data-override-home-enabled]')?.checked,
        home_url: card.querySelector('[data-override-home-value]')?.value || '',
        mode: card.querySelector('[data-override-browser-mode]')?.value || 'whitelist',
        allowed_domains_enabled: card.querySelector('[data-override-domains-enabled]')?.checked,
        allowed_domains: card.querySelector('[data-override-domains-value]')?.value || '',
      },
    }))
}

function studentOverrideNameOptions(drafts = assignmentStudentOverrideDrafts) {
  return [...new Set([
    ...knownStudentsForClassroom(),
    ...drafts.map((draft) => String(draft?.student_name || '').trim()).filter(Boolean),
  ])].sort((a, b) => a.localeCompare(b))
}

function nextStudentOverrideName(drafts = assignmentStudentOverrideDrafts) {
  const usedNames = new Set(drafts.map((draft) => normalizeStudentOverrideKey(draft.student_name)).filter(Boolean))
  return studentOverrideNameOptions(drafts).find((studentName) => !usedNames.has(normalizeStudentOverrideKey(studentName))) || ''
}

function studentOverrideNameSelect(draft, options) {
  const selectedValue = String(draft.student_name || '').trim()
  return `
    <label>
      <span>Student</span>
      <select data-override-student-name>
        <option value=""${selectedValue ? '' : ' selected'} disabled>Choose a student</option>
        ${options
          .map((studentName) => `
            <option value="${escapeHtml(studentName)}"${studentName === selectedValue ? ' selected' : ''}>
              ${escapeHtml(studentName)}
            </option>
          `)
          .join('')}
      </select>
    </label>
  `
}

function overrideBooleanSelect(field, label, value, attributeName = 'policy') {
  return `
    <label>
      <span>${escapeHtml(label)}</span>
      <select data-override-${escapeHtml(attributeName)}="${escapeHtml(field)}">
        <option value="default"${value === 'default' ? ' selected' : ''}>Use default</option>
        <option value="true"${value === 'true' ? ' selected' : ''}>Allow</option>
        <option value="false"${value === 'false' ? ' selected' : ''}>Block</option>
      </select>
    </label>
  `
}

function overrideSelect(field, label, value, options, attributeName) {
  return `
    <label>
      <span>${escapeHtml(label)}</span>
      <select data-override-${escapeHtml(attributeName)}="${escapeHtml(field)}">
        <option value="default"${value === 'default' ? ' selected' : ''}>Use default</option>
        ${options
          .map(([optionValue, optionLabel]) => `
            <option value="${escapeHtml(optionValue)}"${String(value) === String(optionValue) ? ' selected' : ''}>
              ${escapeHtml(optionLabel)}
            </option>
          `)
          .join('')}
      </select>
    </label>
  `
}

function renderStudentOverrideCards(drafts = assignmentStudentOverrideDrafts) {
  assignmentStudentOverrideDrafts = drafts.map((draft) => createStudentOverrideDraft(draft))
  const studentOptions = studentOverrideNameOptions(assignmentStudentOverrideDrafts)

  if (!elements.assignmentStudentOverrideList) {
    return
  }

  if (elements.assignmentAddStudentOverride) {
    elements.assignmentAddStudentOverride.disabled = studentOptions.length === 0
  }

  if (!assignmentStudentOverrideDrafts.length) {
    elements.assignmentStudentOverrideList.innerHTML =
      '<div class="linked-assignment-empty">No student-specific overrides yet.</div>'
    return
  }

  elements.assignmentStudentOverrideList.innerHTML = assignmentStudentOverrideDrafts
    .map((draft) => `
      <article class="student-override-card" data-student-override-id="${escapeHtml(draft.id)}">
        <div class="student-override-header">
          ${studentOverrideNameSelect(draft, studentOptions)}
          <button class="button button-secondary small-button" type="button" data-remove-student-override="${escapeHtml(draft.id)}">
            Remove
          </button>
        </div>
        <div class="student-override-grid">
          <label class="student-override-check">
            <input type="checkbox" data-override-temp-enabled ${draft.temporary_access_enabled ? 'checked' : ''} />
            <span>Override temporary access</span>
          </label>
          <label>
            <span>Temporary access until</span>
            <input
              type="datetime-local"
              data-override-temp-value
              ${draft.temporary_access_enabled ? '' : 'disabled'}
              value="${escapeHtml(draft.temporary_access_until)}"
            />
          </label>
        </div>
        <div class="student-override-grid">
          ${STUDENT_OVERRIDE_BOOLEAN_FIELDS
            .map(([field, label]) => overrideBooleanSelect(field, label, draft.policy[field]))
            .join('')}
        </div>
        <div class="student-override-grid">
          ${overrideSelect('font_family', 'Font', draft.editor_policy.font_family, STUDENT_OVERRIDE_FONT_OPTIONS, 'editor')}
          ${overrideBooleanSelect('font_locked', 'Lock font', draft.editor_policy.font_locked, 'editor')}
          ${overrideSelect(
            'font_size',
            'Font size',
            draft.editor_policy.font_size,
            STUDENT_OVERRIDE_FONT_SIZE_OPTIONS.map((value) => [value, `${value} px`]),
            'editor',
          )}
          ${overrideSelect('line_height', 'Line spacing', draft.editor_policy.line_height, STUDENT_OVERRIDE_LINE_HEIGHT_OPTIONS, 'editor')}
        </div>
        <div class="student-override-grid">
          <label class="student-override-check">
            <input type="checkbox" data-override-home-enabled ${draft.browser_policy.home_url_enabled ? 'checked' : ''} />
            <span>Override browser home URL</span>
          </label>
          <label>
            <span>Home URL</span>
            <input
              type="url"
              data-override-home-value
              ${draft.browser_policy.home_url_enabled ? '' : 'disabled'}
              placeholder="https://example.com"
              value="${escapeHtml(draft.browser_policy.home_url)}"
            />
          </label>
          <label class="student-override-check">
            <input type="checkbox" data-override-domains-enabled ${draft.browser_policy.allowed_domains_enabled ? 'checked' : ''} />
            <span>Override allowed domains</span>
          </label>
          <label>
            <span>Browser mode</span>
            <select data-override-browser-mode>
              <option value="whitelist"${draft.browser_policy.mode === 'whitelist' ? ' selected' : ''}>Allow only listed</option>
              <option value="blacklist"${draft.browser_policy.mode === 'blacklist' ? ' selected' : ''}>Block listed</option>
            </select>
          </label>
          <label class="student-override-full">
            <span>URLs or domains (one per line)</span>
            <textarea
              rows="3"
              data-override-domains-value
              ${draft.browser_policy.allowed_domains_enabled ? '' : 'disabled'}
              placeholder="example.com&#10;wikipedia.org"
            >${escapeHtml(draft.browser_policy.allowed_domains)}</textarea>
          </label>
        </div>
      </article>
    `)
    .join('')

  elements.assignmentStudentOverrideList.querySelectorAll('[data-remove-student-override]').forEach((button) => {
    button.addEventListener('click', () => {
      assignmentStudentOverrideDrafts = currentStudentOverrideDrafts().filter(
        (draft) => draft.id !== button.dataset.removeStudentOverride,
      )
      renderStudentOverrideCards(assignmentStudentOverrideDrafts)
    })
  })

  elements.assignmentStudentOverrideList.querySelectorAll('[data-override-temp-enabled]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      const card = checkbox.closest('[data-student-override-id]')
      const input = card?.querySelector('[data-override-temp-value]')
      if (input) {
        input.disabled = !checkbox.checked
      }
    })
  })

  elements.assignmentStudentOverrideList.querySelectorAll('[data-override-home-enabled]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      const card = checkbox.closest('[data-student-override-id]')
      const input = card?.querySelector('[data-override-home-value]')
      if (input) {
        input.disabled = !checkbox.checked
      }
    })
  })

  elements.assignmentStudentOverrideList.querySelectorAll('[data-override-domains-enabled]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      const card = checkbox.closest('[data-student-override-id]')
      const input = card?.querySelector('[data-override-domains-value]')
      if (input) {
        input.disabled = !checkbox.checked
      }
    })
  })
}

function selectedStudentOverridesFromForm() {
  const studentOverrides = {}
  const studentTemporaryAccessUntil = {}

  for (const draft of currentStudentOverrideDrafts()) {
    const normalizedKey = normalizeStudentOverrideKey(draft.student_name)
    if (!normalizedKey) {
      continue
    }

    if (draft.temporary_access_enabled) {
      const iso = toIsoFromDateTimeLocal(draft.temporary_access_until)
      if (iso) {
        studentTemporaryAccessUntil[normalizedKey] = iso
      }
    }

    const policy = {}
    for (const [field] of STUDENT_OVERRIDE_BOOLEAN_FIELDS) {
      if (field === 'browser_enabled') {
        continue
      }
      if (draft.policy[field] !== 'default') {
        policy[field] = draft.policy[field] === 'true'
      }
    }

    const editorPolicy = {}
    if (draft.editor_policy.font_family !== 'default') {
      editorPolicy.font_family = draft.editor_policy.font_family
    }
    if (draft.editor_policy.font_size !== 'default') {
      editorPolicy.font_size = Number(draft.editor_policy.font_size)
    }
    if (draft.editor_policy.line_height !== 'default') {
      editorPolicy.line_height = draft.editor_policy.line_height
    }
    if (draft.editor_policy.font_locked !== 'default') {
      editorPolicy.font_locked = draft.editor_policy.font_locked === 'true'
    }

    const browserPolicy = {}
    if (draft.policy.browser_enabled !== 'default') {
      browserPolicy.browser_enabled = draft.policy.browser_enabled === 'true'
    }
    if (draft.browser_policy.home_url_enabled) {
      browserPolicy.home_url = draft.browser_policy.home_url
    }
    if (draft.browser_policy.allowed_domains_enabled) {
      browserPolicy.mode = draft.browser_policy.mode === 'blacklist' ? 'blacklist' : 'whitelist'
      browserPolicy.allowed_domains = draft.browser_policy.allowed_domains
        .split('\n')
        .map((value) => value.trim())
        .filter(Boolean)
    }

    if (Object.keys(policy).length || Object.keys(editorPolicy).length || Object.keys(browserPolicy).length) {
      studentOverrides[normalizedKey] = {
        student_name: draft.student_name.trim(),
        ...(Object.keys(policy).length ? { policy } : {}),
        ...(Object.keys(editorPolicy).length ? { editor_policy: editorPolicy } : {}),
        ...(Object.keys(browserPolicy).length ? { browser_policy: browserPolicy } : {}),
      }
    }
  }

  return { studentOverrides, studentTemporaryAccessUntil }
}

function draftsFromAssignmentStudentOverrides(assignment) {
  const settingsOverrides = assignment?.student_overrides && typeof assignment.student_overrides === 'object'
    ? assignment.student_overrides
    : {}
  const temporaryOverrides = assignment?.student_temporary_access_until && typeof assignment.student_temporary_access_until === 'object'
    ? assignment.student_temporary_access_until
    : {}
  const keys = [...new Set([...Object.keys(settingsOverrides), ...Object.keys(temporaryOverrides)])]

  return keys.map((key) => {
    const settings = settingsOverrides[key] || {}
    return createStudentOverrideDraft({
      student_name: settings.student_name || key,
      temporary_access_enabled: Object.hasOwn(temporaryOverrides, key),
      temporary_access_until: temporaryOverrides[key] ? localDateTimeInputValue(temporaryOverrides[key]) : '',
      policy: {
        allow_dictation: boolOverrideValue(settings.policy?.allow_dictation),
        allow_offline_editing: boolOverrideValue(settings.policy?.allow_offline_editing),
        copy_paste_allowed: boolOverrideValue(settings.policy?.copy_paste_allowed),
        export_allowed: boolOverrideValue(settings.policy?.export_allowed),
        images_allowed: boolOverrideValue(settings.policy?.images_allowed),
        require_lockdown: boolOverrideValue(settings.policy?.require_lockdown),
        require_permission_to_rejoin: boolOverrideValue(settings.policy?.require_permission_to_rejoin),
        show_rubric_to_student: boolOverrideValue(settings.policy?.show_rubric_to_student),
        browser_enabled: boolOverrideValue(settings.browser_policy?.browser_enabled),
      },
      editor_policy: {
        font_family: settings.editor_policy?.font_family || 'default',
        font_size: settings.editor_policy?.font_size ? String(settings.editor_policy.font_size) : 'default',
        line_height: settings.editor_policy?.line_height || 'default',
        font_locked: boolOverrideValue(settings.editor_policy?.font_locked),
      },
      browser_policy: {
        home_url_enabled: Object.hasOwn(settings.browser_policy || {}, 'home_url'),
        home_url: settings.browser_policy?.home_url || '',
        mode: settings.browser_policy?.mode === 'blacklist' ? 'blacklist' : 'whitelist',
        allowed_domains_enabled: Object.hasOwn(settings.browser_policy || {}, 'allowed_domains'),
        allowed_domains: Array.isArray(settings.browser_policy?.allowed_domains)
          ? settings.browser_policy.allowed_domains.join('\n')
          : '',
      },
    })
  })
}

function parseTimeParts(value, fallbackHour, fallbackMinute) {
  const [hour, minute] = String(value || '').split(':').map((part) => Number(part))
  return {
    hour: Number.isFinite(hour) ? hour : fallbackHour,
    minute: Number.isFinite(minute) ? minute : fallbackMinute,
  }
}

function readWindowDays(form) {
  return {
    monday: form.get('day_monday') === 'on',
    tuesday: form.get('day_tuesday') === 'on',
    wednesday: form.get('day_wednesday') === 'on',
    thursday: form.get('day_thursday') === 'on',
    friday: form.get('day_friday') === 'on',
    saturday: form.get('day_saturday') === 'on',
    sunday: form.get('day_sunday') === 'on',
  }
}

function toIsoFromDateTimeLocal(value) {
  const raw = String(value || '').trim()
  if (!raw) return null
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function setTemporaryAccessToday(hour, minute = 0) {
  const field = elements.assignmentForm?.elements.namedItem('temporary_access_until')
  if (!field) return
  field.value = localDateTimeInputValue(todayAtLocalTime(hour, minute))
  updateAssignmentFormGuidance()
}

function selectedTimeParts(input, fallbackHour = 15, fallbackMinute = 0) {
  return parseTimeParts(input?.value, fallbackHour, fallbackMinute)
}

async function extendSelectedAssignmentToToday(hour, minute = 0) {
  const assignment = getSelectedAssignment()
  if (!assignment) {
    window.alert('Select an assignment first.')
    return
  }

  const target = nextLocalTimeAtOrAfter(hour, minute)

  const updatedAssignment = await request(`/api/edu/assignments/${assignment.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      temporary_access_until: todayAtLocalTimeIso(hour, minute),
    }),
  })

  dashboardState = {
    ...dashboardState,
    assignments: getAssignments().map((item) => (item.id === updatedAssignment.id ? updatedAssignment : item)),
  }
  selectedAssignmentId = updatedAssignment.id
  renderView()
}

function studentSpecificExtensionFor(assignment, studentName) {
  const key = normalizeStudentOverrideKey(studentName)
  if (!key) {
    return null
  }
  return assignment?.student_temporary_access_until?.[key] || null
}

function temporaryAccessUntilFor(assignment, studentName) {
  return studentSpecificExtensionFor(assignment, studentName) || assignment?.temporary_access_until || null
}

function specialAccessBadgeFor(assignment, studentName, now = Date.now()) {
  const studentSpecificAccessUntil = studentSpecificExtensionFor(assignment, studentName)
  if (!studentSpecificAccessUntil) {
    return ''
  }
  const accessTime = Date.parse(studentSpecificAccessUntil)
  if (!Number.isFinite(accessTime) || accessTime <= now) {
    return ''
  }
  const formattedTime = new Date(accessTime).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  })
  return badge(`Special access until ${formattedTime}`, 'good')
}

function studentAccessRevokedFor(assignment, studentName) {
  const key = normalizeStudentOverrideKey(studentName)
  if (!key) {
    return false
  }
  return Boolean(assignment?.student_access_revoked?.[key])
}

function pendingStudentAccessActionFor(studentName) {
  return pendingStudentAccessActions.get(studentName) || null
}

function setPendingStudentAccessAction(studentName, action) {
  if (!studentName) return
  pendingStudentAccessActions.set(studentName, action)
}

function clearPendingStudentAccessAction(studentName) {
  if (!studentName) return
  pendingStudentAccessActions.delete(studentName)
}

function accessRequestsForAssignment(assignment) {
  const requests = assignment?.student_access_requests && typeof assignment.student_access_requests === 'object'
    ? assignment.student_access_requests
    : {}
  return Object.entries(requests)
    .map(([key, value]) => ({
      key,
      student_name: String(value?.student_name || key || '').trim(),
      requested_at: String(value?.requested_at || ''),
      note: String(value?.note || '').trim(),
    }))
    .filter((request) => request.key && request.student_name)
    .sort((a, b) => String(b.requested_at || '').localeCompare(String(a.requested_at || '')))
}

async function approveAssignmentAccessRequest(assignment, requestEntry, { hour = 15, minute = 0 } = {}) {
  const isAlreadyOpen = assignmentIsOpenNow(assignment)
  const nextRequests = { ...(assignment.student_access_requests || {}) }
  delete nextRequests[requestEntry.key]

  const nextStudentTemporaryAccessUntil = { ...(assignment.student_temporary_access_until || {}) }
  const nextStudentAccessRevoked = { ...(assignment.student_access_revoked || {}) }
  delete nextStudentAccessRevoked[requestEntry.key]
  if (isAlreadyOpen) {
    delete nextStudentTemporaryAccessUntil[requestEntry.key]
  } else {
    nextStudentTemporaryAccessUntil[requestEntry.key] = nextLocalTimeAtOrAfter(hour, minute).toISOString()
  }

  await submitAssignmentUpdateOptimistically(assignment, {
    student_access_requests: nextRequests,
    student_temporary_access_until: nextStudentTemporaryAccessUntil,
    student_access_revoked: nextStudentAccessRevoked,
  })
}

async function extendSelectedAssignmentForStudentToToday(studentName, hour, minute = 0) {
  const assignment = getSelectedAssignment()
  if (!assignment) {
    window.alert('Select an assignment first.')
    return
  }

  const normalizedKey = normalizeStudentOverrideKey(studentName)
  if (!normalizedKey) {
    window.alert('That student name is missing.')
    return
  }

  const target = todayAtLocalTime(hour, minute)
  const nextStudentAccessRevoked = { ...(assignment.student_access_revoked || {}) }
  delete nextStudentAccessRevoked[normalizedKey]
  if (target.getTime() < Date.now()) {
    const reopenForMinutes = window.prompt(
      'That time has already passed. Extend this student for how many minutes from now?',
      '15',
    )
    if (reopenForMinutes == null) {
      return
    }
    const durationMinutes = Number.parseInt(String(reopenForMinutes).trim(), 10)
    if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
      window.alert('Enter a whole number of minutes greater than 0.')
      return
    }
    const reopenUntil = new Date(Date.now() + durationMinutes * 60_000)
    await submitAssignmentUpdateOptimistically(assignment, {
      student_access_revoked: nextStudentAccessRevoked,
      student_temporary_access_until: {
        ...(assignment.student_temporary_access_until || {}),
        [normalizedKey]: reopenUntil.toISOString(),
      },
    })
    return
  }

  await submitAssignmentUpdateOptimistically(assignment, {
    student_access_revoked: nextStudentAccessRevoked,
    student_temporary_access_until: {
      ...(assignment.student_temporary_access_until || {}),
      [normalizedKey]: target.toISOString(),
    },
  })
}

async function closeSelectedAssignmentStudentAccess(studentName) {
  const assignment = getSelectedAssignment()
  if (!assignment) {
    window.alert('Select an assignment first.')
    return
  }

  const normalizedKey = normalizeStudentOverrideKey(studentName)
  if (!normalizedKey) {
    window.alert('That student name is missing.')
    return
  }

  const nextStudentAccessRevoked = { ...(assignment.student_access_revoked || {}) }
  nextStudentAccessRevoked[normalizedKey] = true

  await submitAssignmentUpdateOptimistically(assignment, {
    student_access_revoked: nextStudentAccessRevoked,
  })
}

function openModal(modal) {
  modal.hidden = false
}

function closeModal(modal) {
  modal.hidden = true
}

function clearSelectedReviewSession() {
  selectedReviewSessionId = null
  selectedReviewSessionSnapshot = null
  reviewWorkspaceOpen = false
  reviewState = null
  selectedAnnotationId = null
}

function feedbackContextSummary() {
  const classroom = getSelectedClassroom()
  const assignment = getSelectedAssignment()
  const reviewSession = currentReviewSession()
  return {
    view: currentView,
    classroom: classroom?.name || '',
    assignment: assignment?.title || '',
    student: reviewSession?.student_name || '',
    teacher: teacherSession?.teacher_name || '',
  }
}

function openFeedbackDraft(formData) {
  const category = String(formData.get('category') || 'Teacher feedback').trim()
  const subject = String(formData.get('subject') || '').trim()
  const message = String(formData.get('message') || '').trim()
  const replyTo = String(formData.get('reply_to') || '').trim()
  if (!subject || !message) {
    window.alert('Add both a subject and message before sending feedback.')
    return false
  }

  const context = feedbackContextSummary()
  const body = [
    message,
    '',
    '---',
    `Category: ${category}`,
    `Teacher: ${context.teacher || 'Unknown'}`,
    `View: ${context.view}`,
    `Class: ${context.classroom || 'None selected'}`,
    `Assignment: ${context.assignment || 'None selected'}`,
    `Student: ${context.student || 'None selected'}`,
    `Reply-to: ${replyTo || 'Not provided'}`,
  ].join('\n')

  const mailto = `mailto:support@handtyped.app?subject=${encodeURIComponent(`[Handtyped EDU] ${category}: ${subject}`)}&body=${encodeURIComponent(body)}`
  window.location.href = mailto
  return true
}

function selectedLinkedAssignmentIdsFromForm() {
  if (!elements.assignmentForm) return []
  return [...new Set(new FormData(elements.assignmentForm).getAll('linked_assignment_ids').map((value) => String(value)))]
}

function knownStudentsForClassroom(classroomId = selectedClassroomId || '') {
  const classroom = getClassrooms().find((item) => item.id === classroomId)
  const classroomStudents = Array.isArray(classroom?.students) ? classroom.students : []
  const liveStudents = getLiveSessions()
    .filter((session) => session.classroom === classroom?.name)
    .map((session) => session.student_name)
  const assignedStudents = getAssignmentsForClassroom(classroomId).flatMap((assignment) => assignment.assigned_students || [])

  return [...new Set(
    [...classroomStudents, ...liveStudents, ...assignedStudents]
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  )].sort((a, b) => a.localeCompare(b))
}

function selectedAssignedStudentsFromForm() {
  if (!elements.assignmentForm) return []
  return [...new Set(new FormData(elements.assignmentForm).getAll('assigned_students').map((value) => String(value)))]
}

function renderAssignedStudentOptions(selectedNames = null) {
  if (!elements.assignmentAssignedOptions) return
  const knownStudents = knownStudentsForClassroom()
  const selected = new Set((selectedNames || selectedAssignedStudentsFromForm()).map((value) => String(value).trim()))

  if (!knownStudents.length) {
    elements.assignmentAssignedOptions.innerHTML =
      '<div class="linked-assignment-empty">No student names have reached this class yet.</div>'
    return
  }

  elements.assignmentAssignedOptions.innerHTML = knownStudents
    .map((studentName) => `
      <label class="checkbox-label linked-assignment-option">
        <input
          type="checkbox"
          name="assigned_students"
          value="${escapeHtml(studentName)}"
          ${selected.has(studentName) ? 'checked' : ''}
        />
        <span><strong>${escapeHtml(studentName)}</strong></span>
      </label>
    `)
    .join('')
}

function renderLinkedAssignmentOptions(selectedIds = null) {
  if (!elements.assignmentLinkedOptions) return
  const classroomId = selectedClassroomId || ''
  const currentAssignmentId = elements.assignmentIdInput?.value || ''
  const selected = new Set((selectedIds || selectedLinkedAssignmentIdsFromForm()).map((value) => String(value)))
  const options = getAssignmentsForClassroom(classroomId).filter((assignment) => assignment.id !== currentAssignmentId)

  if (!options.length) {
    elements.assignmentLinkedOptions.innerHTML =
      '<div class="linked-assignment-empty">No previous assignments in this class yet.</div>'
    return
  }

  elements.assignmentLinkedOptions.innerHTML = options
    .map(
      (assignment) => `
        <label class="checkbox-label linked-assignment-option">
          <input
            type="checkbox"
            name="linked_assignment_ids"
            value="${escapeHtml(assignment.id)}"
            ${selected.has(assignment.id) ? 'checked' : ''}
          />
          <span>
            <strong>${escapeHtml(assignment.title)}</strong>
            <span class="muted">${escapeHtml(assignment.course || assignment.classroom_name || 'Assignment')}</span>
            <span class="selection-meta">${escapeHtml(formatWindowSummary(assignment))}</span>
          </span>
        </label>
      `,
    )
    .join('')
}

function createRubricDraft(criterion = {}) {
  return {
    id: criterion.id || `rubric_${Math.random().toString(36).slice(2, 10)}`,
    title: criterion.title || '',
    description: criterion.description || '',
    points: Number(criterion.points || 4),
  }
}

function selectedRubricFromForm() {
  if (!elements.assignmentRubricList) return []
  return [...elements.assignmentRubricList.querySelectorAll('[data-rubric-row]')]
    .map((row) => ({
      id: row.dataset.rubricId || undefined,
      title: row.querySelector('[data-rubric-title]')?.value.trim() || '',
      description: row.querySelector('[data-rubric-description]')?.value.trim() || '',
      points: Number(row.querySelector('[data-rubric-points]')?.value || 4),
    }))
    .filter((criterion) => criterion.title)
}

function renderRubricBuilder(criteria = null) {
  if (!elements.assignmentRubricList) return
  const drafts = (criteria || selectedRubricFromForm()).map(createRubricDraft)

  elements.assignmentRubricList.innerHTML = drafts.length
    ? drafts
        .map(
          (criterion) => `
            <div class="rubric-builder-row" data-rubric-row data-rubric-id="${escapeHtml(criterion.id)}">
              <label>
                <span>Criterion</span>
                <input data-rubric-title type="text" value="${escapeHtml(criterion.title)}" placeholder="Thesis, evidence, analysis..." />
              </label>
              <label>
                <span>Points</span>
                <input data-rubric-points type="number" min="1" max="100" value="${escapeHtml(criterion.points)}" />
              </label>
              <label class="rubric-description-field">
                <span>Description</span>
                <textarea data-rubric-description rows="2" placeholder="What earns full credit?">${escapeHtml(criterion.description)}</textarea>
              </label>
              <button class="button button-secondary small-button" type="button" data-remove-rubric>Remove</button>
            </div>
          `,
        )
        .join('')
    : '<div class="linked-assignment-empty">No rubric criteria yet.</div>'

  elements.assignmentRubricList.querySelectorAll('[data-remove-rubric]').forEach((button) => {
    button.addEventListener('click', () => {
      button.closest('[data-rubric-row]')?.remove()
      if (!elements.assignmentRubricList.querySelector('[data-rubric-row]')) {
        renderRubricBuilder([])
      }
      updateAssignmentFormGuidance()
    })
  })
}

function assignmentAudienceLabel(assignment) {
  const assignedStudents = Array.isArray(assignment?.assigned_students) ? assignment.assigned_students : []
  if (!assignedStudents.length) {
    return 'Whole class'
  }
  return `${assignedStudents.length} assigned student${assignedStudents.length === 1 ? '' : 's'}`
}

function renderClassroomGrid() {
  const classrooms = getClassrooms()
  if (!classrooms.length) {
    elements.classroomGrid.innerHTML = `<div class="selection-empty">No classes yet. Create one to get started.</div>`
    return
  }

  elements.classroomGrid.innerHTML = classrooms
    .map((classroom) => {
      const selected = classroom.id === selectedClassroomId
      const assignments = getAssignmentsForClassroom(classroom.id)
      return `
        <button class="selection-card classroom-card${selected ? ' is-selected' : ''}" type="button" data-classroom-id="${escapeHtml(classroom.id)}">
          <span class="selection-card-top">
            <span class="selection-title">${escapeHtml(classroom.name)}</span>
            <span class="selection-count">${assignments.length}</span>
          </span>
          <span class="selection-meta">${assignments.length} assignment${assignments.length === 1 ? '' : 's'}</span>
          <span class="selection-meta">Join code ${escapeHtml(classroom.join_code || 'No join code')}</span>
          <span class="selection-card-action-label">Open assignments</span>
        </button>
      `
    })
    .join('')

  elements.classroomGrid.querySelectorAll('[data-classroom-id]').forEach((button) => {
    button.addEventListener('click', () => {
      selectedClassroomId = button.dataset.classroomId
      selectedAssignmentId = null
      currentView = 'assignments'
      renderView()
    })
  })
}

function renderAssignmentStage() {
  const classroom = getSelectedClassroom()
  if (!classroom) {
    elements.assignmentStage.hidden = true
    elements.assignmentGrid.innerHTML = ''
    return
  }

  const assignments = getAssignmentsForClassroom(classroom.id)
  elements.assignmentStage.hidden = false
  elements.assignmentStageTitle.textContent = classroom.name
  if (elements.assignmentStageMeta) {
    elements.assignmentStageMeta.textContent = `${assignments.length} assignment${assignments.length === 1 ? '' : 's'} available`
  }

  if (!assignments.length) {
    elements.assignmentGrid.innerHTML = `<div class="selection-empty">No assignments yet for this class. Create one when you are ready.</div>`
    return
  }

  elements.assignmentGrid.innerHTML = assignments
    .map((assignment, index) => {
      const selected = assignment.id === selectedAssignmentId
      return `
        <button class="selection-card assignment-card${selected ? ' is-selected' : ''}" type="button" data-assignment-id="${escapeHtml(assignment.id)}">
          <span class="assignment-card-kicker">Assignment ${String(index + 1).padStart(2, '0')}</span>
          <span class="selection-title">${escapeHtml(assignment.title)}</span>
          <span class="selection-meta">${escapeHtml(assignment.course || classroom.name)}</span>
          <span class="selection-meta">${escapeHtml(assignmentAudienceLabel(assignment))}</span>
          <span class="selection-meta">${escapeHtml(formatWindowSummary(assignment))}</span>
          <span class="selection-card-action-label">View students</span>
        </button>
      `
    })
    .join('')

  elements.assignmentGrid.querySelectorAll('[data-assignment-id]').forEach((button) => {
    button.addEventListener('click', () => {
      selectedAssignmentId = button.dataset.assignmentId
      showAssignmentView()
    })
  })
}

function summarizeUrls(session) {
  const items = (session.url_history || []).slice(-4)
  if (!items.length) {
    return '<li>No recent browser visits.</li>'
  }
  return items
    .map((item) => `<li class="${item?.allowed === false ? 'student-url-illegal' : ''}">${escapeHtml(item.url || '(unknown url)')}</li>`)
    .join('')
}

function selectedSessionReviewSummary(session, assignment) {
  const summary = reviewSummaryForSession(session, assignment)
  const badges = []
  if (summary.grading.grade_label) {
    badges.push(badge(`Grade ${summary.grading.grade_label}`, 'good'))
  } else if (summary.grading.grade_score) {
    badges.push(badge(`Score ${summary.grading.grade_score}`, 'good'))
  }
  if (summary.totalPoints > 0) {
    badges.push(badge(`${summary.earnedPoints}/${summary.totalPoints} rubric`, 'neutral'))
  }
  if (summary.annotationCount > 0) {
    badges.push(
      badge(
        `${summary.annotationCount} inline ${summary.annotationCount === 1 ? 'note' : 'notes'}`,
        'warn',
      ),
    )
  }
  if (summary.grading.returned_for_revision) {
    badges.push(badge('Returned for revision', 'danger'))
  }
  return badges.length ? `<div class="student-card-review-summary">${badges.join('')}</div>` : ''
}

function buildReviewPayload() {
  if (!reviewState) return null
  const session = currentReviewSession()
  const assignment = getSelectedAssignment()
  const reviewText = displaySessionText(session, reviewState.replayData)
  return {
    session_snapshot: session
      ? {
          id: session.id || reviewState.sessionId,
          assignment_id: session.assignment_id || assignment?.id || '',
          assignment_title: session.assignment_title || assignment?.title || '',
          course: session.course || assignment?.course || '',
          classroom: session.classroom || assignment?.classroom_name || '',
          student_name: session.student_name || '',
          current_text: reviewText,
          document_history: Array.isArray(session.document_history) ? session.document_history : [],
          focus_events: Array.isArray(session.focus_events) ? session.focus_events : [],
          keystroke_log: String(session.keystroke_log || ''),
          current_url: session.current_url ?? null,
          current_url_title: session.current_url_title ?? null,
          url_history: Array.isArray(session.url_history) ? session.url_history : [],
          violation_count: Number(session.violation_count ?? 0),
          violations: Array.isArray(session.violations) ? session.violations : [],
          last_activity_at: session.last_activity_at || session.updated_at || new Date().toISOString(),
          schedule_open: Boolean(session.schedule_open),
          focused: session.focused ?? true,
          hid_active: session.hid_active ?? true,
          replay_session_id: session.replay_session_id ?? null,
        }
      : null,
    rubric_scores: { ...reviewState.rubricScores },
    teacher_comment: reviewState.teacherComment,
    returned_for_revision: reviewState.returnedForRevision,
    grade_label: reviewState.gradeLabel,
    grade_score: reviewState.gradeScore === '' ? null : Number(reviewState.gradeScore),
    inline_annotations: reviewState.inlineAnnotations.map((annotation) => ({
      ...annotation,
      updated_at: annotation.updated_at || annotation.created_at || new Date().toISOString(),
    })),
  }
}

function reviewPayloadFeedbackFingerprint(payload) {
  const { session_snapshot: _sessionSnapshot, ...feedbackPayload } = payload || {}
  return JSON.stringify(feedbackPayload)
}

function renderReviewSyncStatus() {
  if (!elements.reviewSyncStatus) return
  elements.reviewSyncStatus.classList.remove('is-saving', 'is-saved', 'is-error')
  if (!reviewState) {
    elements.reviewSyncStatus.textContent = 'Saved'
    return
  }
  if (reviewState.dirty || reviewState.saveState === 'saving') {
    elements.reviewSyncStatus.textContent = reviewState.saveState === 'error' ? 'Retrying sync…' : 'Syncing…'
    elements.reviewSyncStatus.classList.add('is-saving')
    return
  }
  if (reviewState.saveState === 'error') {
    elements.reviewSyncStatus.textContent = 'Sync needs retry'
    elements.reviewSyncStatus.classList.add('is-error')
    return
  }
  if (reviewState.updatedAt) {
    elements.reviewSyncStatus.textContent = `Saved ${timeAgoLabel(reviewState.updatedAt)}`
    elements.reviewSyncStatus.classList.add('is-saved')
    return
  }
  elements.reviewSyncStatus.textContent = 'Not yet saved'
}

function markReviewDirty() {
  if (!reviewState) return
  reviewState.dirty = true
  reviewState.saveState = 'saving'
  renderReviewSyncStatus()
  scheduleReviewSave()
}

function scheduleReviewSave(delayMs = 500) {
  if (reviewSaveTimer) {
    clearTimeout(reviewSaveTimer)
  }
  reviewSaveTimer = window.setTimeout(() => {
    reviewSaveTimer = null
    saveCurrentReview().catch(() => {})
  }, delayMs)
}

async function saveCurrentReview() {
  if (!reviewState || !reviewState.dirty || reviewSaveInFlight) {
    return reviewSavePromise
  }
  if (reviewSaveTimer) {
    clearTimeout(reviewSaveTimer)
    reviewSaveTimer = null
  }
  const sessionId = reviewState.sessionId
  const payload = buildReviewPayload()
  const payloadFingerprint = reviewPayloadFeedbackFingerprint(payload)
  reviewSaveInFlight = true
  reviewSavePromise = request(`/api/edu/live-sessions/${encodeURIComponent(sessionId)}/grading`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
    .then((updatedSession) => {
      dashboardState = {
        ...dashboardState,
        live_sessions: mergeById(getLiveSessions(), [updatedSession]),
      }
      if (reviewState?.sessionId === sessionId) {
        const grading = normalizedSessionGrading(updatedSession)
        reviewState.updatedAt = grading.updated_at
        reviewState.updatedBy = grading.actor_name || grading.actor_email || ''
        if (reviewPayloadFeedbackFingerprint(buildReviewPayload()) === payloadFingerprint) {
          reviewState.dirty = false
          reviewState.saveState = 'saved'
        } else {
          reviewState.dirty = true
          reviewState.saveState = 'saving'
        }
      }
      renderReviewSyncStatus()
      renderStudentCards({ skipReviewWorkspace: true })
    })
    .catch((error) => {
      if (reviewState?.sessionId === sessionId) {
        reviewState.saveState = 'error'
        if (reviewState.dirty) {
          scheduleReviewSave(REVIEW_SYNC_RETRY_MS)
        }
      }
      renderReviewSyncStatus()
      throw error
    })
    .finally(() => {
      reviewSaveInFlight = false
      reviewSavePromise = null
    })
  return reviewSavePromise
}

async function flushReviewSave() {
  if (reviewSaveTimer) {
    clearTimeout(reviewSaveTimer)
    reviewSaveTimer = null
  }
  let inFlightError = null
  if (reviewSavePromise) {
    try {
      await reviewSavePromise
    } catch (error) {
      inFlightError = error
    }
  }
  if (reviewState?.dirty) {
    await saveCurrentReview()
    return
  }
  if (inFlightError) {
    throw inFlightError
  }
}

function clearReviewComposer() {
  if (!reviewState) return
  reviewState.composerMode = ''
  reviewState.composerNote = ''
  if (elements.reviewComposerNote) elements.reviewComposerNote.value = ''
  renderReviewSelectionUi()
}

function renderReviewSelectionUi() {
  if (!reviewState) return
  const selection = reviewState.selection
  elements.reviewSelectionCount.textContent = selection
    ? `${selection.end - selection.start} char${selection.end - selection.start === 1 ? '' : 's'} selected`
    : 'No text selected'
  elements.reviewSelectionQuote.textContent = selection
    ? selection.text
    : 'Select text in the draft to add a comment.'
  const composerOpen = Boolean(selection && reviewState.composerMode)
  elements.reviewComposer.hidden = !composerOpen
  elements.reviewComposerLabel.textContent = 'New comment'
  if (elements.reviewComposerNote && elements.reviewComposerNote.value !== reviewState.composerNote) {
    elements.reviewComposerNote.value = reviewState.composerNote
  }
  elements.reviewCommentMode.classList.toggle('is-selected', reviewState.composerMode === 'comment')
  elements.reviewCommentMode.disabled = !selection
  elements.reviewAddAnnotation.disabled = !selection
}

function beginReviewComposer(mode) {
  if (!reviewState?.selection) return
  reviewState.composerMode = mode === 'comment' ? 'comment' : 'comment'
  reviewState.composerNote = ''
  elements.reviewComposerNote.value = ''
  renderReviewWorkspace(getSelectedAssignment())
  elements.reviewComposerNote.focus()
}

function normalizedPendingReviewSelection(text, selection) {
  if (!selection) {
    return null
  }
  const safeText = String(text || '')
  const safeStart = Math.max(0, Math.min(Number(selection.start ?? 0) || 0, safeText.length))
  const safeEnd = Math.max(safeStart, Math.min(Number(selection.end ?? safeStart) || safeStart, safeText.length))
  const direct = safeText.slice(safeStart, safeEnd)
  const quote = String(selection.text || '')
  if (direct && (!quote || direct === quote)) {
    return {
      start: safeStart,
      end: safeEnd,
      text: direct,
    }
  }
  if (quote) {
    const firstIndex = safeText.indexOf(quote)
    if (firstIndex !== -1 && safeText.indexOf(quote, firstIndex + quote.length) === -1) {
      return {
        start: firstIndex,
        end: firstIndex + quote.length,
        text: quote,
      }
    }
  }
  if (safeEnd > safeStart) {
    return {
      start: safeStart,
      end: safeEnd,
      text: direct || quote,
    }
  }
  return null
}

function prefixOverlapLength(actual, expected) {
  const safeActual = String(actual || '')
  const safeExpected = String(expected || '')
  const max = Math.min(safeActual.length, safeExpected.length)
  let matched = 0
  while (matched < max && safeActual[matched] === safeExpected[matched]) {
    matched += 1
  }
  return matched
}

function suffixOverlapLength(actual, expected) {
  const safeActual = String(actual || '')
  const safeExpected = String(expected || '')
  const max = Math.min(safeActual.length, safeExpected.length)
  let matched = 0
  while (
    matched < max &&
    safeActual[safeActual.length - 1 - matched] === safeExpected[safeExpected.length - 1 - matched]
  ) {
    matched += 1
  }
  return matched
}

function annotationCandidateScore(text, start, end, annotation) {
  const before = String(annotation?.context_before || '')
  const after = String(annotation?.context_after || '')
  const originalStart = Math.max(0, Number(annotation?.original_start ?? annotation?.start ?? 0) || 0)
  const beforeText = text.slice(Math.max(0, start - before.length), start)
  const afterText = text.slice(end, Math.min(text.length, end + after.length))
  const beforeScore = before ? suffixOverlapLength(beforeText, before) : 0
  const afterScore = after ? prefixOverlapLength(afterText, after) : 0
  const distancePenalty = Math.min(40, Math.abs(start - originalStart))
  return beforeScore * 4 + afterScore * 4 - distancePenalty
}

function allIndexesOf(text, search) {
  if (!search) return []
  const indexes = []
  let from = 0
  while (from <= text.length) {
    const next = text.indexOf(search, from)
    if (next === -1) break
    indexes.push(next)
    from = next + 1
  }
  return indexes
}

function annotationContextFallback(text, annotation) {
  const before = String(annotation?.context_before || '')
  const after = String(annotation?.context_after || '')
  const originalStart = Math.max(0, Number(annotation?.original_start ?? annotation?.start ?? 0) || 0)
  const originalEnd = Math.max(originalStart, Number(annotation?.original_end ?? annotation?.end ?? originalStart) || originalStart)
  const originalLength = Math.max(0, originalEnd - originalStart)
  const beforeIndexes = before ? allIndexesOf(text, before) : [Math.max(0, Math.min(originalStart, text.length))]
  const afterIndexes = after ? allIndexesOf(text, after) : []
  const candidates = []

  for (const beforeIndex of beforeIndexes) {
    const start = before ? beforeIndex + before.length : beforeIndex
    if (afterIndexes.length) {
      for (const afterIndex of afterIndexes) {
        if (afterIndex < start) continue
        candidates.push({
          start,
          end: Math.max(start, afterIndex),
          score: annotationCandidateScore(text, start, Math.max(start, afterIndex), annotation),
        })
      }
    } else {
      const end = Math.max(start, Math.min(text.length, start + originalLength))
      candidates.push({
        start,
        end,
        score: annotationCandidateScore(text, start, end, annotation),
      })
    }
  }

  candidates.sort((left, right) => right.score - left.score || left.start - right.start || left.end - right.end)
  return candidates[0] || null
}

function annotationsOverlap(start, end, excludeId = null) {
  return reviewState?.inlineAnnotations.some(
    (annotation) =>
      annotation.id !== excludeId &&
      Math.max(start, annotation.start) < Math.min(end, annotation.end),
  )
}

async function addReviewAnnotation() {
  if (!reviewState?.selection || !reviewState.composerMode) return
  const { start, end, text } = reviewState.selection
  const reviewText = displaySessionText(currentReviewSession(), reviewState.replayData)
  if (annotationsOverlap(start, end)) {
    window.alert('Inline comments cannot overlap yet. Choose a different span of text.')
    return
  }
  const note = elements.reviewComposerNote.value.trim()
  if (!note) {
    window.alert('Add a short note before saving the annotation.')
    return
  }
  const timestamp = new Date().toISOString()
  const nextAnnotation = normalizedInlineAnnotation({
    type: 'comment',
    start,
    end,
    original_start: start,
    original_end: end,
    quote: text,
    note,
    context_before: reviewText.slice(Math.max(0, start - COMMENT_CONTEXT_WINDOW), start),
    context_after: reviewText.slice(end, Math.min(reviewText.length, end + COMMENT_CONTEXT_WINDOW)),
    created_at: timestamp,
    updated_at: timestamp,
  })
  reviewState.inlineAnnotations = [...reviewState.inlineAnnotations, nextAnnotation].sort((a, b) => a.start - b.start || a.end - b.end)
  reviewState.selection = null
  selectedAnnotationId = nextAnnotation.id
  clearReviewComposer()
  markReviewDirty()
  renderReviewWorkspace(getSelectedAssignment())
  try {
    await flushReviewSave()
  } catch (error) {
    window.alert(`Could not save comment: ${error.message}`)
  }
}

function deleteReviewAnnotation(annotationId) {
  if (!reviewState) return
  reviewState.inlineAnnotations = reviewState.inlineAnnotations.filter((annotation) => annotation.id !== annotationId)
  if (selectedAnnotationId === annotationId) {
    selectedAnnotationId = null
  }
  markReviewDirty()
  renderReviewWorkspace(getSelectedAssignment())
}

function annotationDisplayState(annotation, text) {
  const normalized = normalizedInlineAnnotation(annotation)
  const direct = text.slice(normalized.start, normalized.end)
  const quote = normalized.quote || direct
  if (!quote) {
    return { ...normalized, stale: false, anchorStatus: 'empty' }
  }
  if (direct === quote) {
    return { ...normalized, quote, stale: false, anchorStatus: 'exact' }
  }
  const quoteCandidates = allIndexesOf(text, quote)
    .map((candidateStart) => ({
      start: candidateStart,
      end: candidateStart + quote.length,
      score: annotationCandidateScore(text, candidateStart, candidateStart + quote.length, normalized),
    }))
    .sort((left, right) => right.score - left.score || left.start - right.start)
  const best = quoteCandidates[0] || null
  const runnerUp = quoteCandidates[1] || null
  if (best && runnerUp && best.score === runnerUp.score && best.start !== runnerUp.start) {
    return {
      ...normalized,
      start: normalized.start,
      end: normalized.start,
      quote,
      stale: true,
      anchorStatus: 'ambiguous',
    }
  }
  if (best && (!runnerUp || best.score > runnerUp.score)) {
    return {
      ...normalized,
      start: best.start,
      end: best.end,
      quote,
      stale: false,
      anchorStatus: 'quote',
    }
  }
  const fallback = annotationContextFallback(text, normalized)
  if (fallback && (fallback.end > fallback.start || quote)) {
    return {
      ...normalized,
      start: fallback.start,
      end: fallback.end,
      quote: text.slice(fallback.start, fallback.end) || quote,
      stale: true,
      anchorStatus: 'context',
    }
  }
  return {
    ...normalized,
    quote,
    stale: true,
    anchorStatus: 'orphaned',
  }
}

function reviewHighlightRangesForState(session, assignment) {
  if (!reviewState?.replayData?.attributedDocument) {
    return []
  }

  switch (reviewState.highlightMode) {
    case 'after-school-day': {
      const replay = reviewState.replayData.replay || {}
      const insertedAtMs = (reviewState.replayData.attributedDocument.chars || []).map((entry) => entry.insertedAtMs)
      const offsetMinutes = Number(replay.recorded_timezone_offset_minutes || 0)
      return buildAfterSchoolRanges(insertedAtMs, assignment, {
        dateInput: reviewState.highlightDate,
        offsetMinutes,
      })
    }
    case 'after-school-all': {
      const replay = reviewState.replayData.replay || {}
      const insertedAtMs = (reviewState.replayData.attributedDocument.chars || []).map((entry) => entry.insertedAtMs)
      const offsetMinutes = Number(replay.recorded_timezone_offset_minutes || 0)
      return buildAfterSchoolRanges(insertedAtMs, assignment, {
        allDates: true,
        offsetMinutes,
      })
    }
    default:
      return []
  }
}

function reviewHighlightModeActive() {
  return Boolean(reviewState?.highlightMode && reviewState.highlightMode !== 'none')
}

function reviewHighlightIndexSet(text, ranges) {
  if (!reviewState?.replayData?.attributedDocument || !Array.isArray(ranges) || !ranges.length) {
    return new Set()
  }
  const attributed = reviewState.replayData.attributedDocument
  if (attributed.text !== String(text || '')) {
    return new Set()
  }
  const active = new Set()
  attributed.chars.forEach((entry, index) => {
    const insertedAtMs = Number(entry?.insertedAtMs)
    if (!Number.isFinite(insertedAtMs)) {
      return
    }
    if (ranges.some((range) => insertedAtMs >= range.startMs && insertedAtMs <= range.endMs)) {
      active.add(index)
    }
  })
  return active
}

function renderIndexedSlice(text, start, end, annotation, highlightIndexes, selectionIndexes) {
  let html = ''
  let cursor = start

  while (cursor < end) {
    const highlighted = highlightIndexes.has(cursor)
    const selected = selectionIndexes.has(cursor)
    let next = cursor + 1
    while (
      next < end &&
      highlightIndexes.has(next) === highlighted &&
      selectionIndexes.has(next) === selected
    ) {
      next += 1
    }

    const classes = []
    if (annotation) {
      classes.push('review-highlight', 'review-highlight-comment')
      if (annotation.stale) {
        classes.push('review-highlight-stale')
      }
      if (annotation.id === selectedAnnotationId) {
        classes.push('is-selected')
      }
    }
    if (highlighted) {
      classes.push('review-highlight-time')
    }
    if (selected) {
      classes.push('review-highlight-pending')
    }

    const content = escapeHtml(String(text || '').slice(cursor, next))
    if (!classes.length) {
      html += content
    } else {
      const annotationAttr = annotation ? ` data-annotation-id="${escapeHtml(annotation.id)}"` : ''
      html += `<span class="${classes.join(' ')}"${annotationAttr}>${content}</span>`
    }
    cursor = next
  }

  return html
}

function renderReviewHighlightUi(session, assignment) {
  if (!reviewState || !elements.reviewHighlightMeta) {
    return
  }

  if (elements.reviewHighlightDate) {
    elements.reviewHighlightDate.value = reviewState.highlightDate
  }

  const noReplay = !session?.replay_session_id
  const loading = reviewState.replayLoadState === 'loading'
  const ready = reviewState.replayLoadState === 'ready'
  const disablePresets = noReplay || loading || !ready
  if (elements.reviewHighlightAfterSchoolDay) {
    elements.reviewHighlightAfterSchoolDay.disabled = disablePresets || !reviewState.highlightDate
  }
  if (elements.reviewHighlightAfterSchoolAll) {
    elements.reviewHighlightAfterSchoolAll.disabled = disablePresets
  }
  if (elements.reviewHighlightClear) {
    elements.reviewHighlightClear.disabled = !reviewHighlightModeActive()
  }

  if (noReplay) {
    elements.reviewHighlightMeta.textContent = 'No replay is available for this student yet, so time-based highlighting is unavailable.'
    return
  }
  if (reviewState.replayLoadState === 'error' || reviewState.replayLoadState === 'missing') {
    elements.reviewHighlightMeta.textContent = reviewState.replayError || 'Could not load replay data for time-based highlighting.'
    return
  }
  if (loading || reviewState.replayLoadState === 'idle') {
    elements.reviewHighlightMeta.textContent = 'Loading replay data for time-based highlighting…'
    return
  }

  const displayText = displaySessionText(session, reviewState.replayData)
  const ranges = reviewHighlightRangesForState(session, assignment)
  const highlights = reviewHighlightIndexSet(displayText, ranges)
  if (reviewHighlightModeActive() && !highlights.size) {
    elements.reviewHighlightMeta.textContent = 'No surviving characters matched that after-school filter.'
    return
  }
  if (reviewState.highlightMode === 'after-school-day') {
    elements.reviewHighlightMeta.textContent = `${highlights.size} surviving character${highlights.size === 1 ? '' : 's'} highlighted from after school on ${reviewState.highlightDate}.`
    return
  }
  if (reviewState.highlightMode === 'after-school-all') {
    elements.reviewHighlightMeta.textContent = `${highlights.size} surviving character${highlights.size === 1 ? '' : 's'} highlighted from after-school writing across the replay.`
    return
  }
  elements.reviewHighlightMeta.textContent = 'Pick a day or use all after school to highlight the surviving text added outside class time.'
}

async function loadReviewReplayData(session) {
  if (!reviewState || !session || reviewState.replayLoadState !== 'idle') {
    return
  }
  if (!session.id) {
    reviewState.replayLoadState = 'missing'
    reviewState.replayError = ''
    return
  }

  reviewState.replayLoadState = 'loading'
  reviewState.replayError = ''
  renderReviewHighlightUi(session, getSelectedAssignment())

  try {
    let cached = reviewReplayCache.get(session.id)
    if (!cached) {
      let replay
      try {
        replay = await request(`/api/edu/live-replays/${encodeURIComponent(session.id)}`)
      } catch (error) {
        if (error.message !== 'Not found' || !session.replay_session_id) {
          throw error
        }
        const storedReplay = await request(`/api/edu/replays/${encodeURIComponent(session.replay_session_id)}`)
        replay = {
          ...storedReplay,
          live_session_id: storedReplay.live_session_id || session.id,
          replay_session_id: storedReplay.id || session.replay_session_id,
          last_seq: 0,
          events: [],
        }
      }
      cached = buildReviewReplayCacheEntry(replay)
      reviewReplayCache.set(session.id, cached)
    }

    if (!reviewState || reviewState.sessionId !== session.id) {
      return
    }
    reviewState.replayData = cached
    reviewState.replayLoadState = 'ready'
    if (!reviewState.highlightDate) {
      reviewState.highlightDate = replayLocalDateInputValue(
        cached.attributedDocument.firstInsertedAtMs || cached.attributedDocument.lastInsertedAtMs,
        Number(cached.replay.recorded_timezone_offset_minutes || 0),
      )
    }
    renderReviewWorkspace(getSelectedAssignment())
  } catch (error) {
    if (!reviewState || reviewState.sessionId !== session.id) {
      return
    }
    reviewState.replayLoadState = error.message === 'Not found' ? 'missing' : 'error'
    reviewState.replayError = error.message === 'Not found'
      ? 'Replay data is no longer available for time-based highlighting.'
      : error.message || 'Could not load replay data.'
    renderReviewHighlightUi(session, getSelectedAssignment())
  }
}

function handleRealtimeDashboard(delta) {
  if (isFullDashboardPayload(delta)) {
    renderDashboard(preserveSelectedReviewSessionInDashboardPayload(delta))
    return
  }
  applyDashboardDelta(delta)
}

function handleRealtimeAssignment(payload) {
  if (!payload) return
  if (payload.assignment) {
    upsertAssignmentInState(payload.assignment)
  }
  const preserveReviewInputs = Boolean(activeReviewEditorElement())
  if (Array.isArray(payload.live_sessions)) {
    const nextAssignmentSessions = preserveSelectedReviewSessionInSummaries(payload.live_sessions)
    const selectedSession =
      selectedReviewSessionId
        ? nextAssignmentSessions.find((session) => session.id === selectedReviewSessionId) || null
        : null
    dashboardState = {
      ...dashboardState,
      live_sessions: mergeById(
        getLiveSessions().filter((session) => session.assignment_id !== payload.assignment?.id),
        nextAssignmentSessions,
      ),
      assignment_audits: Array.isArray(payload.assignment_audits)
        ? mergeById(
            getAssignmentAudits().filter((audit) => audit.assignment_id !== payload.assignment?.id),
            payload.assignment_audits,
          )
        : getAssignmentAudits(),
    }
    if (selectedSession && reviewWorkspaceOpen) {
      selectedReviewSessionSnapshot = { ...selectedSession }
      if (reviewState?.sessionId === selectedSession.id) {
        renderReviewWorkspaceLiveContent(getSelectedAssignment())
      }
    }
    renderStudentCards({ skipReviewWorkspace: preserveReviewInputs })
  }
}

function handleRealtimeReplay(payload) {
  if (!payload?.id) return
  const nextCache = buildReviewReplayCacheEntry(payload)
  reviewReplayCache.set(payload.id, nextCache)
  mergeReplayIntoSessionState(payload.id, payload)
  if (!reviewState || reviewState.sessionId !== payload.id) {
    return
  }
  reviewState.replayData = nextCache
  reviewState.replayLoadState = 'ready'
  renderReviewWorkspaceLiveContent(getSelectedAssignment())
}

function syncRealtimeSubscriptions() {
  const nextTeacherKey = dashboardState ? dashboardChannel() : ''
  if (nextTeacherKey !== teacherRealtimeKey) {
    closeRealtimeConnection(teacherRealtime)
    teacherRealtimeKey = nextTeacherKey
    teacherRealtime = nextTeacherKey
      ? openRealtimeConnection([nextTeacherKey], {
          dashboard: handleRealtimeDashboard,
          error: () => {
            refreshDashboard().catch(() => {})
          },
        })
      : null
  }

  const nextAssignmentKey = currentView === 'assignment' && selectedAssignmentId ? assignmentChannel() : ''
  if (nextAssignmentKey !== assignmentRealtimeKey) {
    closeRealtimeConnection(assignmentRealtime)
    assignmentRealtimeKey = nextAssignmentKey
    assignmentRealtime = nextAssignmentKey
      ? openRealtimeConnection([nextAssignmentKey], {
          assignment: handleRealtimeAssignment,
          error: () => {
            refreshAssignmentViewData().catch(() => {})
          },
        })
      : null
  }

  const nextReplayKey = reviewWorkspaceOpen && selectedReviewSessionId ? replayChannel() : ''
  if (nextReplayKey !== replayRealtimeKey) {
    closeRealtimeConnection(replayRealtime)
    replayRealtimeKey = nextReplayKey
    replayRealtime = nextReplayKey
      ? openRealtimeConnection([nextReplayKey], {
          replay: handleRealtimeReplay,
          error: () => {
            refreshSelectedReviewReplayData().catch(() => {})
          },
        })
      : null
  }
}

async function refreshSelectedReviewReplayData() {
  if (!reviewWorkspaceOpen || !selectedReviewSessionId) {
    return
  }
  const session = currentReviewSession()
  if (!session) {
    return
  }

  const cached = reviewReplayCache.get(session.id)
  if (!cached) {
    await loadReviewReplayData(session)
    return
  }

  const updates = await request(
    `/api/edu/live-replays/${encodeURIComponent(session.id)}/updates?since_seq=${encodeURIComponent(
      String(cached.replay.last_seq || 0),
    )}`,
  )
  if (!Array.isArray(updates?.events) || !updates.events.length) {
    return
  }

  const mergedReplay = applyLiveReplayUpdates(cached.replay, updates)
  const nextCache = buildReviewReplayCacheEntry(mergedReplay)
  reviewReplayCache.set(session.id, nextCache)
  mergeReplayIntoSessionState(session.id, mergedReplay)

  if (!reviewState || reviewState.sessionId !== session.id) {
    return
  }

  reviewState.replayData = nextCache
  reviewState.replayLoadState = 'ready'
  renderReviewWorkspace(getSelectedAssignment())
}

async function refreshSelectedReviewSessionData() {
  if (!reviewWorkspaceOpen || !selectedReviewSessionId) {
    return
  }
  const selectedSession = await request(`/api/edu/live-sessions/${encodeURIComponent(selectedReviewSessionId)}`).catch((error) => {
    if (error.message === 'Not found') {
      return MISSING_SELECTED_REVIEW_SESSION
    }
    throw error
  })
  if (!selectedSession || selectedSession === MISSING_SELECTED_REVIEW_SESSION) {
    return
  }

  dashboardState = {
    ...dashboardState,
    live_sessions: mergeById(getLiveSessions(), [selectedSession]),
  }
  syncSelectedReviewSessionSnapshot(selectedSession)

  if (reviewState?.sessionId === selectedSession.id) {
    renderReviewWorkspaceLiveContent(getSelectedAssignment())
  } else {
    renderStudentCards({ skipReviewWorkspace: true })
  }
}

function renderDraftSurface(text, annotations) {
  const safeText = String(text || '')
  if (!safeText) {
    elements.reviewDraftSurface.innerHTML = '<span class="student-meta">(empty draft)</span>'
    return
  }

  const highlightIndexes = reviewHighlightIndexSet(safeText, reviewHighlightRangesForState(currentReviewSession(), getSelectedAssignment()))
  const pendingSelection = normalizedPendingReviewSelection(safeText, reviewState?.selection)
  const selectionIndexes = new Set()
  if (pendingSelection) {
    for (let index = pendingSelection.start; index < pendingSelection.end; index += 1) {
      selectionIndexes.add(index)
    }
  }
  const displayAnnotations = annotations
    .map((annotation) => annotationDisplayState(annotation, safeText))
    .sort((a, b) => a.start - b.start || a.end - b.end)

  let cursor = 0
  const parts = []
  for (const annotation of displayAnnotations) {
    const start = Math.max(0, Math.min(annotation.start, safeText.length))
    const end = Math.max(start, Math.min(annotation.end, safeText.length))
    if (start === end) {
      if (start > cursor) {
        parts.push(renderIndexedSlice(safeText, cursor, start, null, highlightIndexes, selectionIndexes))
      }
      parts.push(
        `<span class="review-annotation-anchor-marker" data-annotation-id="${escapeHtml(annotation.id)}" aria-hidden="true"></span>`,
      )
      cursor = start
      continue
    }
    if (start > cursor) {
      parts.push(renderIndexedSlice(safeText, cursor, start, null, highlightIndexes, selectionIndexes))
    }
    parts.push(renderIndexedSlice(safeText, start, end, annotation, highlightIndexes, selectionIndexes))
    cursor = end
  }
  if (cursor < safeText.length) {
    parts.push(renderIndexedSlice(safeText, cursor, safeText.length, null, highlightIndexes, selectionIndexes))
  }
  elements.reviewDraftSurface.innerHTML = parts.join('')
}

function renderReviewAnnotationList(session) {
  if (!reviewState) return
  const text = String(session?.current_text || '')
  const annotations = reviewState.inlineAnnotations
    .map((annotation) => annotationDisplayState(annotation, text))
    .sort((a, b) => a.start - b.start || a.end - b.end)

  elements.reviewAnnotationMeta.textContent = annotations.length
    ? `${annotations.length} inline ${annotations.length === 1 ? 'note' : 'notes'}`
    : 'No inline notes yet.'

  if (!annotations.length) {
    elements.reviewAnnotationList.innerHTML =
      '<div class="review-annotation-empty">Use Comment on selected text to anchor feedback directly in the draft.</div>'
    return
  }

  elements.reviewAnnotationList.innerHTML = annotations
    .map((annotation, index) => `
      <article class="review-annotation-card${annotation.id === selectedAnnotationId ? ' is-selected' : ''}" data-review-annotation="${escapeHtml(annotation.id)}">
        <div class="review-annotation-head">
          <div class="review-annotation-tag review-annotation-tag-comment">
            ${escapeHtml(`Comment ${String(index + 1).padStart(2, '0')}`)}
          </div>
          <div class="student-meta">${escapeHtml(annotationAnchorLabel(annotation))}</div>
        </div>
        <div class="review-annotation-quote">${escapeHtml(annotation.quote || text.slice(annotation.start, annotation.end) || '(selection unavailable)')}</div>
        <div class="review-annotation-note">${escapeHtml(annotation.note || '')}</div>
        <div class="review-annotation-actions">
          <button class="button button-secondary small-button" type="button" data-focus-annotation="${escapeHtml(annotation.id)}">Show in draft</button>
          <button class="button button-secondary small-button" type="button" data-delete-annotation="${escapeHtml(annotation.id)}">Delete</button>
        </div>
      </article>
    `)
    .join('')

  elements.reviewAnnotationList.querySelectorAll('[data-focus-annotation]').forEach((button) => {
    button.addEventListener('click', () => {
      selectedAnnotationId = button.dataset.focusAnnotation || null
      renderReviewWorkspace(getSelectedAssignment())
      elements.reviewDraftSurface.querySelector(`[data-annotation-id="${CSS.escape(selectedAnnotationId)}"]`)?.scrollIntoView({
        block: 'center',
        behavior: 'smooth',
      })
    })
  })

  elements.reviewAnnotationList.querySelectorAll('[data-delete-annotation]').forEach((button) => {
    button.addEventListener('click', () => deleteReviewAnnotation(button.dataset.deleteAnnotation || ''))
  })
}

function renderReviewRubric(assignment) {
  if (!reviewState) return
  const rubric = Array.isArray(assignment?.rubric) ? assignment.rubric : []
  if (!rubric.length) {
    elements.reviewRubricList.innerHTML =
      '<div class="selection-empty">No rubric is attached to this assignment yet.</div>'
    elements.reviewRubricTotal.textContent = ''
    return
  }

  const total = rubric.reduce((sum, criterion) => sum + Math.max(1, Number(criterion.points || 0)), 0)
  const earned = rubric.reduce(
    (sum, criterion) => sum + Number(reviewState.rubricScores[criterion.id] || 0),
    0,
  )
  elements.reviewRubricTotal.textContent = `${earned}/${total} points selected`
  elements.reviewRubricList.innerHTML = rubric
    .map((criterion) => {
      const max = Math.max(1, Number(criterion.points || 4))
      const options = Array.from({ length: max + 1 }, (_, score) => {
        const selected = Number(reviewState.rubricScores[criterion.id] || 0) === score ? ' selected' : ''
        return `<option value="${score}"${selected}>${score}/${max}</option>`
      }).join('')
      return `
        <label class="review-rubric-row">
          <span class="review-rubric-copy">
            <strong>${escapeHtml(criterion.title)}</strong>
            ${criterion.description ? `<em>${escapeHtml(criterion.description)}</em>` : ''}
          </span>
          <select data-review-rubric-score="${escapeHtml(criterion.id)}">${options}</select>
        </label>
      `
    })
    .join('')

  elements.reviewRubricList.querySelectorAll('[data-review-rubric-score]').forEach((select) => {
    select.addEventListener('change', () => {
      reviewState.rubricScores[select.dataset.reviewRubricScore] = Number(select.value || 0)
      markReviewDirty()
      renderReviewRubric(assignment)
      renderStudentCards({ skipReviewWorkspace: true })
    })
  })
}

function reviewWorkspaceMetaText(selectedAssignment, session, now = Date.now()) {
  if (!selectedAssignment || !session) {
    return ''
  }
  const reviewActivityLabel = isSessionActive(session, now) ? 'Active' : 'Not active'
  return `${selectedAssignment.title} • ${reviewActivityLabel} • last student edit ${timeAgoLabel(
    session.last_activity_at,
    now,
  )}${reviewState?.updatedBy ? ` • last teacher save by ${reviewState.updatedBy}` : ''}`
}

function renderReviewActivityStatus(session = currentReviewSession(), now = Date.now()) {
  if (!elements.reviewActivityStatus) {
    return
  }
  if (!reviewWorkspaceOpen || !session) {
    elements.reviewActivityStatus.hidden = true
    return
  }
  const active = isSessionActive(session, now)
  elements.reviewActivityStatus.hidden = false
  elements.reviewActivityStatus.textContent = active ? 'Active' : 'Not active'
  elements.reviewActivityStatus.className = `student-badge review-activity-status student-badge-${
    active ? 'good' : 'danger'
  }`
}

function renderReviewWorkspaceMeta(selectedAssignment = getSelectedAssignment(), session = currentReviewSession()) {
  if (!elements.reviewWorkspaceMeta || !reviewWorkspaceOpen || !selectedAssignment || !session) {
    return
  }
  elements.reviewWorkspaceMeta.textContent = reviewWorkspaceMetaText(selectedAssignment, session)
  renderReviewActivityStatus(session)
}

function renderReviewWorkspaceLiveContent(selectedAssignment = getSelectedAssignment()) {
  if (!reviewWorkspaceOpen || !reviewState || !selectedAssignment) {
    return
  }
  const session = currentReviewSession()
  if (!session || reviewState.sessionId !== session.id) {
    return
  }
  syncSelectedReviewSessionSnapshot(session)
  elements.reviewWorkspaceTitle.textContent = session.student_name
  renderReviewWorkspaceMeta(selectedAssignment, session)
  const reviewText = displaySessionText(session, reviewState.replayData)
  elements.reviewDraftMeta.textContent = reviewText
    ? `Live draft is ${reviewText.length} characters. Select text to anchor comments.`
    : 'The student draft is still empty.'
  renderReviewHighlightUi(session, selectedAssignment)
  renderDraftSurface(reviewText, reviewState.inlineAnnotations)
  elements.reviewDraftSurface.querySelectorAll('[data-annotation-id]').forEach((node) => {
    node.addEventListener('click', () => {
      selectedAnnotationId = node.dataset.annotationId || null
      renderReviewWorkspace(selectedAssignment)
    })
  })
  renderReviewAnnotationList({
    ...session,
    current_text: reviewText,
  })
  renderReviewSelectionUi()
  renderReviewSyncStatus()
}

function renderReviewWorkspace(selectedAssignment) {
  if (!elements.reviewWorkspace) return
  elements.reviewLayout?.classList.toggle('is-review-open', reviewWorkspaceOpen)
  elements.assignmentView?.classList.toggle('is-review-open', reviewWorkspaceOpen)
  elements.reviewWorkspace.hidden = !reviewWorkspaceOpen
  if (!reviewWorkspaceOpen) {
    renderReviewActivityStatus(null)
    return
  }
  const session = currentReviewSession()
  if (!session || !selectedAssignment) {
    reviewState = null
    selectedAnnotationId = null
    elements.reviewWorkspaceEmpty.hidden = false
    elements.reviewWorkspaceContent.hidden = true
    renderReviewActivityStatus(null)
    renderReviewSyncStatus()
    return
  }
  syncSelectedReviewSessionSnapshot(session)

  if (!reviewState || reviewState.sessionId !== session.id) {
    reviewState = createReviewStateFromSession(session)
    selectedAnnotationId = null
  }

  elements.reviewWorkspaceEmpty.hidden = true
  elements.reviewWorkspaceContent.hidden = false
  elements.reviewWorkspaceTitle.textContent = session.student_name
  renderReviewWorkspaceMeta(selectedAssignment, session)
  elements.reviewGradeLabel.value = reviewState.gradeLabel
  elements.reviewGradeScore.value = reviewState.gradeScore
  elements.reviewTeacherComment.value = reviewState.teacherComment
  elements.reviewReturned.checked = reviewState.returnedForRevision
  const reviewText = displaySessionText(session, reviewState.replayData)
  elements.reviewDraftMeta.textContent = reviewText
    ? `Live draft is ${reviewText.length} characters. Select text to anchor comments.`
    : 'The student draft is still empty.'
  renderReviewHighlightUi(session, selectedAssignment)
  renderReviewRubric(selectedAssignment)
  renderDraftSurface(reviewText, reviewState.inlineAnnotations)
  elements.reviewDraftSurface.querySelectorAll('[data-annotation-id]').forEach((node) => {
    node.addEventListener('click', () => {
      selectedAnnotationId = node.dataset.annotationId || null
      renderReviewWorkspace(selectedAssignment)
    })
  })
  renderReviewAnnotationList({
    ...session,
    current_text: reviewText,
  })
  renderReviewSelectionUi()
  renderReviewSyncStatus()
  void loadReviewReplayData(session)
}

function readReviewDraftSelection() {
  const root = elements.reviewDraftSurface
  const selection = window.getSelection()
  if (!root || !selection || !selection.rangeCount) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) return null
  const text = selection.toString()
  if (!text.trim()) return null
  const prefixRange = range.cloneRange()
  prefixRange.selectNodeContents(root)
  prefixRange.setEnd(range.startContainer, range.startOffset)
  const start = prefixRange.toString().length
  const end = start + text.length
  return {
    start,
    end,
    text,
  }
}

function handleReviewDraftSelection() {
  if (!reviewState) return
  reviewState.selection = readReviewDraftSelection()
  renderReviewWorkspace(getSelectedAssignment())
}

function dashboardRefreshMs() {
  if (currentView === 'assignment' && selectedAssignmentId) {
    return reviewWorkspaceOpen && selectedReviewSessionId
      ? DASHBOARD_REVIEW_REFRESH_MS
      : ASSIGNMENT_VIEW_SUMMARY_REFRESH_MS
  }
  return reviewWorkspaceOpen && selectedReviewSessionId
    ? DASHBOARD_REVIEW_REFRESH_MS
    : DASHBOARD_IDLE_REFRESH_MS
}

function scheduleDashboardRefresh() {
  if (refreshTimer) {
    clearTimeout(refreshTimer)
  }
  refreshTimer = window.setTimeout(async () => {
    if (!document.hidden) {
      await refreshDashboard().catch(() => {})
    }
    scheduleDashboardRefresh()
  }, dashboardRefreshMs())
}

function activeReviewEditorElement() {
  const element = document.activeElement
  if (!element?.closest?.('.review-workspace')) {
    return null
  }
  if (element.matches?.('textarea, input, select')) {
    return element
  }
  return element.isContentEditable ? element : null
}

async function selectReviewSession(sessionId) {
  if (!sessionId) return
  await flushReviewSave()
  reviewWorkspaceOpen = true
  elements.reviewWorkspace?.removeAttribute('hidden')
  const sameSession = selectedReviewSessionId === sessionId
  selectedReviewSessionId = sessionId
  selectedReviewSessionSnapshot =
    getLiveSessions().find((session) => session.id === sessionId) || selectedReviewSessionSnapshot || null
  reviewState = null
  selectedAnnotationId = null
  syncRealtimeSubscriptions()
  scheduleDashboardRefresh()
  renderStudentCards()
  if (sameSession) {
    syncSelectedReviewSessionSnapshot()
  }
  await Promise.all([
    refreshSelectedReviewSessionData(),
    refreshAssignmentViewData(),
    refreshSelectedReviewReplayData(),
  ]).catch(() => {})
}

async function closeReviewWorkspace() {
  await flushReviewSave()
  clearSelectedReviewSession()
  elements.reviewWorkspace?.setAttribute('hidden', '')
  scheduleDashboardRefresh()
  renderStudentCards()
}

function renderMonitoringOverview(matchingSessions) {
  const now = Date.now()
  const activeSessions = matchingSessions.filter((session) => deriveSessionRisk(session, now).active)
  const attentionSessions = matchingSessions.filter((session) => deriveSessionRisk(session, now).needsAttention)
  const unfocusedSessions = matchingSessions.filter((session) => deriveSessionRisk(session, now).active && !session.focused)
  const offlineSessions = matchingSessions.filter((session) => !deriveSessionRisk(session, now).active)
  const editActivity = aggregateRecentEditActivity(matchingSessions)

  elements.overviewStudents.textContent = String(matchingSessions.length)
  elements.overviewStudentsMeta.textContent = `${activeSessions.length} actively reporting`
  elements.overviewAttention.textContent = String(attentionSessions.length)
  elements.overviewAttentionMeta.textContent = attentionSessions.length
    ? 'Students to investigate first'
    : 'No active alerts'
  elements.overviewUnfocused.textContent = String(unfocusedSessions.length)
  elements.overviewUnfocusedMeta.textContent = unfocusedSessions.length
    ? 'Students currently outside the app'
    : 'Everyone is focused'
  elements.overviewOffline.textContent = String(offlineSessions.length)
  elements.overviewOfflineMeta.textContent = offlineSessions.length
    ? 'Students not updating right now'
    : 'All sessions are fresh'
  elements.overviewEdits.textContent = String(editActivity.totalEdits)
  elements.overviewEditsMeta.textContent = editActivity.activeStudents
    ? `${editActivity.activeStudents} student${editActivity.activeStudents === 1 ? '' : 's'} changed text in the last 5 min`
    : 'No recent writing changes'
}

function sessionMatchesFilter(session) {
  const now = Date.now()
  const risk = deriveSessionRisk(session, now)
  const nameMatch = !sessionSearch || String(session.student_name || '').toLowerCase().includes(sessionSearch.toLowerCase())
  if (!nameMatch) {
    return false
  }
  switch (sessionFilter) {
    case 'attention':
      return risk.needsAttention
    case 'active':
      return risk.active
    case 'offline':
      return !risk.active
    default:
      return true
  }
}

function renderStudentCards({ skipReviewWorkspace = false } = {}) {
  const selectedClassroom = getSelectedClassroom()
  const selectedAssignment = getSelectedAssignment()
  const matchingSessions = sessionsForAssignment(
    getLiveSessions(),
    selectedClassroom?.name,
    selectedAssignment?.id,
  )

  const viewTitle = document.getElementById('assignment-view-title')
  const viewMeta = document.getElementById('assignment-view-meta')
  if (selectedAssignment && selectedClassroom) {
    viewTitle.textContent = selectedAssignment.title
    viewMeta.textContent = assignmentViewMeta(selectedAssignment, selectedClassroom, getLiveSessions())
  }

  renderMonitoringOverview(matchingSessions)
  renderAccessRequests(selectedAssignment, matchingSessions)
  if (!selectedClassroom || !selectedAssignment) {
    elements.sessionGrid.innerHTML = `<div class="student-empty">Choose an assignment to see student work.</div>`
    if (!skipReviewWorkspace) {
      renderReviewWorkspace(selectedAssignment)
    }
    return
  }

  if (selectedReviewSessionId && !currentReviewSession()) {
    clearSelectedReviewSession()
  }

  const visibleSessions = sortSessionsForDisplay(matchingSessions).filter(sessionMatchesFilter)

  if (!visibleSessions.length) {
    elements.sessionGrid.innerHTML = `<div class="student-empty">No student sessions match the current filter.</div>`
    if (!skipReviewWorkspace) {
      renderReviewWorkspace(selectedAssignment)
    }
    return
  }

  elements.sessionGrid.innerHTML = visibleSessions
    .map((session) => {
      const now = Date.now()
      const risk = deriveSessionRisk(session, now)
      const replayLink = session.replay_session_id
        ? `<a class="button button-secondary small-button" href="/edu/replay/${escapeHtml(session.replay_session_id)}" target="_blank" rel="noreferrer">Replay</a>`
        : ''
      const statusLabel = risk.active ? 'Active' : 'Offline'
      const statusTone = risk.active ? (session.focused ? 'good' : 'warn') : 'danger'
      const requestKey = normalizeStudentOverrideKey(session.student_name)
      const pendingRequest = selectedAssignment?.student_access_requests?.[requestKey]
      const requestBadge = pendingRequest ? badge('Access requested', 'warn') : ''
      const specialAccessBadge = specialAccessBadgeFor(selectedAssignment, session.student_name, now)
      const accessRevoked = studentAccessRevokedFor(selectedAssignment, session.student_name)
      const accessActionPending = pendingStudentAccessActionFor(session.student_name)
      const closeActionPending = accessActionPending === 'close'
      const extendActionPending = accessActionPending === 'extend'
      const closeAccessButton = accessRevoked
        ? ''
        : `
            <button
              class="button button-danger small-button"
              type="button"
              data-close-student-access="${escapeHtml(session.student_name)}"
              ${accessActionPending ? 'disabled' : ''}
            >
              ${closeActionPending ? 'Closing…' : 'Close access'}
            </button>
          `

      return `
        <article
          class="student-card student-card-risk-${risk.score >= 45 ? 'high' : risk.score >= 20 ? 'medium' : 'low'}${selectedReviewSessionId === session.id ? ' is-selected' : ''}"
          data-review-session="${escapeHtml(session.id)}"
        >
          <div class="student-card-header">
            <div>
              <h2>${escapeHtml(session.student_name)}</h2>
              <div class="student-meta">Last activity ${escapeHtml(timeAgoLabel(session.last_activity_at, now))}</div>
            </div>
            <div class="student-badges">${badge(statusLabel, statusTone)}${specialAccessBadge}${requestBadge}</div>
          </div>
          <div class="student-card-body">
            <div class="student-section">
              <div class="section-label">Status</div>
              <div class="student-meta">${escapeHtml(statusLabel)}</div>
            </div>
            <div class="student-section">
              <div class="section-label">Recent browser URLs</div>
              <ul class="student-urls">${summarizeUrls(session)}</ul>
            </div>
          </div>
          <div class="student-card-footer">
            ${closeAccessButton}
            <button
              class="button button-secondary small-button"
              type="button"
              data-extend-student="${escapeHtml(session.student_name)}"
              ${accessActionPending ? 'disabled' : ''}
            >
              ${extendActionPending ? 'Extending…' : 'Extend this student'}
            </button>
            <button
              class="button button-secondary small-button"
              type="button"
              data-open-review="${escapeHtml(session.id)}"
            >
              Review draft
            </button>
            ${replayLink}
          </div>
        </article>
      `
    })
    .join('')

  elements.sessionGrid.querySelectorAll('[data-close-student-access]').forEach((button) => {
    button.addEventListener('click', async () => {
      const studentName = button.dataset.closeStudentAccess
      if (!studentName || pendingStudentAccessActionFor(studentName)) return
      setPendingStudentAccessAction(studentName, 'close')
      renderStudentCards({ skipReviewWorkspace: true })
      try {
        await closeSelectedAssignmentStudentAccess(studentName)
      } finally {
        clearPendingStudentAccessAction(studentName)
        renderStudentCards({ skipReviewWorkspace: true })
      }
    })
  })

  elements.sessionGrid.querySelectorAll('[data-extend-student]').forEach((button) => {
    button.addEventListener('click', async () => {
      const studentName = button.dataset.extendStudent
      if (!studentName || pendingStudentAccessActionFor(studentName)) return
      setPendingStudentAccessAction(studentName, 'extend')
      renderStudentCards({ skipReviewWorkspace: true })
      const { hour, minute } = selectedTimeParts(elements.quickExtendTime, 15, 0)
      try {
        await extendSelectedAssignmentForStudentToToday(studentName, hour, minute)
      } finally {
        clearPendingStudentAccessAction(studentName)
        renderStudentCards({ skipReviewWorkspace: true })
      }
    })
  })

  elements.sessionGrid.querySelectorAll('[data-open-review]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await selectReviewSession(button.dataset.openReview)
      } catch (error) {
        window.alert(`Could not switch review sessions: ${error.message}`)
      }
    })
  })

  elements.sessionGrid.querySelectorAll('[data-review-session]').forEach((card) => {
    card.addEventListener('click', (event) => {
      if (event.target.closest('button, a')) return
      selectedReviewSessionId = card.dataset.reviewSession || null
      selectedAnnotationId = null
      if (reviewWorkspaceOpen) {
        reviewState = selectedReviewSessionId ? createReviewStateFromSession(currentReviewSession()) : null
      }
      renderStudentCards({ skipReviewWorkspace: true })
    })
  })

  if (!skipReviewWorkspace) {
    renderReviewWorkspace(selectedAssignment)
  }
}

function renderDashboard(data) {
  dashboardState = preserveSelectedReviewSessionInDashboardPayload(data)
  dashboardCursor = String(data?.updated_at || dashboardCursor || '')
  syncSelectionState()
  syncRealtimeSubscriptions()
  renderView()
}

function renderAccessRequests(assignment, matchingSessions = []) {
  if (!elements.accessRequestList) {
    return
  }
  const requests = accessRequestsForAssignment(assignment)
  if (!assignment || !requests.length) {
    elements.accessRequestList.innerHTML = ''
    elements.accessRequestList.closest('.access-request-panel')?.setAttribute('hidden', '')
    return
  }

  const sessionKeys = new Set((matchingSessions || []).map((session) => normalizeStudentOverrideKey(session.student_name)))
  const assignmentOpen = assignmentIsOpenNow(assignment)
  elements.accessRequestList.closest('.access-request-panel')?.removeAttribute('hidden')
  elements.accessRequestList.innerHTML = requests
    .map((entry) => {
      const requestTime = entry.requested_at ? timeAgoLabel(entry.requested_at) : 'just now'
      const linkedToLiveSession = sessionKeys.has(entry.key)
      const approvalPending = pendingAccessRequestApprovals.has(entry.key)
      return `
        <article class="access-request-card">
          <div class="access-request-copy">
            <div class="access-request-title-row">
              <h3>${escapeHtml(entry.student_name)}</h3>
              <span class="student-badge student-badge-warn">Access requested</span>
            </div>
            <div class="student-meta">Requested ${escapeHtml(requestTime)}${linkedToLiveSession ? ' • visible in student list' : ''}</div>
            ${entry.note ? `<p class="access-request-note">${escapeHtml(entry.note)}</p>` : ''}
          </div>
          <div class="access-request-actions">
            ${
              assignmentOpen
                ? '<div class="student-meta">Approve now and use the normal class window.</div>'
                : `
                  <label class="access-request-time">
                    <span>End time</span>
                    <input type="time" value="${escapeHtml(elements.quickExtendTime?.value || '15:00')}" data-access-request-time="${escapeHtml(entry.key)}" />
                  </label>
                `
            }
            <button class="button small-button" type="button" data-approve-access-request="${escapeHtml(entry.key)}" ${approvalPending ? 'disabled' : ''}>
              ${approvalPending ? 'Saving…' : assignmentOpen ? 'Approve now' : 'Approve access'}
            </button>
          </div>
        </article>
      `
    })
    .join('')

  elements.accessRequestList.querySelectorAll('[data-approve-access-request]').forEach((button) => {
    button.addEventListener('click', async () => {
      const requestKey = button.dataset.approveAccessRequest || ''
      const entry = requests.find((item) => item.key === requestKey)
      if (!assignment || !entry) {
        return
      }
      pendingAccessRequestApprovals.add(requestKey)
      renderAccessRequests(assignment, matchingSessions)
      try {
        if (assignmentIsOpenNow(assignment)) {
          await approveAssignmentAccessRequest(assignment, entry)
          return
        }
        const timeInput = elements.accessRequestList.querySelector(`[data-access-request-time="${CSS.escape(requestKey)}"]`)
        const { hour, minute } = selectedTimeParts(timeInput, 15, 0)
        await approveAssignmentAccessRequest(assignment, entry, { hour, minute })
      } catch (error) {
        window.alert(`Could not approve access: ${error.message}`)
      } finally {
        pendingAccessRequestApprovals.delete(requestKey)
        const nextAssignment = getSelectedAssignment()
        if (nextAssignment) {
          renderAccessRequests(nextAssignment, sessionsForAssignment(getLiveSessions(), getSelectedClassroom()?.name, nextAssignment.id))
        }
      }
    })
  })
}

function mergeById(previous, incoming) {
  const map = new Map((previous || []).map((item) => [item.id, item]))
  for (const item of incoming || []) {
    map.set(item.id, item)
  }
  return [...map.values()]
}

function replaceAssignmentInDashboard(updatedAssignment) {
  dashboardState = {
    ...dashboardState,
    assignments: getAssignments().map((item) => (item.id === updatedAssignment.id ? updatedAssignment : item)),
  }
  selectedAssignmentId = updatedAssignment.id
}

async function submitAssignmentUpdateOptimistically(assignment, nextAssignmentPatch) {
  const previousDashboardState = dashboardState
  const optimisticAssignment = {
    ...assignment,
    ...nextAssignmentPatch,
  }

  replaceAssignmentInDashboard(optimisticAssignment)
  renderView()

  try {
    const updatedAssignment = await request(`/api/edu/assignments/${assignment.id}`, {
      method: 'PUT',
      body: JSON.stringify(nextAssignmentPatch),
    })
    replaceAssignmentInDashboard(updatedAssignment)
    renderView()
    return updatedAssignment
  } catch (error) {
    dashboardState = previousDashboardState
    renderView()
    throw error
  }
}

function replaceAssignmentInState(assignment) {
  if (!dashboardState || !assignment) {
    return
  }
  dashboardState = {
    ...dashboardState,
    assignments: getAssignments().map((item) => (item.id === assignment.id ? assignment : item)),
  }
}

function upsertAssignmentInState(assignment) {
  if (!dashboardState || !assignment) {
    return
  }
  dashboardState = {
    ...dashboardState,
    assignments: mergeById(getAssignments(), [assignment]),
  }
}

async function refreshAssignmentViewData() {
  if (!dashboardState || currentView !== 'assignment' || !selectedAssignmentId) {
    return
  }

  const now = Date.now()
  const fetchSummaryBundle =
    now - lastAssignmentViewSummaryRefreshAt >= ASSIGNMENT_VIEW_SUMMARY_REFRESH_MS ||
    !getSelectedAssignment()
  const fetchAudits = now - lastAssignmentViewAuditRefreshAt >= ASSIGNMENT_VIEW_AUDIT_REFRESH_MS
  const fetchSelectedSession = reviewWorkspaceOpen && selectedReviewSessionId

  const requests = []
  if (fetchSummaryBundle) {
    requests.push(request(`/api/edu/assignments/${encodeURIComponent(selectedAssignmentId)}`))
    requests.push(request(`/api/edu/assignments/${encodeURIComponent(selectedAssignmentId)}/live-summaries`))
  } else {
    requests.push(Promise.resolve(null))
    requests.push(Promise.resolve(null))
  }
  requests.push(
    fetchAudits
      ? request(`/api/edu/assignments/${encodeURIComponent(selectedAssignmentId)}/audit`)
      : Promise.resolve(null),
  )
  requests.push(
    fetchSelectedSession
      ? request(`/api/edu/live-sessions/${encodeURIComponent(selectedReviewSessionId)}`).catch((error) => {
        if (error.message === 'Not found') {
          return MISSING_SELECTED_REVIEW_SESSION
        }
        throw error
      })
      : Promise.resolve(null),
  )

  const [assignment, summariesPayload, audits, selectedSession] = await Promise.all(requests)
  const selectedSessionStillInSummaries = Boolean(
    selectedReviewSessionId &&
      Array.isArray(summariesPayload?.live_sessions) &&
      summariesPayload.live_sessions.some((session) => session.id === selectedReviewSessionId),
  )

  if (assignment) {
    replaceAssignmentInState(assignment)
    lastAssignmentViewSummaryRefreshAt = now
  }
  if (summariesPayload?.live_sessions) {
    const nextAssignmentSessions = preserveSelectedReviewSessionInSummaries(summariesPayload.live_sessions)
    dashboardState = {
      ...dashboardState,
      live_sessions: mergeById(
        getLiveSessions().filter((session) => session.assignment_id !== selectedAssignmentId),
        nextAssignmentSessions,
      ),
    }
    lastAssignmentViewSummaryRefreshAt = now
  }
  if (Array.isArray(audits)) {
    const filtered = getAssignmentAudits().filter((item) => item.assignment_id !== selectedAssignmentId)
    dashboardState = {
      ...dashboardState,
      assignment_audits: [...filtered, ...audits],
    }
    lastAssignmentViewAuditRefreshAt = now
  }
  if (selectedSession) {
    if (selectedSession === MISSING_SELECTED_REVIEW_SESSION) {
      if (!selectedSessionStillInSummaries) {
        syncSelectedReviewSessionSnapshot()
      }
    } else {
      dashboardState = {
        ...dashboardState,
        live_sessions: mergeById(getLiveSessions(), [selectedSession]),
      }
      syncSelectedReviewSessionSnapshot(selectedSession)
    }
  }

  renderStudentCards()
  await refreshSelectedReviewReplayData()
}

function applyDashboardDelta(delta) {
  if (!dashboardState) {
    renderDashboard(delta)
    return
  }
  dashboardState = {
    ...dashboardState,
    updated_at: delta.updated_at || dashboardState.updated_at,
    summary: delta.summary || dashboardState.summary,
    classrooms: Array.isArray(delta.classrooms) ? delta.classrooms : dashboardState.classrooms,
    assignments: Array.isArray(delta.assignments) ? delta.assignments : dashboardState.assignments,
    live_sessions: mergeById(dashboardState.live_sessions, delta.live_sessions),
    assignment_audits: mergeById(dashboardState.assignment_audits, delta.assignment_audits),
  }
  if (Array.isArray(delta.replays) && dashboardState.summary) {
    dashboardState.summary.replays_available = Math.max(
      Number(dashboardState.summary.replays_available || 0),
      Number(delta.summary?.replays_available || dashboardState.summary.replays_available || 0),
    )
  }
  dashboardCursor = String(delta.updated_at || dashboardCursor || '')
  syncSelectionState()
  const selectedSession =
    reviewWorkspaceOpen && selectedReviewSessionId
      ? getLiveSessions().find((session) => session.id === selectedReviewSessionId) || null
      : null
  if (selectedSession) {
    selectedReviewSessionSnapshot = { ...selectedSession }
    if (reviewState?.sessionId === selectedSession.id) {
      renderReviewWorkspaceLiveContent(getSelectedAssignment())
    }
  }
  if (activeReviewEditorElement()) {
    if (currentView === 'assignment') {
      renderStudentCards({ skipReviewWorkspace: true })
    }
    return
  }
  renderView()
}

function isFullDashboardPayload(payload) {
  return Boolean(
    payload &&
    Array.isArray(payload.classrooms) &&
    Array.isArray(payload.assignments) &&
    Array.isArray(payload.live_sessions) &&
    Array.isArray(payload.assignment_audits) &&
    payload.summary,
  )
}

function renderView() {
  syncSelectionState()
  syncRealtimeSubscriptions()
  if (elements.deleteClassroomButton) {
    elements.deleteClassroomButton.disabled = !getSelectedClassroom()
  }
  if (elements.quickExtendButton) {
    elements.quickExtendButton.disabled = !getSelectedAssignment()
  }
  if (elements.quickExtendTime) {
    elements.quickExtendTime.disabled = !getSelectedAssignment()
  }
  if (elements.deleteAssignmentButton) {
    elements.deleteAssignmentButton.disabled = !getSelectedAssignment()
  }

  if (currentView === 'assignment' && selectedAssignmentId) {
    elements.classesView.hidden = true
    elements.assignmentsView.hidden = true
    elements.assignmentView.hidden = false
    renderStudentCards()
  } else if (currentView === 'assignments' && getSelectedClassroom()) {
    elements.classesView.hidden = true
    elements.assignmentsView.hidden = false
    elements.assignmentView.hidden = true
    elements.assignmentStage.hidden = false
    renderAssignmentStage()
  } else {
    elements.classesView.hidden = false
    elements.assignmentsView.hidden = true
    elements.assignmentView.hidden = true
    elements.classroomStage.hidden = false
    renderClassroomGrid()
  }
}

function showAssignmentView() {
  currentView = 'assignment'
  resetAssignmentViewRefreshState()
  renderView()
}

function showClassesView() {
  currentView = 'classes'
  selectedAssignmentId = null
  resetAssignmentViewRefreshState()
  renderView()
}

function showAssignmentsView() {
  currentView = getSelectedClassroom() ? 'assignments' : 'classes'
  resetAssignmentViewRefreshState()
  renderView()
}

async function refreshDashboard() {
  if (refreshInFlight) {
    refreshQueued = true
    return
  }
  refreshInFlight = true
  try {
    if (!dashboardState) {
      renderDashboard(await request('/api/edu/dashboard'))
      return
    }
    if (currentView === 'assignment' && selectedAssignmentId) {
      await refreshAssignmentViewData()
      return
    }
    const delta = await request(`/api/edu/dashboard/updates?since=${encodeURIComponent(dashboardCursor || '')}`)
    if (dashboardDeltaNeedsFullRefresh(dashboardState, delta)) {
      renderDashboard(await request('/api/edu/dashboard'))
      await refreshSelectedReviewReplayData()
      return
    }
    applyDashboardDelta(delta)
    await refreshSelectedReviewReplayData()
  } finally {
    refreshInFlight = false
    if (refreshQueued) {
      refreshQueued = false
      refreshDashboard().catch(() => {})
    }
  }
}

function startDashboardRefresh() {
  scheduleDashboardRefresh()
  syncRealtimeSubscriptions()
  if (!statusTickTimer) {
    statusTickTimer = window.setInterval(() => {
      if (!document.hidden && reviewWorkspaceOpen) {
        renderReviewWorkspaceMeta()
      }
      if (!document.hidden && dashboardState && !reviewWorkspaceOpen && !activeReviewEditorElement()) {
        renderView()
      }
    }, TEACHER_STATUS_TICK_MS)
  }
  if (!dashboardVisibilityRefreshBound) {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        refreshDashboard().catch(() => {})
      }
      scheduleDashboardRefresh()
    })
    dashboardVisibilityRefreshBound = true
  }
}

function dayLabel(days) {
  const labels = Object.entries(days || {})
    .filter(([, value]) => Boolean(value))
    .map(([name]) => name.slice(0, 3))
  return labels.length ? labels.join(', ') : 'No days selected'
}

function renderValidationList(element, items) {
  element.innerHTML = items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')
  element.hidden = !items.length
}

function validateAssignmentDraft() {
  const form = new FormData(elements.assignmentForm)
  const errors = []
  const warnings = []
  const days = readWindowDays(form)
  const hasDay = Object.values(days).some(Boolean)
  const start = parseTimeParts(form.get('window_start_time'), 10, 0)
  const end = parseTimeParts(form.get('window_end_time'), 11, 0)
  const startMinutes = start.hour * 60 + start.minute
  const endMinutes = end.hour * 60 + end.minute
  const browserEnabled = form.get('browser_enabled') === 'on'
  const homeUrl = String(form.get('browser_home_url') || '').trim()
  const domains = String(form.get('browser_allowed_domains') || '')
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean)

  if (!hasDay) {
    errors.push('Select at least one day of the week.')
  }
  if (endMinutes <= startMinutes) {
    errors.push('End time must be after start time.')
  }
  if (browserEnabled && !homeUrl) {
    errors.push('Study browser is enabled, so a home URL is required.')
  }
  if (browserEnabled && !domains.length) {
    warnings.push('Study browser is enabled without any URL rules.')
  }
  if (form.get('require_lockdown') === 'on' && form.get('browser_enabled') !== 'on') {
    warnings.push('Lockdown is on and the study browser is disabled. Students will only have the writing workspace.')
  }
  const fontSize = Number(form.get('editor_font_size') || 12)
  if (!Number.isFinite(fontSize) || fontSize < 10 || fontSize > 100) {
    errors.push('Font size must be between 10 and 100.')
  }

  return { errors, warnings }
}

function updateAssignmentFormGuidance() {
  const { errors } = validateAssignmentDraft()
  elements.assignmentFormSubmit.disabled = assignmentFormSubmitting || errors.length > 0
}

function setAssignmentFormSubmitting(isSubmitting, isEditing = false) {
  assignmentFormSubmitting = Boolean(isSubmitting)
  elements.assignmentFormSubmit.textContent = assignmentFormSubmitting
    ? (isEditing ? 'Saving...' : 'Creating...')
    : (isEditing ? 'Save changes' : 'Create assignment')
  if (elements.assignmentFormCancel) {
    elements.assignmentFormCancel.disabled = assignmentFormSubmitting
  }
  updateAssignmentFormGuidance()
}

function wireModalButtons() {
  elements.newClassroomButton.addEventListener('click', () => openModal(elements.classroomModal))

  elements.deleteClassroomButton?.addEventListener('click', async () => {
    const classroom = getSelectedClassroom()
    if (!classroom) {
      window.alert('Select a class first.')
      return
    }
    if (!window.confirm(`Delete ${classroom.name}? This will also remove its assignments.`)) {
      return
    }
    try {
      await request(`/api/edu/classrooms/${classroom.id}`, { method: 'DELETE' })
      selectedClassroomId = null
      selectedAssignmentId = null
      currentView = 'classes'
      dashboardState = null
      await refreshDashboard()
    } catch (error) {
      window.alert(`Could not delete class: ${error.message}`)
    }
  })

  elements.newAssignmentButton.addEventListener('click', () => {
    if (!getSelectedClassroom()) {
      window.alert('Create or select a class first.')
      return
    }
    resetAssignmentModal()
    openModal(elements.assignmentModal)
  })

  elements.editAssignmentButton?.addEventListener('click', () => {
    const assignment = getSelectedAssignment()
    if (!assignment) {
      window.alert('Select an assignment first.')
      return
    }
    populateAssignmentModalForEdit(assignment)
    openModal(elements.assignmentModal)
  })

  elements.deleteAssignmentButton?.addEventListener('click', async () => {
    const assignment = getSelectedAssignment()
    if (!assignment) {
      window.alert('Select an assignment first.')
      return
    }
    if (!window.confirm(`Are you sure you want to delete ${assignment.title}? This will remove the assignment and all student submissions.`)) {
      return
    }
    try {
      await request(`/api/edu/assignments/${assignment.id}`, { method: 'DELETE' })
      selectedAssignmentId = null
      currentView = getSelectedClassroom() ? 'assignments' : 'classes'
      dashboardState = null
      await refreshDashboard()
      renderView()
    } catch (error) {
      window.alert(`Could not delete assignment: ${error.message}`)
    }
  })

  elements.quickExtendButton?.addEventListener('click', async () => {
    elements.quickExtendButton.disabled = true
    try {
      const time = selectedTimeParts(elements.quickExtendTime)
      await extendSelectedAssignmentToToday(time.hour, time.minute)
      if (elements.quickExtendStatus) {
        elements.quickExtendStatus.hidden = false
        elements.quickExtendStatus.textContent = `Extended until ${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')} today.`
      }
    } catch (error) {
      window.alert(`Could not extend access: ${error.message}`)
    } finally {
      elements.quickExtendButton.disabled = !getSelectedAssignment()
    }
  })

  elements.modalCloseButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const modalId = button.dataset.closeModal
      if (modalId === 'classroom-modal') closeModal(elements.classroomModal)
      if (modalId === 'assignment-modal') closeModal(elements.assignmentModal)
      if (modalId === 'feedback-modal') closeModal(elements.feedbackModal)
    })
  })

  ;[elements.classroomModal, elements.assignmentModal, elements.feedbackModal].forEach((modal) => {
    modal.addEventListener('click', (event) => {
      if (event.target === modal) closeModal(modal)
    })
  })

  document.getElementById('back-to-classes-button')?.addEventListener('click', () => showClassesView())
  document.getElementById('back-to-assignments-button')?.addEventListener('click', () => showAssignmentsView())
  elements.feedbackButton?.addEventListener('click', () => openModal(elements.feedbackModal))
  elements.assignmentAddStudentOverride?.addEventListener('click', () => {
    const drafts = currentStudentOverrideDrafts()
    assignmentStudentOverrideDrafts = [
      ...drafts,
      createStudentOverrideDraft({ student_name: nextStudentOverrideName(drafts) }),
    ]
    renderStudentOverrideCards(assignmentStudentOverrideDrafts)
  })
  elements.assignmentReferenceUpload?.addEventListener('change', async (event) => {
    try {
      await handleReferenceDocumentUpload(event.currentTarget.files)
    } catch (error) {
      window.alert(error.message)
    }
  })
  elements.starterDocumentToolbar?.querySelectorAll('[data-starter-command]').forEach((button) => {
    button.addEventListener('click', () => {
      execStarterDocumentCommand(button.dataset.starterCommand)
    })
  })
  elements.starterDocumentEditor?.addEventListener('input', () => {
    syncStarterDocumentField()
    updateAssignmentFormGuidance()
  })
  elements.assignmentAddRubric?.addEventListener('click', () => {
    renderRubricBuilder([...selectedRubricFromForm(), createRubricDraft({ title: '', points: 4 })])
  })
  elements.assignmentFormCancel?.addEventListener('click', () => {
    closeModal(elements.assignmentModal)
    resetAssignmentModal()
  })
  elements.feedbackFormCancel?.addEventListener('click', () => {
    closeModal(elements.feedbackModal)
    elements.feedbackForm?.reset()
  })
  elements.feedbackForm?.addEventListener('submit', (event) => {
    event.preventDefault()
    if (!openFeedbackDraft(new FormData(event.currentTarget))) {
      return
    }
    closeModal(elements.feedbackModal)
    elements.feedbackForm.reset()
  })
}

function resetAssignmentModal() {
  assignmentFormSubmitting = false
  elements.assignmentIdInput.value = ''
  elements.assignmentModalLabel.textContent = 'Create assignment'
  elements.assignmentModalTitle.textContent = 'New assignment'
  elements.assignmentFormSubmit.textContent = 'Create assignment'
  elements.assignmentFormSubmit.disabled = false
  elements.assignmentFormCancel.hidden = true
  elements.assignmentFormCancel.disabled = false
  elements.assignmentForm.reset()
  elements.assignmentForm.elements.namedItem('require_lockdown').checked = true
  elements.assignmentForm.elements.namedItem('editor_font_locked').checked = false
  setStarterDocumentMarkdown('')
  elements.assignmentForm.elements.namedItem('editor_font_family').value = 'arial'
  elements.assignmentForm.elements.namedItem('editor_font_size').value = '12'
  elements.assignmentForm.elements.namedItem('editor_line_height').value = 'relaxed'
  if (elements.quickExtendStatus) {
    elements.quickExtendStatus.hidden = true
    elements.quickExtendStatus.textContent = ''
  }
  assignmentStudentOverrideDrafts = []
  assignmentReferenceDocuments = []
  renderAssignedStudentOptions([])
  renderStudentOverrideCards([])
  renderLinkedAssignmentOptions([])
  renderReferenceDocumentList([])
  renderRubricBuilder([])
  updateAssignmentFormGuidance()
}

function populateAssignmentModalForEdit(assignment) {
  assignmentFormSubmitting = false
  elements.assignmentIdInput.value = assignment.id
  elements.assignmentModalLabel.textContent = 'Edit assignment'
  elements.assignmentModalTitle.textContent = assignment.title
  elements.assignmentFormSubmit.textContent = 'Save changes'
  elements.assignmentFormSubmit.disabled = false
  elements.assignmentFormCancel.hidden = false
  elements.assignmentFormCancel.disabled = false

  const form = elements.assignmentForm
  const field = (name) => form.elements.namedItem(name)
  field('title').value = assignment.title || ''
  field('prompt').value = assignment.prompt || ''

  if (assignment.windows?.[0]) {
    const win = assignment.windows[0]
    field('window_start_time').value = `${String(win.start_hour).padStart(2, '0')}:${String(win.start_minute).padStart(2, '0')}`
    field('window_end_time').value = `${String(win.end_hour).padStart(2, '0')}:${String(win.end_minute).padStart(2, '0')}`
    field('window_end_date').value = win.end_date || ''
    field('day_monday').checked = win.days?.monday ?? true
    field('day_tuesday').checked = win.days?.tuesday ?? true
    field('day_wednesday').checked = win.days?.wednesday ?? true
    field('day_thursday').checked = win.days?.thursday ?? true
    field('day_friday').checked = win.days?.friday ?? true
    field('day_saturday').checked = win.days?.saturday ?? false
    field('day_sunday').checked = win.days?.sunday ?? false
  }

  if (assignment.policy) {
    field('allow_dictation').checked = assignment.policy.allow_dictation ?? false
    field('allow_offline_editing').checked = assignment.policy.allow_offline_editing ?? true
    field('copy_paste_allowed').checked = assignment.policy.copy_paste_allowed ?? false
    field('export_allowed').checked = assignment.policy.export_allowed ?? false
    field('images_allowed').checked = assignment.policy.images_allowed ?? false
    field('require_lockdown').checked = assignment.policy.require_lockdown ?? false
    field('require_permission_to_rejoin').checked = assignment.policy.require_permission_to_rejoin ?? false
    field('show_rubric_to_student').checked = assignment.policy.show_rubric_to_student ?? false
  }

  if (assignment.editor_policy) {
    setStarterDocumentMarkdown(assignment.starter_document || '')
    field('editor_font_family').value = assignment.editor_policy.font_family || 'arial'
    field('editor_font_size').value = String(assignment.editor_policy.font_size ?? 12)
    field('editor_line_height').value = assignment.editor_policy.line_height || 'relaxed'
    field('editor_font_locked').checked = assignment.editor_policy.font_locked ?? false
  } else {
    setStarterDocumentMarkdown(assignment.starter_document || '')
  }

  if (assignment.browser_policy) {
    field('browser_enabled').checked = assignment.browser_policy.browser_enabled ?? false
    field('browser_mode').value = assignment.browser_policy.mode === 'blacklist' ? 'blacklist' : 'whitelist'
    field('browser_home_url').value = assignment.browser_policy.home_url || ''
    field('browser_allowed_domains').value = (assignment.browser_policy.allowed_domains || []).join('\n')
  }
  const assignedStudents = Array.isArray(assignment.assigned_students) ? assignment.assigned_students : []
  renderAssignedStudentOptions(assignedStudents)
  renderStudentOverrideCards(draftsFromAssignmentStudentOverrides(assignment))
  renderLinkedAssignmentOptions(assignment.linked_assignment_ids || [])
  renderReferenceDocumentList(assignment.reference_documents || [])
  renderRubricBuilder(assignment.rubric || [])
  updateAssignmentFormGuidance()
}

function wireForms() {
  elements.classroomForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    const formEl = event.currentTarget
    try {
      const form = new FormData(formEl)
      await request('/api/edu/classrooms', {
        method: 'POST',
        body: JSON.stringify({
          name: form.get('name'),
          teacher_name: teacherSession?.teacher_name || 'Teacher',
          join_code: form.get('join_code') || undefined,
        }),
      })
      formEl.reset()
      closeModal(elements.classroomModal)
      dashboardState = null
      await refreshDashboard()
    } catch (error) {
      window.alert(`Could not create class: ${error.message}`)
    }
  })

  elements.assignmentForm.addEventListener('input', updateAssignmentFormGuidance)
  elements.assignmentForm.addEventListener('change', updateAssignmentFormGuidance)
  elements.assignmentForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    const formEl = event.currentTarget
    if (assignmentFormSubmitting) {
      return
    }
    const validation = validateAssignmentDraft()
    if (validation.errors.length) {
      updateAssignmentFormGuidance()
      return
    }

    try {
      syncStarterDocumentField()
      const form = new FormData(formEl)
      const assignmentId = form.get('assignment_id')
      const isEditing = !!assignmentId
      setAssignmentFormSubmitting(true, isEditing)
      const activeClassroom = getSelectedClassroom()
      const startTime = parseTimeParts(form.get('window_start_time'), 10, 0)
      const endTime = parseTimeParts(form.get('window_end_time'), 11, 0)
      const studentOverrides = selectedStudentOverridesFromForm()

      if (!isEditing && !activeClassroom) {
        window.alert('Choose a class first before creating an assignment.')
        return
      }

      const payload = {
        title: form.get('title'),
        course: activeClassroom ? activeClassroom.name : getSelectedClassroom()?.name || '',
        classroom_id: isEditing ? undefined : activeClassroom?.id,
        classroom_name: isEditing ? undefined : activeClassroom?.name,
        assigned_students: selectedAssignedStudentsFromForm(),
        prompt: form.get('prompt'),
        starter_document: form.get('starter_document') || '',
        windows: [
          {
            label: 'Teacher writing window',
            days: readWindowDays(form),
            end_date: form.get('window_end_date') || null,
            start_hour: startTime.hour,
            start_minute: startTime.minute,
            end_hour: endTime.hour,
            end_minute: endTime.minute,
          },
        ],
        student_temporary_access_until: studentOverrides.studentTemporaryAccessUntil,
        policy: {
          allow_dictation: form.get('allow_dictation') === 'on',
          allow_offline_editing: form.get('allow_offline_editing') === 'on',
          copy_paste_allowed: form.get('copy_paste_allowed') === 'on',
          export_allowed: form.get('export_allowed') === 'on',
          images_allowed: form.get('images_allowed') === 'on',
          require_lockdown: form.get('require_lockdown') === 'on',
          require_permission_to_rejoin: form.get('require_permission_to_rejoin') === 'on',
          require_fullscreen: form.get('require_lockdown') === 'on',
          show_rubric_to_student: form.get('show_rubric_to_student') === 'on',
        },
        editor_policy: {
          font_family: String(form.get('editor_font_family') || 'arial'),
          font_size: Number(form.get('editor_font_size') || 12),
          line_height: String(form.get('editor_line_height') || 'relaxed'),
          font_locked: form.get('editor_font_locked') === 'on',
        },
        browser_policy: {
          browser_enabled: form.get('browser_enabled') === 'on',
          mode: form.get('browser_mode') === 'blacklist' ? 'blacklist' : 'whitelist',
          home_url: form.get('browser_home_url') || '',
          allowed_domains: String(form.get('browser_allowed_domains') || '')
            .split('\n')
            .map((value) => value.trim())
            .filter(Boolean),
        },
        student_overrides: studentOverrides.studentOverrides,
        linked_assignment_ids: [...new Set(form.getAll('linked_assignment_ids').map((value) => String(value).trim()).filter(Boolean))],
        reference_documents: assignmentReferenceDocuments,
        rubric: selectedRubricFromForm(),
      }

      let savedAssignment
      if (isEditing) {
        savedAssignment = await request(`/api/edu/assignments/${assignmentId}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        })
      } else {
        savedAssignment = await request('/api/edu/assignments', {
          method: 'POST',
          body: JSON.stringify(payload),
        })
      }

      formEl.reset()
      resetAssignmentModal()
      closeModal(elements.assignmentModal)
      if (savedAssignment) {
        upsertAssignmentInState(savedAssignment)
        selectedAssignmentId = savedAssignment.id
        if (selectedClassroomId === savedAssignment.classroom_id) {
          currentView = 'assignments'
        }
      }
      renderView()
      refreshDashboard().catch(() => {})
    } catch (error) {
      window.alert(`Could not save assignment: ${error.message}`)
    } finally {
      setAssignmentFormSubmitting(false, Boolean(elements.assignmentIdInput.value))
    }
  })
}

function wireMonitoringControls() {
  elements.sessionFilterBar?.querySelectorAll('[data-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      sessionFilter = button.dataset.filter || 'all'
      elements.sessionFilterBar.querySelectorAll('[data-filter]').forEach((node) => {
        node.classList.toggle('is-selected', node === button)
      })
      renderStudentCards()
    })
  })

  elements.sessionSearchInput?.addEventListener('input', () => {
    sessionSearch = elements.sessionSearchInput.value.trim()
    renderStudentCards()
  })
}

function wireReviewWorkspace() {
  elements.reviewGradeLabel?.addEventListener('input', () => {
    if (!reviewState) return
    reviewState.gradeLabel = elements.reviewGradeLabel.value
    markReviewDirty()
    renderStudentCards({ skipReviewWorkspace: true })
  })

  elements.reviewGradeScore?.addEventListener('input', () => {
    if (!reviewState) return
    reviewState.gradeScore = elements.reviewGradeScore.value
    markReviewDirty()
    renderStudentCards({ skipReviewWorkspace: true })
  })

  elements.reviewTeacherComment?.addEventListener('input', () => {
    if (!reviewState) return
    reviewState.teacherComment = elements.reviewTeacherComment.value
    markReviewDirty()
  })

  elements.reviewReturned?.addEventListener('change', () => {
    if (!reviewState) return
    reviewState.returnedForRevision = elements.reviewReturned.checked
    markReviewDirty()
    renderStudentCards({ skipReviewWorkspace: true })
  })

  elements.reviewHighlightDate?.addEventListener('input', () => {
    if (!reviewState) return
    reviewState.highlightDate = elements.reviewHighlightDate.value
    renderReviewWorkspace(getSelectedAssignment())
  })

  elements.reviewHighlightAfterSchoolDay?.addEventListener('click', () => {
    if (!reviewState) return
    reviewState.highlightMode = 'after-school-day'
    renderReviewWorkspace(getSelectedAssignment())
  })

  elements.reviewHighlightAfterSchoolAll?.addEventListener('click', () => {
    if (!reviewState) return
    reviewState.highlightMode = 'after-school-all'
    renderReviewWorkspace(getSelectedAssignment())
  })

  elements.reviewHighlightClear?.addEventListener('click', () => {
    if (!reviewState) return
    reviewState.highlightMode = 'none'
    renderReviewWorkspace(getSelectedAssignment())
  })

  elements.reviewComposerNote?.addEventListener('input', () => {
    if (!reviewState) return
    reviewState.composerNote = elements.reviewComposerNote.value
  })

  elements.reviewDraftSurface?.addEventListener('mouseup', handleReviewDraftSelection)
  elements.reviewDraftSurface?.addEventListener('keyup', handleReviewDraftSelection)

  elements.reviewCommentMode?.addEventListener('click', () => beginReviewComposer('comment'))
  elements.reviewCancelAnnotation?.addEventListener('click', clearReviewComposer)
  elements.reviewAddAnnotation?.addEventListener('click', addReviewAnnotation)
  elements.reviewCloseButton?.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    closeReviewWorkspace().catch((error) => {
      window.alert(`Could not close review: ${error.message}`)
    })
  })
  elements.reviewBackButton?.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    closeReviewWorkspace().catch((error) => {
      window.alert(`Could not close review: ${error.message}`)
    })
  })

  window.addEventListener('beforeunload', () => {
    if (reviewSaveTimer) {
      clearTimeout(reviewSaveTimer)
      reviewSaveTimer = null
    }
  })
}

async function loadApp() {
  teacherSession = await request('/api/edu/auth/session')
  if (!teacherSession.authenticated) {
    window.location.href = '/edu/login'
    return
  }

  elements.logoutButton.hidden = false
  elements.logoutButton.addEventListener('click', async () => {
    await request('/api/edu/auth/logout', { method: 'POST' })
    window.location.href = '/edu/login'
  })

  elements.authPanel.innerHTML = `
    <div class="section-label">Signed in</div>
    <h2>${escapeHtml(teacherSession.teacher_name)}</h2>
    <p class="subhead">${escapeHtml(teacherSession.teacher_email || '')}</p>
  `

  wireModalButtons()
  populateAssignmentFontSizeOptions()
  wireForms()
  wireMonitoringControls()
  wireReviewWorkspace()
  await refreshDashboard()
  startDashboardRefresh()
}

loadApp().catch((error) => {
  document.body.innerHTML = `<div style="padding:32px;font-family:'Open Sans', Arial, Helvetica, sans-serif">Could not load Handtyped EDU: ${escapeHtml(error.message)}</div>`
})
