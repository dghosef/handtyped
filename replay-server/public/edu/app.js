import {
  applyLiveReplayUpdates,
  assignmentIsOpenNow,
  assignmentViewMeta,
  dashboardDeltaNeedsFullRefresh,
  deriveSessionRisk,
  focusLossSummary,
  formatClockTime,
  formatWindowSummary,
  isSessionActive,
  localDateTimeInputValue,
  recentEditActivityCurve,
  reconcileTeacherNavigation,
  reviewDraftRenderMode,
  reviewDraftRenderSignature,
  sessionPresenceTimestamp,
  sessionStatusLabel,
  sessionsForAssignment,
  sortSessionsForDisplay,
  studentRejoinHistorySummary,
  timeAgoLabel,
  todayAtLocalTime,
  wholeClassExtensionLabel,
} from './app-ui.js'
import { buildAttributedDocument, latestTextFromHistory } from '../replay-view.js'

const DASHBOARD_IDLE_REFRESH_MS = 15000
const DASHBOARD_REVIEW_REFRESH_MS = 5000
const ASSIGNMENT_VIEW_SUMMARY_REFRESH_MS = 5000
const ASSIGNMENT_VIEW_AUDIT_REFRESH_MS = 30000
const TEACHER_STATUS_TICK_MS = 1000
const REALTIME_EVENT_STALE_FALLBACK_MS = 7000
const REVIEW_LIVE_ATTRIBUTION_MAX_SYNTHETIC_INSERT_CHARS = 80
const REVIEW_LIVE_ATTRIBUTION_MAX_SYNTHETIC_DELETE_CHARS = 20
const REVIEW_SYNC_RETRY_MS = 2000
const COMMENT_CONTEXT_WINDOW = 24
const TEACHER_HISTORY_APP_KEY = 'handtyped-teacher'

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
const pendingStudentAccessActions = new Map()
const pendingAccessRequestApprovals = new Set()
const pendingFeedbackRequestDismissals = new Set()
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
let editActivityWindowMinutes = 5
let teacherRealtimeKey = ''
let assignmentRealtimeKey = ''
let replayRealtimeKey = ''
let assignmentFormSubmitting = false
let classroomFormSubmitting = false
let assignmentFormToastTimer = null
let reviewDraftSurfaceHtml = ''
let reviewDraftSurfaceSignature = ''
let reviewLiveContentRenderRaf = 0
let teacherHistoryInitialized = false
let teacherHistoryRestoring = false
let lastTeacherHistoryKey = ''

const realtimeDebugState = {
  teacher: 'idle',
  assignment: 'idle',
  replay: 'idle',
  lastEventAt: 0,
  lastEvent: '',
  lastFallbackAt: 0,
  lastFallback: '',
  lastErrorAt: 0,
  lastError: '',
}

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
  classroomRosterPanel: document.getElementById('classroom-roster-panel'),
  assignmentGrid: document.getElementById('assignment-grid'),
  sessionGrid: document.getElementById('session-grid'),
  assignmentMonitoringStatus: document.getElementById('assignment-monitoring-status'),
  newClassroomButton: document.getElementById('new-classroom-button'),
  deleteClassroomButton: document.getElementById('delete-classroom-button'),
  newAssignmentButton: document.getElementById('new-assignment-button'),
  editAssignmentButton: document.getElementById('edit-assignment-button'),
  deleteAssignmentButton: document.getElementById('delete-assignment-button'),
  quickExtendButton: document.getElementById('quick-extend-button'),
  quickExtendDate: document.getElementById('quick-extend-date'),
  quickExtendTime: document.getElementById('quick-extend-time'),
  quickExtendStatus: document.getElementById('quick-extend-status'),
  classroomForm: document.getElementById('classroom-form'),
  classroomFormSubmit: document.getElementById('classroom-form-submit'),
  assignmentForm: document.getElementById('assignment-form'),
  assignmentIdInput: document.getElementById('assignment-id-input'),
  assignmentModalLabel: document.getElementById('assignment-modal-label'),
  assignmentModalTitle: document.getElementById('assignment-modal-title'),
  assignmentFormSubmit: document.getElementById('assignment-form-submit'),
  assignmentFormCancel: document.getElementById('assignment-form-cancel'),
  assignmentFormToast: document.getElementById('assignment-form-toast'),
  assignmentFormErrors: document.getElementById('assignment-form-errors'),
  assignmentFormWarnings: document.getElementById('assignment-form-warnings'),
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
  studentExtensionModal: document.getElementById('student-extension-modal'),
  studentExtensionForm: document.getElementById('student-extension-form'),
  studentExtensionTitle: document.getElementById('student-extension-title'),
  studentExtensionDate: document.getElementById('student-extension-date'),
  studentExtensionTime: document.getElementById('student-extension-time'),
  studentExtensionCancel: document.getElementById('student-extension-cancel'),
  feedbackModal: document.getElementById('feedback-modal'),
  feedbackForm: document.getElementById('feedback-form'),
  feedbackFormCancel: document.getElementById('feedback-form-cancel'),
  modalCloseButtons: document.querySelectorAll('[data-close-modal]'),
  accessRequestList: document.getElementById('access-request-list'),
  feedbackRequestList: document.getElementById('feedback-request-list'),
  assignmentEditActivityPanel: document.getElementById('assignment-edit-activity-panel'),
  editActivitySummary: document.getElementById('edit-activity-summary'),
  editActivityWindowButtons: [...document.querySelectorAll('[data-edit-activity-window]')],
  reviewWorkspace: document.getElementById('review-workspace'),
  reviewLayout: document.getElementById('review-layout'),
  reviewWorkspaceEmpty: document.getElementById('review-workspace-empty'),
  reviewWorkspaceContent: document.getElementById('review-workspace-content'),
  reviewWorkspaceTitle: document.getElementById('review-workspace-title'),
  reviewWorkspaceMeta: document.getElementById('review-workspace-meta'),
  reviewActivityStatus: document.getElementById('review-activity-status'),
  reviewRealtimeDebug: document.getElementById('review-realtime-debug'),
  reviewEditActivity: document.getElementById('review-edit-activity'),
  reviewFocusLosses: document.getElementById('review-focus-losses'),
  reviewSyncStatus: document.getElementById('review-sync-status'),
  reviewGradeLabel: document.getElementById('review-grade-label'),
  reviewGradeScore: document.getElementById('review-grade-score'),
  reviewRubricTotal: document.getElementById('review-rubric-total'),
  reviewRubricList: document.getElementById('review-rubric-list'),
  reviewTeacherComment: document.getElementById('review-teacher-comment'),
  reviewReturned: document.getElementById('review-returned'),
  reviewPublishFeedback: document.getElementById('review-publish-feedback'),
  reviewDeleteFeedback: document.getElementById('review-delete-feedback'),
  reviewPublishConfirmation: document.getElementById('review-publish-confirmation'),
  reviewDraftMeta: document.getElementById('review-draft-meta'),
  reviewDraftSurface: document.getElementById('review-draft-surface'),
  reviewSelectionCount: document.getElementById('review-selection-count'),
  reviewSelectionPanel: document.getElementById('review-selection-panel'),
  reviewSelectionQuote: document.getElementById('review-selection-quote'),
  reviewHighlightDate: document.getElementById('review-highlight-date'),
  reviewHighlightDates: document.getElementById('review-highlight-dates'),
  reviewHighlightStartTime: document.getElementById('review-highlight-start-time'),
  reviewHighlightEndTime: document.getElementById('review-highlight-end-time'),
  reviewHighlightWeekdays: [...document.querySelectorAll('input[name="review-highlight-weekday"]')],
  reviewHighlightPresetWindow: document.getElementById('review-highlight-preset-window'),
  reviewHighlightPresetAfterSchool: document.getElementById('review-highlight-preset-after-school'),
  reviewHighlightPresetEvening: document.getElementById('review-highlight-preset-evening'),
  reviewHighlightPresetWeekdays: document.getElementById('review-highlight-preset-weekdays'),
  reviewHighlightAll: document.getElementById('review-highlight-all'),
  reviewHighlightClear: document.getElementById('review-highlight-clear'),
  reviewHighlightMeta: document.getElementById('review-highlight-meta'),
  reviewComposer: document.getElementById('review-composer'),
  reviewComposerLabel: document.getElementById('review-composer-label'),
  reviewComposerNote: document.getElementById('review-composer-note'),
  reviewAddAnnotation: document.getElementById('review-add-annotation'),
  reviewCancelAnnotation: document.getElementById('review-cancel-annotation'),
  reviewAnnotationMeta: document.getElementById('review-annotation-meta'),
  reviewAnnotationList: document.getElementById('review-annotation-list'),
  reviewPreviousStudent: document.getElementById('review-previous-student'),
  reviewNextStudent: document.getElementById('review-next-student'),
  reviewExportPdf: document.getElementById('review-export-pdf'),
  reviewCloseButton: document.getElementById('review-close-button'),
  reviewBackButton: document.getElementById('review-back-button'),
}

const STUDENT_OVERRIDE_BOOLEAN_FIELDS = [
  ['allow_dictation', 'Allow dictation'],
  ['allow_offline_editing', 'Allow offline editing'],
  ['copy_paste_allowed', 'Allow copy/paste'],
  ['export_allowed', 'Allow export'],
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
  ['georgia', 'Georgia'],
  ['times', 'Times New Roman'],
  ['garamond', 'Garamond'],
  ['palatino', 'Palatino'],
  ['baskerville', 'Baskerville'],
  ['verdana', 'Verdana'],
  ['trebuchet', 'Trebuchet'],
  ['tahoma', 'Tahoma'],
  ['helvetica', 'Helvetica'],
  ['courier', 'Courier New'],
  ['comic-sans', 'Comic Sans'],
  ['lucida', 'Lucida Sans'],
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
    .replace(/\[u\]([\s\S]+?)\[\/u\]/g, '<u>$1</u>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/__([\s\S]+?)__/g, '<u>$1</u>')
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
  const textDecoration = typeof node.style?.textDecoration === 'string' ? node.style.textDecoration.toLowerCase() : ''
  if ((tag === 'span' || tag === 'font') && textDecoration.includes('underline')) {
    return `[u]${childText}[/u]`
  }
  if (tag === 'strong' || tag === 'b') {
    return `**${childText}**`
  }
  if (tag === 'em' || tag === 'i') {
    return `*${childText}*`
  }
  if (tag === 'u') {
    return `[u]${childText}[/u]`
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

function starterNodeContainsBlock(node) {
  if (!(node instanceof Element)) {
    return false
  }
  return Array.from(node.children).some((child) =>
    ['P', 'DIV', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3'].includes(child.tagName),
  )
}

function starterChildBlocksToMarkdown(node) {
  return Array.from(node.childNodes)
    .map((child) => starterBlockHtmlToMarkdown(child))
    .filter(Boolean)
    .join('\n\n')
    .trim()
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
  if (tag === 'div') {
    if (!node.textContent.trim() && !node.querySelector('br')) {
      return ''
    }
    if (starterNodeContainsBlock(node)) {
      return starterChildBlocksToMarkdown(node)
    }
    return Array.from(node.childNodes).map((child) => starterInlineHtmlToMarkdown(child)).join('').trim()
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
  if (tag === 'li') {
    if (starterNodeContainsBlock(node)) {
      return Array.from(node.childNodes)
        .map((child) => starterInlineHtmlToMarkdown(child))
        .join('')
        .replace(/\n+/g, ' ')
        .trim()
    }
    return Array.from(node.childNodes).map((child) => starterInlineHtmlToMarkdown(child)).join('').trim()
  }
  if (['strong', 'b', 'em', 'i', 'u', 'span', 'font', 'a', 'br'].includes(tag)) {
    return starterInlineHtmlToMarkdown(node).trim()
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
  updateStarterDocumentToolbarState()
}

function starterDocumentSelectionInsideEditor() {
  if (!elements.starterDocumentEditor) {
    return false
  }
  const selection = window.getSelection()
  if (!selection || !selection.rangeCount) {
    return false
  }
  const anchorNode = selection.anchorNode
  if (!anchorNode) {
    return false
  }
  const anchorElement = anchorNode.nodeType === Node.ELEMENT_NODE ? anchorNode : anchorNode.parentElement
  return anchorElement ? elements.starterDocumentEditor.contains(anchorElement) : false
}

function starterDocumentActiveBlockTag() {
  if (!starterDocumentSelectionInsideEditor()) {
    return ''
  }
  const selection = window.getSelection()
  const anchorNode = selection?.anchorNode
  const anchorElement = anchorNode?.nodeType === Node.ELEMENT_NODE ? anchorNode : anchorNode?.parentElement
  const blockElement = anchorElement?.closest?.('h1, h2, blockquote, li, p, div')
  if (!blockElement) {
    return ''
  }
  const tag = blockElement.tagName.toLowerCase()
  if (tag === 'li') {
    return blockElement.closest('ol') ? 'ol' : 'ul'
  }
  return tag
}

function starterDocumentCommandIsActive(command) {
  if (!starterDocumentSelectionInsideEditor()) {
    return false
  }
  try {
    switch (command) {
      case 'bold':
        return document.queryCommandState('bold')
      case 'italic':
        return document.queryCommandState('italic')
      case 'underline':
        return document.queryCommandState('underline')
      case 'bullet':
        return document.queryCommandState('insertUnorderedList') || starterDocumentActiveBlockTag() === 'ul'
      case 'number':
        return document.queryCommandState('insertOrderedList') || starterDocumentActiveBlockTag() === 'ol'
      case 'quote':
        return starterDocumentActiveBlockTag() === 'blockquote'
      case 'h1':
        return starterDocumentActiveBlockTag() === 'h1'
      case 'h2':
        return starterDocumentActiveBlockTag() === 'h2'
      default:
        return false
    }
  } catch {
    return false
  }
}

function updateStarterDocumentToolbarState() {
  elements.starterDocumentToolbar?.querySelectorAll('[data-starter-command]').forEach((button) => {
    const isActive = starterDocumentCommandIsActive(button.dataset.starterCommand)
    button.setAttribute('aria-pressed', isActive ? 'true' : 'false')
  })
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
  updateStarterDocumentToolbarState()
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

function normalizeReferencePdfDataUrl(dataUrl) {
  const value = String(dataUrl || '').trim()
  const commaIndex = value.indexOf(',')
  if (commaIndex < 0 || !/^data:[^,]*;base64,/i.test(value)) {
    return value
  }
  const payload = value.slice(commaIndex + 1)
  return `data:application/pdf;base64,${payload}`
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
        data_url: normalizeReferencePdfDataUrl(reader.result),
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
  return buildReviewReplayCacheEntryFromPrevious(replay, null)
}

function reviewReplayAttributionSignature(replay = {}) {
  const history = Array.isArray(replay?.document_history) ? replay.document_history : []
  const lastHistory = history[history.length - 1] || {}
  return [
    String(replay?.current_text || ''),
    String(replay?.last_seq ?? ''),
    String(replay?.last_activity_at || ''),
    String(replay?.updated_at || ''),
    String(history.length),
    String(lastHistory.t ?? ''),
    String(lastHistory.pos ?? ''),
    String(lastHistory.ins ?? '').length,
    String(lastHistory.del ?? '').length,
  ].join('\u001f')
}

function buildReviewReplayCacheEntryFromPrevious(replay, previousEntry = null) {
  const attributionSignature = reviewReplayAttributionSignature(replay)
  if (previousEntry?.attributionSignature === attributionSignature) {
    return {
      ...previousEntry,
      replay,
    }
  }
  const documentHistory = documentHistoryForReviewAttribution(replay)
  const hasReliableOrigin = replayOriginWallMs(replay) != null
  const hasExplicitCurrentText = Object.hasOwn(replay || {}, 'current_text')
  const attributedDocument = buildAttributedDocument({
    ...replay,
    ...(hasReliableOrigin ? {} : { created_at: '' }),
    doc_history: hasExplicitCurrentText && String(replay?.current_text || '') === '' ? [] : documentHistory,
    doc_text: hasExplicitCurrentText ? String(replay?.current_text || '') : '',
  }) || {
    text: String(replay?.current_text || ''),
    runs: [],
    firstInsertedAtMs: null,
    lastInsertedAtMs: null,
  }
  return {
    replay,
    attributedDocument,
    attributionSignature,
  }
}

function documentHistoryForReviewAttribution(replay = {}) {
  const annotatedHistory = annotateReplayHistoryWithEventTimes(replay)
  const finalText = String(replay?.current_text || '')
  if (!finalText || annotatedHistory.length < 2) {
    return annotatedHistory
  }

  return annotatedHistory.flatMap((entry, index) => {
    const previousText = index > 0
      ? latestTextFromHistory({ doc_history: annotatedHistory.slice(0, index), doc_text: '' })
      : ''
    const compactEntry = compactReviewReplacementEntry(entry, previousText)
    const entryText = String(entry?.ins ?? '')
    if (
      index === 0 ||
      Number(compactEntry?.pos) !== 0 ||
      String(compactEntry?.del ?? '') !== '' ||
      !entryText
    ) {
      return [compactEntry]
    }
    if (previousText === entryText) {
      return []
    }
    if (entryText.length >= 8 && previousText) {
      return [{
        ...compactEntry,
        op: 'snapshot',
        text: entryText,
        ins: '',
        del: '',
      }]
    }
    return entryText === finalText ? [] : [entry]
  })
}

function compactReviewReplacementEntry(entry = {}, previousText = '') {
  if (
    typeof entry?.del !== 'string' ||
    typeof entry?.ins !== 'string' ||
    !entry.del ||
    !entry.ins
  ) {
    return entry
  }
  const pos = Number(entry.pos)
  if (!Number.isInteger(pos) || pos < 0) {
    return entry
  }
  const previousChars = Array.from(String(previousText || ''))
  const delChars = Array.from(entry.del)
  const insChars = Array.from(entry.ins)
  if (previousChars.slice(pos, pos + delChars.length).join('') !== entry.del) {
    return entry
  }

  let prefix = 0
  while (prefix < delChars.length && prefix < insChars.length && delChars[prefix] === insChars[prefix]) {
    prefix += 1
  }
  let delEnd = delChars.length
  let insEnd = insChars.length
  while (delEnd > prefix && insEnd > prefix && delChars[delEnd - 1] === insChars[insEnd - 1]) {
    delEnd -= 1
    insEnd -= 1
  }
  if (!prefix && delEnd === delChars.length && insEnd === insChars.length) {
    return entry
  }

  return {
    ...entry,
    pos: pos + prefix,
    del: delChars.slice(prefix, delEnd).join(''),
    ins: insChars.slice(prefix, insEnd).join(''),
  }
}

function mergeReviewReplayWithLiveSession(replay = {}, session = {}) {
  const sessionHistory = Array.isArray(session?.document_history) ? session.document_history : []
  if (!sessionHistory.length) {
    return replay
  }
  const replayHistory = Array.isArray(replay?.document_history) ? replay.document_history : []
  const sessionHasCurrentText = Object.hasOwn(session || {}, 'current_text')
  const sessionText = String(session?.current_text || '')
  const replayText = String(replay?.current_text || '')
  const reviewTimestampMs = (value) => {
    const parsed = Date.parse(String(value || ''))
    return Number.isNaN(parsed) ? 0 : parsed
  }
  const replayFreshness = Math.max(
    reviewTimestampMs(replay?.last_activity_at),
    reviewTimestampMs(replay?.updated_at),
  )
  const sessionFreshness = Math.max(
    reviewTimestampMs(session?.last_activity_at),
    reviewTimestampMs(session?.updated_at),
  )
  const sessionIsAtLeastAsFresh = !replayFreshness || sessionFreshness >= replayFreshness
  const sessionHasNewerHistory = sessionHistory.length > replayHistory.length && sessionIsAtLeastAsFresh
  const sessionHasMatchingNewerText =
    sessionIsAtLeastAsFresh &&
    sessionHasCurrentText &&
    sessionText !== replayText &&
    sessionHistory.length >= replayHistory.length
  const replayCanUseSessionBaseHistory =
    !sessionIsAtLeastAsFresh &&
    sessionText &&
    replayText &&
    sessionText !== replayText &&
    sessionHistory.length &&
    replayHistory.length &&
    Number(replayHistory[0]?.pos) === 0 &&
    String(replayHistory[0]?.del ?? '') === sessionText
  if (replayCanUseSessionBaseHistory) {
    return {
      ...replay,
      document_history: [...sessionHistory, ...replayHistory],
    }
  }
  if (!sessionHasNewerHistory && !sessionHasMatchingNewerText) {
    return replay
  }
  const historyHasReliableTiming = (history = []) => {
    const finiteTimes = history
      .map((entry) => Number(entry?.absolute_wall_ms) || Number(entry?.t))
      .filter((value) => Number.isFinite(value) && value > 0)
    return new Set(finiteTimes).size > 1
  }
  const compactLiveAttributionEntry = (
    fromText,
    toText,
    latestT,
    {
      maxInsertChars = REVIEW_LIVE_ATTRIBUTION_MAX_SYNTHETIC_INSERT_CHARS,
      maxDeleteChars = REVIEW_LIVE_ATTRIBUTION_MAX_SYNTHETIC_DELETE_CHARS,
    } = {},
  ) => {
    if (!toText || fromText === toText) {
      return null
    }
    const syntheticEntry = compactReviewReplacementEntry(
      {
        t: latestT + 1,
        absolute_wall_ms: sessionFreshness || undefined,
        pos: 0,
        del: fromText,
        ins: toText,
      },
      fromText,
    )
    if (
      Array.from(String(syntheticEntry.ins || '')).length <= maxInsertChars &&
      Array.from(String(syntheticEntry.del || '')).length <= maxDeleteChars
    ) {
      return syntheticEntry
    }
    return null
  }
  let documentHistory = sessionHistory
  if (sessionText) {
    const historyText = latestTextFromHistory({ doc_history: sessionHistory, doc_text: '' })
    if (historyText !== sessionText) {
      const latestT = Math.max(0, ...sessionHistory.map((entry) => Number(entry?.t || 0) || 0))
      const syntheticEntry = compactLiveAttributionEntry(historyText, sessionText, latestT)
      if (syntheticEntry) {
        documentHistory = [...sessionHistory, syntheticEntry]
      } else if (replayText && replayText !== sessionText) {
        const replayLatestT = Math.max(0, ...replayHistory.map((entry) => Number(entry?.t || 0) || 0))
        const replayTimingIsReliable = historyHasReliableTiming(replayHistory)
        const replaySyntheticEntry = compactLiveAttributionEntry(replayText, sessionText, replayLatestT, {
          maxInsertChars: replayTimingIsReliable
            ? Number.POSITIVE_INFINITY
            : REVIEW_LIVE_ATTRIBUTION_MAX_SYNTHETIC_INSERT_CHARS,
          maxDeleteChars: replayTimingIsReliable
            ? 200
            : REVIEW_LIVE_ATTRIBUTION_MAX_SYNTHETIC_DELETE_CHARS,
        })
        if (replaySyntheticEntry) {
          documentHistory = [...replayHistory, replaySyntheticEntry]
        }
      }
    }
  }
  return {
    ...replay,
    current_text: sessionHasCurrentText ? sessionText : replayText,
    document_history: documentHistory,
    focus_events: Array.isArray(session?.focus_events) ? session.focus_events : replay?.focus_events,
    url_history: Array.isArray(session?.url_history) ? session.url_history : replay?.url_history,
    last_activity_at: session?.last_activity_at || replay?.last_activity_at,
    updated_at: session?.updated_at || replay?.updated_at,
  }
}

function syncReviewReplayDataWithLiveSession(session = currentReviewSession()) {
  if (!reviewState || !session?.id || reviewState.sessionId !== session.id) {
    return null
  }
  let cached = reviewReplayCache.get(session.id)
  if (!cached) {
    return null
  }
  const mergedReplay = mergeReviewReplayWithLiveSession(cached.replay, session)
  if (mergedReplay !== cached.replay) {
    cached = buildReviewReplayCacheEntryFromPrevious(mergedReplay, cached)
    reviewReplayCache.set(session.id, cached)
  }
  reviewState.replayData = cached
  if (reviewState.replayLoadState !== 'missing' && reviewState.replayLoadState !== 'error') {
    reviewState.replayLoadState = 'ready'
  }
  return cached
}

function annotateReplayHistoryWithEventTimes(replay = {}) {
  const history = (Array.isArray(replay.document_history) ? replay.document_history : []).map((entry) => ({ ...entry }))
  const hasReplayOrigin = replayOriginWallMs(replay) != null
  const events = (Array.isArray(replay.events) ? replay.events : [])
    .slice()
    .sort((left, right) => Number(left?.seq || 0) - Number(right?.seq || 0))
  let cursor = 0
  for (const event of events) {
    const tail = Array.isArray(event?.document_history_tail) ? event.document_history_tail : []
    const anchorWallMs = Date.parse(
      hasReplayOrigin
        ? event?.last_activity_at || ''
        : event?.last_activity_at || event?.updated_at || event?.created_at || '',
    )
    const tailTimes = tail
      .map((entry) => Number(entry?.t))
      .filter((value) => Number.isFinite(value))
    if (!Number.isFinite(anchorWallMs) || !tail.length) {
      continue
    }
    const maxTailTime = tailTimes.length ? Math.max(...tailTimes) : 0
    const eventOriginWallMs = anchorWallMs - maxTailTime
    for (const tailEntry of tail) {
      const matchIndex = history.findIndex((entry, index) => index >= cursor && historyEntriesMatch(entry, tailEntry))
      if (matchIndex < 0) {
        continue
      }
      const existingWallMs = Number(history[matchIndex]?.absolute_wall_ms ?? tailEntry?.absolute_wall_ms)
      if (Number.isFinite(existingWallMs) && existingWallMs > 0) {
        history[matchIndex] = {
          ...history[matchIndex],
          absolute_wall_ms: existingWallMs,
        }
        cursor = matchIndex + 1
        continue
      }
      const entryTime = Number(tailEntry?.t)
      history[matchIndex] = {
        ...history[matchIndex],
        absolute_wall_ms: eventOriginWallMs + (Number.isFinite(entryTime) ? entryTime : maxTailTime),
      }
      cursor = matchIndex + 1
    }
  }
  const anchorWallMs = Date.parse(hasReplayOrigin ? replay?.last_activity_at || '' : replay?.last_activity_at || replay?.updated_at || '')
  const historyTimes = history
    .map((entry) => Number(entry?.t))
    .filter((value) => Number.isFinite(value))
  if (Number.isFinite(anchorWallMs) && historyTimes.length) {
    const replayOrigin = anchorWallMs - Math.max(...historyTimes)
    return history.map((entry) => {
      if (Number.isFinite(Number(entry?.absolute_wall_ms))) {
        return entry
      }
      const entryTime = Number(entry?.t)
      return {
        ...entry,
        absolute_wall_ms: replayOrigin + (Number.isFinite(entryTime) ? entryTime : 0),
      }
    })
  }
  return history
}

function replayOriginWallMs(replay = {}) {
  const explicitOrigin = Number(replay?.replay_origin_wall_ms)
  if (Number.isFinite(explicitOrigin) && explicitOrigin > 0) {
    return explicitOrigin
  }
  const startWallNs = Number(replay?.start_wall_ns)
  if (Number.isFinite(startWallNs) && startWallNs > 0) {
    return Math.floor(startWallNs / 1e6)
  }
  return null
}

function historyEntriesMatch(left = {}, right = {}) {
  return (
    String(left.ins ?? '') === String(right.ins ?? '') &&
    String(left.del ?? '') === String(right.del ?? '') &&
    Number(left.pos ?? 0) === Number(right.pos ?? 0) &&
    Number(left.t ?? 0) === Number(right.t ?? 0)
  )
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

function realtimeAgo(value) {
  if (!value) {
    return 'never'
  }
  const seconds = Math.max(0, Math.round((Date.now() - value) / 1000))
  return `${seconds}s ago`
}

function renderRealtimeDebug() {
  if (!elements.reviewRealtimeDebug) {
    renderAssignmentMonitoringStatus()
    return
  }
  elements.reviewRealtimeDebug.textContent = [
    `SSE teacher=${realtimeDebugState.teacher}`,
    `assignment=${realtimeDebugState.assignment}`,
    `replay=${realtimeDebugState.replay}`,
    `event=${realtimeDebugState.lastEvent || 'none'} ${realtimeAgo(realtimeDebugState.lastEventAt)}`,
    `fallback=${realtimeDebugState.lastFallback || 'none'} ${realtimeAgo(realtimeDebugState.lastFallbackAt)}`,
    realtimeDebugState.lastError ? `error=${realtimeDebugState.lastError} ${realtimeAgo(realtimeDebugState.lastErrorAt)}` : 'error=none',
  ].join(' | ')
  renderAssignmentMonitoringStatus()
}

function assignmentMonitoringPathStatus() {
  if (!selectedAssignmentId || currentView !== 'assignment') {
    return {
      label: 'Monitoring: waiting for assignment',
      tone: 'idle',
    }
  }
  const lastAssignmentRealtimeAt =
    realtimeDebugState.lastEvent?.startsWith('assignment:')
      ? realtimeDebugState.lastEventAt
      : 0
  const lastAssignmentFallbackAt =
    realtimeDebugState.lastFallback === 'assignment-view'
      ? realtimeDebugState.lastFallbackAt
      : 0
  const lastAssignmentErrorAt =
    realtimeDebugState.lastError?.startsWith('assignment')
      ? realtimeDebugState.lastErrorAt
      : 0

  if (lastAssignmentRealtimeAt > 0 && lastAssignmentRealtimeAt >= lastAssignmentErrorAt) {
    return {
      label: `Monitoring: realtime updates active ${realtimeAgo(lastAssignmentRealtimeAt)}`,
      tone: 'realtime',
    }
  }
  if (
    (realtimeDebugState.assignment === 'ready' ||
      realtimeDebugState.assignment === 'connecting' ||
      realtimeDebugState.assignment === 'event') &&
    lastAssignmentErrorAt <= lastAssignmentFallbackAt
  ) {
    return {
      label: `Monitoring: realtime ${realtimeDebugState.assignment}`,
      tone: 'realtime',
    }
  }
  if (lastAssignmentFallbackAt > lastAssignmentRealtimeAt) {
    return {
      label: `Monitoring: fallback refresh used ${realtimeAgo(lastAssignmentFallbackAt)}`,
      tone: 'fallback',
    }
  }
  if (realtimeDebugState.assignment === 'ready' || realtimeDebugState.assignment === 'connecting') {
    return {
      label: `Monitoring: realtime ${realtimeDebugState.assignment}`,
      tone: 'realtime',
    }
  }
  if (realtimeDebugState.assignment === 'error') {
    return {
      label: 'Monitoring: realtime error, waiting for fallback',
      tone: 'fallback',
    }
  }
  return {
    label: 'Monitoring: waiting for updates',
    tone: 'idle',
  }
}

function renderAssignmentMonitoringStatus() {
  if (!elements.assignmentMonitoringStatus) {
    return
  }
  const status = assignmentMonitoringPathStatus()
  elements.assignmentMonitoringStatus.textContent = status.label
  elements.assignmentMonitoringStatus.dataset.tone = status.tone
}

function markRealtimeStatus(label, status, detail = '') {
  if (!label) {
    return
  }
  realtimeDebugState[label] = status
  if (status === 'error') {
    realtimeDebugState.lastErrorAt = Date.now()
    realtimeDebugState.lastError = `${label}${detail ? `:${detail}` : ''}`
  }
  renderRealtimeDebug()
}

function markRealtimeEvent(label, eventName) {
  realtimeDebugState.lastEventAt = Date.now()
  realtimeDebugState.lastEvent = `${label}:${eventName}`
  markRealtimeStatus(label, 'event')
}

function markFallbackRefresh(name) {
  realtimeDebugState.lastFallbackAt = Date.now()
  realtimeDebugState.lastFallback = name
  renderRealtimeDebug()
}

function openRealtimeConnection(channels, handlers = {}, label = 'teacher') {
  const selectedChannels = (channels || []).filter(Boolean)
  if (!selectedChannels.length) {
    return null
  }
  const url = new URL('/api/edu/realtime', window.location.origin)
  for (const channel of selectedChannels) {
    url.searchParams.append('channel', channel)
  }
  const source = new EventSource(url)
  markRealtimeStatus(label, 'connecting')
  source.addEventListener('ready', () => {
    markRealtimeStatus(label, 'ready')
    handlers.ready?.()
  })
  source.addEventListener('dashboard', (event) => {
    markRealtimeEvent(label, 'dashboard')
    handlers.dashboard?.(JSON.parse(event.data))
  })
  source.addEventListener('assignment', (event) => {
    markRealtimeEvent(label, 'assignment')
    handlers.assignment?.(JSON.parse(event.data))
  })
  source.addEventListener('access-request', (event) => {
    markRealtimeEvent(label, 'access-request')
    handlers.accessRequest?.(JSON.parse(event.data))
  })
  source.addEventListener('replay', (event) => {
    markRealtimeEvent(label, 'replay')
    handlers.replay?.(JSON.parse(event.data))
  })
  source.onerror = () => {
    markRealtimeStatus(label, 'error')
    handlers.error?.()
  }
  return source
}

function resetRealtimeConnection(label) {
  if (label === 'teacher') {
    closeRealtimeConnection(teacherRealtime)
    teacherRealtime = null
    teacherRealtimeKey = ''
  } else if (label === 'assignment') {
    closeRealtimeConnection(assignmentRealtime)
    assignmentRealtime = null
    assignmentRealtimeKey = ''
  } else if (label === 'replay') {
    closeRealtimeConnection(replayRealtime)
    replayRealtime = null
    replayRealtimeKey = ''
  }
}

function retryRealtimeConnection(label, fallback) {
  fallback?.()
  window.setTimeout(() => {
    resetRealtimeConnection(label)
    syncRealtimeSubscriptions()
  }, 250)
}

function realtimeStatusIsHealthy(label) {
  return realtimeDebugState[label] === 'ready' || realtimeDebugState[label] === 'event'
}

function realtimeHasRecentEvent(label, eventName) {
  if (!realtimeStatusIsHealthy(label)) {
    return false
  }
  if (realtimeDebugState.lastEvent !== `${label}:${eventName}`) {
    return false
  }
  return Date.now() - Number(realtimeDebugState.lastEventAt || 0) <= REALTIME_EVENT_STALE_FALLBACK_MS
}

function shouldUseFallbackRefresh() {
  if (!dashboardState) {
    return true
  }
  if (currentView === 'assignment' && selectedAssignmentId) {
    if (reviewWorkspaceOpen && selectedReviewSessionId) {
      return !realtimeHasRecentEvent('assignment', 'assignment') || !realtimeStatusIsHealthy('replay')
    }
    return !realtimeHasRecentEvent('assignment', 'assignment')
  }
  return !realtimeHasRecentEvent('teacher', 'dashboard')
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

function reviewNavigationSessions(
  selectedClassroom = getSelectedClassroom(),
  selectedAssignment = getSelectedAssignment(),
) {
  if (!selectedClassroom || !selectedAssignment) {
    return []
  }
  return sortSessionsForDisplay(
    sessionsForAssignment(getLiveSessions(), selectedClassroom.name, selectedAssignment.id),
  )
}

function reviewNavigationState(session = currentReviewSession()) {
  const sessions = reviewNavigationSessions()
  const currentIndex = session ? sessions.findIndex((item) => item.id === session.id) : -1
  return {
    sessions,
    currentIndex,
    previousSession: currentIndex > 0 ? sessions[currentIndex - 1] : null,
    nextSession: currentIndex >= 0 && currentIndex < sessions.length - 1 ? sessions[currentIndex + 1] : null,
  }
}

function renderReviewNavigationControls(session = currentReviewSession()) {
  const { currentIndex, sessions, previousSession, nextSession } = reviewNavigationState(session)
  const positionLabel = currentIndex >= 0 && sessions.length > 0
    ? `${currentIndex + 1} of ${sessions.length}`
    : 'No student selected'
  if (elements.reviewPreviousStudent) {
    elements.reviewPreviousStudent.disabled = !previousSession
    elements.reviewPreviousStudent.title = previousSession
      ? `Previous student: ${previousSession.student_name || 'Student'}`
      : positionLabel
  }
  if (elements.reviewNextStudent) {
    elements.reviewNextStudent.disabled = !nextSession
    elements.reviewNextStudent.title = nextSession
      ? `Next student: ${nextSession.student_name || 'Student'}`
      : positionLabel
  }
  if (elements.reviewExportPdf) {
    elements.reviewExportPdf.disabled = !session || !reviewState
  }
}

async function selectAdjacentReviewSession(direction) {
  const { previousSession, nextSession } = reviewNavigationState()
  const target = direction < 0 ? previousSession : nextSession
  if (!target) {
    renderReviewNavigationControls()
    return
  }
  await selectReviewSession(target.id)
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
    current_text: Object.hasOwn(replayPayload, 'current_text')
      ? String(replayPayload.current_text || '')
      : String(existing?.current_text || selectedReviewSessionSnapshot?.current_text || ''),
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
    live_sessions: mergeLiveSessions(getLiveSessions(), [nextSession]),
  }

  if (selectedReviewSessionSnapshot?.id === sessionId) {
    selectedReviewSessionSnapshot = mergeLiveSession(selectedReviewSessionSnapshot, nextSession)
  }
}

function syncSelectedReviewSessionSnapshot(session = currentReviewSession()) {
  if (!selectedReviewSessionId || !reviewWorkspaceOpen || !session || session.id !== selectedReviewSessionId) {
    return
  }
  selectedReviewSessionSnapshot = { ...session }
}

function sessionFreshnessValue(session) {
  return sessionPresenceTimestamp(session) || 0
}

function liveSessionText(session) {
  return Object.hasOwn(session || {}, 'current_text') ? String(session.current_text || '') : null
}

function mergeLiveSession(existing, incoming) {
  if (!existing) {
    return incoming
  }
  if (!incoming) {
    return existing
  }

  const existingFreshness = sessionFreshnessValue(existing)
  const incomingFreshness = sessionFreshnessValue(incoming)
  if (incomingFreshness < existingFreshness) {
    if (
      Array.isArray(incoming.document_history) &&
      incoming.document_history.length &&
      !Array.isArray(existing.document_history)
    ) {
      return {
        ...existing,
        document_history: incoming.document_history,
      }
    }
    return existing
  }

  const merged = {
    ...existing,
    ...incoming,
  }
  const existingText = liveSessionText(existing)
  const incomingText = liveSessionText(incoming)
  const freshnessDeltaMs = Math.abs(incomingFreshness - existingFreshness)
  if (incomingText === null && existingText !== null) {
    merged.current_text = existingText
  } else if (
    existingText !== null &&
    incomingText !== null &&
    incomingText.length > 0 &&
    incomingText.length < existingText.length &&
    existingText.startsWith(incomingText) &&
    freshnessDeltaMs <= 3000
  ) {
    merged.current_text = existingText
  }
  return merged
}

function mergeLiveSessions(previous, incoming) {
  const map = new Map((previous || []).map((item) => [item.id, item]))
  for (const item of incoming || []) {
    map.set(item.id, mergeLiveSession(map.get(item.id), item))
  }
  return [...map.values()]
}

function preferFresherSession(existing, incoming) {
  if (!existing) {
    return incoming
  }
  if (!incoming) {
    return existing
  }
  return mergeLiveSession(existing, incoming)
}

function preserveSelectedReviewSessionInSummaries(summaries = []) {
  const selectedSession = currentReviewSession()
  if (!reviewWorkspaceOpen || !selectedReviewSessionId || !selectedSession || selectedSession.assignment_id !== selectedAssignmentId) {
    return summaries
  }
  const incomingSelected = summaries.find((session) => session.id === selectedReviewSessionId) || null
  return mergeLiveSessions(summaries, [preferFresherSession(selectedSession, incomingSelected)])
}

function mergeAssignmentLiveSummaries(summaries = []) {
  const existingById = new Map(getLiveSessions().map((session) => [session.id, session]))
  return (summaries || []).map((summary) => mergeLiveSession(existingById.get(summary.id), summary))
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
    live_sessions: mergeLiveSessions(payload.live_sessions, [preferFresherSession(selectedSession, incomingSelected)]),
  }
}

function displaySessionText(session, replayData = null) {
  const hasDirect = Object.hasOwn(session || {}, 'current_text')
  const direct = String(session?.current_text || '')
  const hasSessionHistory = Array.isArray(session?.document_history) && session.document_history.length > 0
  const replayText = String(replayData?.attributedDocument?.text || '')
  const historyText = latestTextFromHistory({
    doc_history: Array.isArray(session?.document_history) ? session.document_history : [],
    doc_text: '',
  })
  if (direct || (hasDirect && hasSessionHistory)) {
    return textWithPreservedParagraphSpacing(direct, replayText || historyText)
  }
  return replayText || historyText
}

function textWithPreservedParagraphSpacing(direct, spacedCandidate) {
  const raw = String(direct || '')
  const candidate = String(spacedCandidate || '')
  if (!raw || !candidate || raw.includes('\n\n') || !candidate.includes('\n\n')) {
    return raw
  }
  return collapseParagraphSpacing(candidate) === raw ? candidate : raw
}

function collapseParagraphSpacing(text) {
  return String(text || '').replace(/\n{2,}/g, '\n')
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
    resolved_by_student: Boolean(annotation.resolved_by_student),
    resolved_at: annotation.resolved_at || null,
    resolved_by: annotation.resolved_by || '',
  }
}

function visibleReviewAnnotations(annotations = []) {
  return (annotations || []).filter((annotation) => !annotation?.resolved_by_student)
}

function syncReviewResolvedAnnotationsFromSession(session = currentReviewSession()) {
  if (!reviewState || !session?.grading?.inline_annotations?.length) {
    return
  }
  const resolvedById = new Map(
    session.grading.inline_annotations
      .filter((annotation) => annotation?.resolved_by_student)
      .map((annotation) => [String(annotation.id || ''), annotation]),
  )
  if (!resolvedById.size) {
    return
  }
  reviewState.inlineAnnotations = reviewState.inlineAnnotations.map((annotation) => {
    const resolved = resolvedById.get(String(annotation.id || ''))
    return resolved ? { ...annotation, ...resolved, resolved_by_student: true } : annotation
  })
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
    feedback_status: grading.feedback_status === 'draft' ? 'draft' : 'published',
    published_at: grading.published_at || null,
    actor_name: grading.actor_name || '',
    actor_email: grading.actor_email || '',
  }
}

function rubricKeyAliases(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized) return []
  return [
    normalized,
    normalized.replace(/[\s:_-]+/g, ''),
    normalized.replace(/_/g, ':'),
    normalized.replace(/:/g, '_'),
  ].filter((alias, index, aliases) => alias && aliases.indexOf(alias) === index)
}

function normalizedRubricScoresForAssignment(scores = {}, assignment = null) {
  const rubric = Array.isArray(assignment?.rubric) ? assignment.rubric : []
  if (!rubric.length || !scores || typeof scores !== 'object') {
    return scores && typeof scores === 'object' ? { ...scores } : {}
  }
  const incoming = new Map()
  for (const [key, value] of Object.entries(scores)) {
    for (const alias of rubricKeyAliases(key)) {
      if (!incoming.has(alias)) incoming.set(alias, value)
    }
  }
  const normalized = {}
  for (const criterion of rubric) {
    const score = rubricKeyAliases(criterion.id || criterion.title)
      .map((alias) => incoming.get(alias))
      .find((value) => value !== undefined)
    if (score !== undefined) {
      normalized[criterion.id] = Number(score || 0)
    }
  }
  return normalized
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
    annotationCount: visibleReviewAnnotations(grading.inline_annotations).length,
  }
}

function createReviewStateFromSession(session) {
  const grading = normalizedSessionGrading(session)
  const assignment = getSelectedAssignment()
  return {
    sessionId: session.id,
    gradeLabel: grading.grade_label,
    gradeScore: grading.grade_score,
    rubricScores: normalizedRubricScoresForAssignment(grading.rubric_scores, assignment),
    teacherComment: grading.teacher_comment,
    returnedForRevision: grading.returned_for_revision,
    inlineAnnotations: grading.inline_annotations,
    updatedAt: grading.updated_at,
    feedbackStatus: grading.feedback_status,
    publishedAt: grading.published_at,
    updatedBy: grading.actor_name || grading.actor_email || '',
    publishConfirmation: '',
    publishingFeedback: false,
    feedbackControlsClearedAfterPublish: false,
    saveState: grading.updated_at ? 'saved' : 'idle',
    dirty: false,
    deletedAnnotationIds: [],
    selection: null,
    composerMode: '',
    composerNote: '',
    replayLoadState: 'idle',
    replayError: '',
    replayData: null,
    highlightMode: 'none',
    highlightDate: '',
    highlightDates: '',
    highlightStartTime: '',
    highlightEndTime: '',
    highlightWeekdays: [],
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
  return dashboardState?.summary?.tenant_id || teacherSession?.tenant_id || 'default'
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

function captureTeacherHistoryState() {
  return {
    app: TEACHER_HISTORY_APP_KEY,
    currentView,
    selectedClassroomId: selectedClassroomId || null,
    selectedAssignmentId: selectedAssignmentId || null,
    selectedReviewSessionId: reviewWorkspaceOpen && selectedReviewSessionId ? selectedReviewSessionId : null,
    reviewWorkspaceOpen: Boolean(reviewWorkspaceOpen && selectedReviewSessionId),
  }
}

function teacherHistoryStateKey(state = captureTeacherHistoryState()) {
  return JSON.stringify({
    app: state?.app || TEACHER_HISTORY_APP_KEY,
    currentView: state?.currentView || 'classes',
    selectedClassroomId: state?.selectedClassroomId || null,
    selectedAssignmentId: state?.selectedAssignmentId || null,
    selectedReviewSessionId: state?.selectedReviewSessionId || null,
    reviewWorkspaceOpen: Boolean(state?.reviewWorkspaceOpen && state?.selectedReviewSessionId),
  })
}

function replaceTeacherHistoryState() {
  if (!window.history?.replaceState) {
    return
  }
  const state = captureTeacherHistoryState()
  lastTeacherHistoryKey = teacherHistoryStateKey(state)
  window.history.replaceState(state, '')
}

function recordTeacherHistoryState() {
  if (teacherHistoryRestoring || !window.history?.pushState) {
    return
  }
  if (!teacherHistoryInitialized) {
    initializeTeacherHistory()
  }
  const state = captureTeacherHistoryState()
  const key = teacherHistoryStateKey(state)
  if (key === lastTeacherHistoryKey) {
    return
  }
  lastTeacherHistoryKey = key
  window.history.pushState(state, '')
}

function applyTeacherHistoryState(state) {
  if (!state || state.app !== TEACHER_HISTORY_APP_KEY) {
    return
  }
  teacherHistoryRestoring = true
  try {
    const previousAssignmentId = selectedAssignmentId
    currentView = state.currentView || 'classes'
    selectedClassroomId = state.selectedClassroomId || null
    selectedAssignmentId = state.selectedAssignmentId || null
    if (state.reviewWorkspaceOpen && state.selectedReviewSessionId) {
      reviewWorkspaceOpen = true
      selectedReviewSessionId = state.selectedReviewSessionId
      selectedReviewSessionSnapshot =
        getLiveSessions().find((session) => session.id === selectedReviewSessionId) || selectedReviewSessionSnapshot || null
    } else {
      clearSelectedReviewSession()
    }
    if (previousAssignmentId !== selectedAssignmentId) {
      resetAssignmentViewRefreshState()
    }
    renderView()
    scheduleDashboardRefresh()
    lastTeacherHistoryKey = teacherHistoryStateKey(captureTeacherHistoryState())
  } finally {
    teacherHistoryRestoring = false
  }
}

function initializeTeacherHistory() {
  if (teacherHistoryInitialized) {
    return
  }
  teacherHistoryInitialized = true
  replaceTeacherHistoryState()
  window.addEventListener('popstate', (event) => {
    applyTeacherHistoryState(event.state)
  })
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
  const parsed = parseReviewNativeTimeInput(value) ?? parseReviewTimeInput(value)
  if (parsed == null) {
    return { hour: fallbackHour, minute: fallbackMinute }
  }
  return {
    hour: Math.floor(parsed / 60),
    minute: parsed % 60,
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
  const rawValue = String(input?.value || '').trim()
  if (!rawValue) {
    return { hour: fallbackHour, minute: fallbackMinute }
  }
  const parsed = parseReviewNativeTimeInput(rawValue) ?? parseReviewTimeInput(rawValue)
  if (parsed == null) {
    throw new Error('Enter a valid time.')
  }
  return {
    hour: Math.floor(parsed / 60),
    minute: parsed % 60,
  }
}

function localDateInputValue(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(value.getTime())) {
    return ''
  }
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
}

function nativeTimeInputValue(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(value.getTime())) {
    return ''
  }
  return `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`
}

function defaultAccessExtensionTarget(now = new Date()) {
  const target = new Date(now.getTime() + 60 * 60 * 1000)
  const minute = target.getMinutes()
  const hasPartialMinute = target.getSeconds() > 0 || target.getMilliseconds() > 0
  target.setSeconds(0, 0)
  const nextQuarterMinute = Math.ceil((minute + (hasPartialMinute ? 1 : 0)) / 15) * 15
  target.setMinutes(nextQuarterMinute)
  return target
}

function accessExtensionTargetLabel(target) {
  const value = target instanceof Date ? target : new Date(target)
  if (Number.isNaN(value.getTime())) {
    return ''
  }
  return value.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

function syncAccessExtensionDefaults({ force = false } = {}) {
  const dateInput = elements.quickExtendDate
  const timeInput = elements.quickExtendTime
  if (!dateInput || !timeInput) {
    return
  }
  const now = new Date()
  let current = null
  try {
    current = selectedExtensionTarget(dateInput, timeInput, { allowPast: true, fallbackTarget: null })
  } catch {
    current = null
  }
  if (!force && current && current.getTime() > now.getTime()) {
    return
  }
  const target = defaultAccessExtensionTarget(now)
  dateInput.value = localDateInputValue(target)
  timeInput.value = nativeTimeInputValue(target)
}

function selectedExtensionTarget(dateInput, timeInput, { allowPast = false, fallbackTarget = defaultAccessExtensionTarget() } = {}) {
  const fallback = fallbackTarget instanceof Date ? fallbackTarget : null
  const dateValue = String(dateInput?.value || '').trim() || (fallback ? localDateInputValue(fallback) : '')
  const timeParts = selectedTimeParts(timeInput, fallback?.getHours() ?? 15, fallback?.getMinutes() ?? 0)
  const dateMatch = dateValue.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!dateMatch) {
    throw new Error('Choose a valid extension date.')
  }
  const target = new Date(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    timeParts.hour,
    timeParts.minute,
    0,
    0,
  )
  if (Number.isNaN(target.getTime())) {
    throw new Error('Choose a valid extension date and time.')
  }
  if (!allowPast && target.getTime() <= Date.now()) {
    throw new Error('Choose an extension date and time after the current time.')
  }
  return target
}

function promptExtensionTarget({ studentName = '', initialTarget = null } = {}) {
  if (!elements.studentExtensionModal || !elements.studentExtensionForm) {
    return Promise.resolve(null)
  }
  const fallback = initialTarget instanceof Date && initialTarget.getTime() > Date.now()
    ? initialTarget
    : defaultAccessExtensionTarget()
  elements.studentExtensionTitle.textContent = studentName ? `Extend ${studentName}` : 'Extend access'
  elements.studentExtensionDate.value = localDateInputValue(fallback)
  elements.studentExtensionTime.value = nativeTimeInputValue(fallback)
  openModal(elements.studentExtensionModal)
  elements.studentExtensionDate.focus()

  return new Promise((resolve) => {
    let settled = false
    const cleanup = () => {
      elements.studentExtensionForm.removeEventListener('submit', handleSubmit)
      elements.studentExtensionCancel?.removeEventListener('click', handleCancel)
      elements.studentExtensionModal.removeEventListener('click', handleBackdrop)
    }
    const finish = (target) => {
      if (settled) return
      settled = true
      cleanup()
      closeModal(elements.studentExtensionModal)
      resolve(target)
    }
    const handleSubmit = (event) => {
      event.preventDefault()
      try {
        finish(selectedExtensionTarget(elements.studentExtensionDate, elements.studentExtensionTime, { fallbackTarget: null }))
      } catch (error) {
        window.alert(error.message)
      }
    }
    const handleCancel = () => finish(null)
    const handleBackdrop = (event) => {
      if (event.target === elements.studentExtensionModal) finish(null)
    }
    elements.studentExtensionForm.addEventListener('submit', handleSubmit)
    elements.studentExtensionCancel?.addEventListener('click', handleCancel)
    elements.studentExtensionModal.addEventListener('click', handleBackdrop)
  })
}

async function extendSelectedAssignmentUntil(target) {
  const assignment = getSelectedAssignment()
  if (!assignment) {
    window.alert('Select an assignment first.')
    return
  }

  const updatedAssignment = await request(`/api/edu/assignments/${assignment.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      temporary_access_until: target.toISOString(),
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
  const candidates = [
    studentSpecificExtensionFor(assignment, studentName),
    assignment?.temporary_access_until,
  ].filter(Boolean)
  return candidates.reduce((latest, value) => {
    const parsed = Date.parse(String(value || ''))
    if (!Number.isFinite(parsed)) {
      return latest
    }
    if (!latest || parsed > latest.time) {
      return { value, time: parsed }
    }
    return latest
  }, null)?.value || null
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
  const classAccessTime = Date.parse(String(assignment?.temporary_access_until || ''))
  if (Number.isFinite(classAccessTime) && classAccessTime >= accessTime) {
    return ''
  }
  return badge(`Special access until ${accessExtensionTargetLabel(accessTime)}`, 'good')
}

function wholeClassExtensionBadge(assignment, now = Date.now()) {
  const label = wholeClassExtensionLabel(assignment, new Date(now))
  return label ? badge(label, 'good') : ''
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

function feedbackRequestsForAssignment(assignment) {
  const requests = assignment?.student_feedback_requests && typeof assignment.student_feedback_requests === 'object'
    ? assignment.student_feedback_requests
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

async function approveAssignmentAccessRequest(assignment, requestEntry, { target = null } = {}) {
  const isAlreadyOpen = assignmentIsOpenNow(assignment)
  const nextRequests = { ...(assignment.student_access_requests || {}) }
  delete nextRequests[requestEntry.key]

  const nextStudentTemporaryAccessUntil = { ...(assignment.student_temporary_access_until || {}) }
  const nextStudentAccessRevoked = { ...(assignment.student_access_revoked || {}) }
  delete nextStudentAccessRevoked[requestEntry.key]
  if (isAlreadyOpen) {
    delete nextStudentTemporaryAccessUntil[requestEntry.key]
  } else {
    const extensionTarget = target instanceof Date ? target : defaultAccessExtensionTarget()
    if (extensionTarget.getTime() <= Date.now()) {
      throw new Error('Choose an extension date and time after the current time.')
    }
    nextStudentTemporaryAccessUntil[requestEntry.key] = extensionTarget.toISOString()
  }

  await submitAssignmentUpdateOptimistically(assignment, {
    student_access_requests: nextRequests,
    student_temporary_access_until: nextStudentTemporaryAccessUntil,
    student_access_revoked: nextStudentAccessRevoked,
  })
}

async function dismissFeedbackRequest(assignment, entry) {
  if (!assignment || !entry?.student_name) {
    return null
  }
  const updated = await request(`/api/edu/assignments/${assignment.id}/feedback-requests/${encodeURIComponent(entry.student_name)}`, {
    method: 'DELETE',
  })
  if (updated?.assignment) {
    replaceAssignmentInDashboard(updated.assignment)
    renderView()
  } else {
    const nextRequests = { ...(assignment.student_feedback_requests || {}) }
    delete nextRequests[entry.key]
    replaceAssignmentInDashboard({
      ...assignment,
      student_feedback_requests: nextRequests,
    })
    renderView()
  }
  return updated
}

async function extendSelectedAssignmentForStudentUntil(studentName, target) {
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

  const extensionTarget = target instanceof Date ? target : defaultAccessExtensionTarget()
  if (extensionTarget.getTime() <= Date.now()) {
    window.alert('Choose an extension date and time after the current time.')
    return
  }
  const nextStudentAccessRevoked = { ...(assignment.student_access_revoked || {}) }
  delete nextStudentAccessRevoked[normalizedKey]

  await submitAssignmentUpdateOptimistically(assignment, {
    student_access_revoked: nextStudentAccessRevoked,
    student_temporary_access_until: {
      ...(assignment.student_temporary_access_until || {}),
      [normalizedKey]: extensionTarget.toISOString(),
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

function upsertClassroomInState(classroom) {
  if (!dashboardState || !classroom?.id) return
  dashboardState = {
    ...dashboardState,
    classrooms: (dashboardState.classrooms || []).map((item) => item.id === classroom.id ? classroom : item),
  }
}

async function renameRosterStudent(classroom, oldName) {
  const nextName = window.prompt('Student name', oldName)
  if (nextName == null) return
  const cleanName = String(nextName || '').replace(/\s+/g, ' ').trim()
  if (!cleanName || cleanName === oldName) return
  const updated = await request(`/api/edu/classrooms/${encodeURIComponent(classroom.id)}/students/rename`, {
    method: 'POST',
    body: JSON.stringify({ old_name: oldName, new_name: cleanName }),
  })
  upsertClassroomInState(updated)
  renderAssignmentStage()
}

async function removeRosterStudent(classroom, studentName) {
  if (!window.confirm(`Remove ${studentName} from ${classroom.name}? They will lose access from this device.`)) {
    return
  }
  const result = await request(
    `/api/edu/classrooms/${encodeURIComponent(classroom.id)}/students/${encodeURIComponent(studentName)}`,
    { method: 'DELETE' },
  )
  if (result?.classroom) {
    upsertClassroomInState(result.classroom)
  }
  renderAssignmentStage()
}

function renderClassroomRoster(classroom) {
  if (!elements.classroomRosterPanel) return
  if (!classroom) {
    elements.classroomRosterPanel.innerHTML = ''
    return
  }
  const students = (Array.isArray(classroom.students) ? classroom.students : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
  elements.classroomRosterPanel.innerHTML = `
    <div class="classroom-roster-header">
      <div>
        <div class="section-label">Roster</div>
        <div class="muted">${students.length ? `${students.length} student${students.length === 1 ? '' : 's'}` : 'Students appear here after they join.'}</div>
      </div>
    </div>
    <div class="classroom-roster-list">
      ${students.length
        ? students.map((studentName) => `
          <div class="classroom-roster-row" data-student-name="${escapeHtml(studentName)}">
            <span>${escapeHtml(studentName)}</span>
            <span class="classroom-roster-actions">
              <button class="button button-secondary small-button" type="button" data-roster-rename>Rename</button>
              <button class="button button-secondary small-button" type="button" data-roster-remove>Remove</button>
            </span>
          </div>
        `).join('')
        : '<div class="linked-assignment-empty">No students have joined this class yet.</div>'}
    </div>
  `
  elements.classroomRosterPanel.querySelectorAll('[data-roster-rename]').forEach((button) => {
    button.addEventListener('click', async () => {
      const studentName = button.closest('[data-student-name]')?.dataset.studentName || ''
      try {
        await renameRosterStudent(classroom, studentName)
      } catch (error) {
        window.alert(`Could not rename student: ${error.message}`)
      }
    })
  })
  elements.classroomRosterPanel.querySelectorAll('[data-roster-remove]').forEach((button) => {
    button.addEventListener('click', async () => {
      const studentName = button.closest('[data-student-name]')?.dataset.studentName || ''
      try {
        await removeRosterStudent(classroom, studentName)
      } catch (error) {
        window.alert(`Could not remove student: ${error.message}`)
      }
    })
  })
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
      recordTeacherHistoryState()
    })
  })
}

function renderAssignmentStage() {
  const classroom = getSelectedClassroom()
  if (!classroom) {
    elements.assignmentStage.hidden = true
    renderClassroomRoster(null)
    elements.assignmentGrid.innerHTML = ''
    return
  }

  const assignments = getAssignmentsForClassroom(classroom.id)
  elements.assignmentStage.hidden = false
  elements.assignmentStageTitle.textContent = classroom.name
  renderClassroomRoster(classroom)
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
      const extensionBadge = wholeClassExtensionBadge(assignment)
      return `
        <button class="selection-card assignment-card${selected ? ' is-selected' : ''}" type="button" data-assignment-id="${escapeHtml(assignment.id)}">
          <span class="assignment-card-kicker">Assignment ${String(index + 1).padStart(2, '0')}</span>
          <span class="selection-title">${escapeHtml(assignment.title)}</span>
          <span class="selection-meta">${escapeHtml(assignment.course || classroom.name)}</span>
          <span class="selection-meta">${escapeHtml(assignmentAudienceLabel(assignment))}</span>
          <span class="selection-meta">${escapeHtml(formatWindowSummary(assignment))}</span>
          ${extensionBadge ? `<span class="assignment-card-badges">${extensionBadge}</span>` : ''}
          <span class="selection-card-action-label">View students</span>
        </button>
      `
    })
    .join('')

  elements.assignmentGrid.querySelectorAll('[data-assignment-id]').forEach((button) => {
    button.addEventListener('click', () => {
      selectedAssignmentId = button.dataset.assignmentId
      clearSelectedReviewSession()
      showAssignmentView()
    })
  })
}

function browserVisitDisplayLabel(item, assignment = getSelectedAssignment()) {
  const url = item?.url || '(unknown url)'
  const referenceDocumentId = String(url).match(/^handtyped:\/\/reference-document\/([^/?#]+)/)?.[1]
  if (referenceDocumentId) {
    const document = (assignment?.reference_documents || []).find((entry) => entry.id === referenceDocumentId)
    return document?.title || 'Reference PDF'
  }
  return url
}

function isDisplayableBrowserUrl(url) {
  const normalized = String(url || '').trim().toLowerCase()
  if (!normalized) {
    return false
  }
  return normalized !== 'about:blank'
}

function summarizeUrls(session, assignment = getSelectedAssignment()) {
  const items = (session.url_history || [])
    .filter((item) => isDisplayableBrowserUrl(item?.url))
    .slice(-4)
  if (!items.length) {
    return '<li>No recent browser visits.</li>'
  }
  return items
    .map((item) => {
      const url = item.url || '(unknown url)'
      const label = browserVisitDisplayLabel(item, assignment)
      return `<li class="${item?.allowed === false ? 'student-url-illegal' : ''}" title="${escapeHtml(url)}">${escapeHtml(label)}</li>`
    })
    .join('')
}

function selectedSessionReviewSummary(session, assignment) {
  const summary = reviewSummaryForSession(session, assignment)
  const badges = []
  if (summary.grading.grade_label) {
    badges.push(
      badge(
        `Grade ${summary.grading.grade_label}${summary.grading.grade_score ? ` / ${summary.grading.grade_score}` : ''}`,
        'good',
      ),
    )
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

function buildReviewPayload({ publishFeedback = false } = {}) {
  if (!reviewState) return null
  const session = currentReviewSession()
  const assignment = getSelectedAssignment()
  const reviewText = handtypedMarkdownDisplayText(displaySessionText(session, reviewState.replayData))
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
    rubric_scores: normalizedRubricScoresForAssignment(reviewState.rubricScores, assignment),
    teacher_comment: reviewState.teacherComment,
    returned_for_revision: reviewState.returnedForRevision,
    grade_label: reviewState.gradeLabel,
    grade_score: reviewState.gradeScore === '' ? null : Number(reviewState.gradeScore),
    inline_annotations: reviewState.inlineAnnotations.map((annotation) => ({
      ...annotation,
      updated_at: annotation.updated_at || annotation.created_at || new Date().toISOString(),
    })),
    publish_feedback: Boolean(publishFeedback || reviewState.feedbackStatus === 'published'),
    allow_empty_feedback: Array.isArray(reviewState.deletedAnnotationIds) && reviewState.deletedAnnotationIds.length > 0,
  }
}

function reviewPayloadFeedbackFingerprint(payload) {
  const { session_snapshot: _sessionSnapshot, publish_feedback: _publishFeedback, ...feedbackPayload } = payload || {}
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
    const publishLabel = reviewState.feedbackStatus === 'published'
      ? reviewState.publishedAt
        ? ` • published ${timeAgoLabel(reviewState.publishedAt)}`
        : ' • published'
      : ' • draft'
    elements.reviewSyncStatus.textContent = `Saved ${timeAgoLabel(reviewState.updatedAt)}${publishLabel}`
    elements.reviewSyncStatus.classList.add('is-saved')
    return
  }
  elements.reviewSyncStatus.textContent = 'Not yet saved'
}

function clearReviewPublishConfirmation() {
  if (!reviewState) return
  reviewState.publishConfirmation = ''
  reviewState.publishingFeedback = false
  reviewState.feedbackControlsClearedAfterPublish = false
  renderReviewPublishConfirmation()
  renderReviewPublishButton()
}

function renderReviewPublishConfirmation() {
  if (!elements.reviewPublishConfirmation) return
  const message = String(reviewState?.publishConfirmation || '').trim()
  elements.reviewPublishConfirmation.hidden = !message
  elements.reviewPublishConfirmation.textContent = message
}

function renderReviewPublishButton() {
  if (!elements.reviewPublishFeedback) return
  const isPublishing = Boolean(reviewState?.publishingFeedback)
  elements.reviewPublishFeedback.disabled = isPublishing
  elements.reviewPublishFeedback.textContent = isPublishing ? 'Publishing…' : 'Publish feedback'
  if (elements.reviewDeleteFeedback) {
    const isDeleting = Boolean(reviewState?.deletingFeedback)
    elements.reviewDeleteFeedback.disabled = isPublishing || isDeleting || !reviewState?.updatedAt
    elements.reviewDeleteFeedback.textContent = isDeleting ? 'Deleting…' : 'Delete feedback'
  }
}

function clearReviewFeedbackInputsAfterPublish() {
  if (reviewState) {
    reviewState.gradeLabel = ''
    reviewState.gradeScore = ''
    reviewState.teacherComment = ''
    reviewState.returnedForRevision = false
    reviewState.rubricScores = {}
  }
  if (elements.reviewGradeLabel) elements.reviewGradeLabel.value = ''
  if (elements.reviewGradeScore) elements.reviewGradeScore.value = ''
  if (elements.reviewTeacherComment) elements.reviewTeacherComment.value = ''
  if (elements.reviewReturned) elements.reviewReturned.checked = false
  elements.reviewRubricList?.querySelectorAll('[data-review-rubric-score]').forEach((select) => {
    select.value = '0'
  })
  if (elements.reviewRubricTotal) {
    const assignment = getSelectedAssignment()
    const total = (assignment?.rubric || []).reduce(
      (sum, criterion) => sum + Math.max(1, Number(criterion.points || 0)),
      0,
    )
    elements.reviewRubricTotal.textContent = total ? `0/${total} points selected` : ''
  }
}

function renderReviewPublishedSuccess() {
  clearReviewFeedbackInputsAfterPublish()
  renderReviewWorkspace(getSelectedAssignment())
  renderReviewPublishConfirmation()
  renderReviewPublishButton()
}

function ensureReviewStateForPublish() {
  if (reviewState) {
    return reviewState
  }
  const session = currentReviewSession()
  if (!session) {
    return null
  }
  reviewState = createReviewStateFromSession(session)
  syncSelectedReviewSessionSnapshot(session)
  return reviewState
}

function markReviewDirty() {
  if (!reviewState) return
  clearReviewPublishConfirmation()
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
        live_sessions: mergeLiveSessions(getLiveSessions(), [updatedSession]),
      }
      if (reviewState?.sessionId === sessionId) {
        const grading = normalizedSessionGrading(updatedSession)
        reviewState.updatedAt = grading.updated_at
        reviewState.feedbackStatus = grading.feedback_status
        reviewState.publishedAt = grading.published_at
        reviewState.updatedBy = grading.actor_name || grading.actor_email || ''
        if (reviewPayloadFeedbackFingerprint(buildReviewPayload()) === payloadFingerprint) {
          reviewState.dirty = false
          reviewState.saveState = 'saved'
          reviewState.deletedAnnotationIds = []
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

async function publishCurrentReviewFeedback() {
  const activeReviewState = ensureReviewStateForPublish()
  if (!activeReviewState) {
    window.alert('Choose a student draft before publishing feedback.')
    return
  }
  if (activeReviewState.publishingFeedback) return
  reviewState.publishingFeedback = true
  renderReviewPublishButton()
  let sessionId = ''
  try {
    await flushReviewSave()
    if (!reviewState) return
    sessionId = reviewState.sessionId
    const payload = buildReviewPayload({ publishFeedback: true })
    reviewState.saveState = 'saving'
    renderReviewSyncStatus()
    const updatedSession = await request(`/api/edu/live-sessions/${encodeURIComponent(sessionId)}/grading`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    })
    dashboardState = {
      ...dashboardState,
      live_sessions: mergeLiveSessions(getLiveSessions(), [updatedSession]),
    }
    if (reviewState?.sessionId === sessionId) {
      const grading = normalizedSessionGrading(updatedSession)
      reviewState.updatedAt = grading.updated_at
      reviewState.feedbackStatus = grading.feedback_status
      reviewState.publishedAt = grading.published_at
      reviewState.updatedBy = grading.actor_name || grading.actor_email || ''
      reviewState.dirty = false
      reviewState.saveState = 'saved'
      reviewState.deletedAnnotationIds = []
      reviewState.publishConfirmation = `Feedback published for ${updatedSession.student_name || 'this student'}.`
      reviewState.publishingFeedback = false
      reviewState.feedbackControlsClearedAfterPublish = true
    }
    renderReviewSyncStatus()
    renderStudentCards({ skipReviewWorkspace: true })
    renderReviewPublishedSuccess()
  } catch (error) {
    if (reviewState?.sessionId === sessionId) {
      reviewState.saveState = 'error'
    }
    if (reviewState) {
      reviewState.publishingFeedback = false
    }
    renderReviewSyncStatus()
    window.alert(`Could not publish feedback: ${error.message}`)
  } finally {
    renderReviewPublishButton()
  }
}

async function deleteCurrentReviewFeedback() {
  const activeReviewState = ensureReviewStateForPublish()
  if (!activeReviewState) {
    window.alert('Choose a student draft before deleting feedback.')
    return
  }
  if (activeReviewState.deletingFeedback) return
  reviewState.deletingFeedback = true
  renderReviewPublishButton()
  const sessionId = reviewState.sessionId
  try {
    if (reviewSaveTimer) {
      clearTimeout(reviewSaveTimer)
      reviewSaveTimer = null
    }
    const updatedSession = await request(`/api/edu/live-sessions/${encodeURIComponent(sessionId)}/grading`, {
      method: 'DELETE',
    })
    dashboardState = {
      ...dashboardState,
      live_sessions: mergeLiveSessions(getLiveSessions(), [updatedSession]),
    }
    if (reviewState?.sessionId === sessionId) {
      const grading = normalizedSessionGrading(updatedSession)
      reviewState.gradeLabel = ''
      reviewState.gradeScore = ''
      reviewState.teacherComment = ''
      reviewState.returnedForRevision = false
      reviewState.rubricScores = {}
      reviewState.inlineAnnotations = []
      reviewState.updatedAt = grading.updated_at
      reviewState.feedbackStatus = grading.feedback_status
      reviewState.publishedAt = grading.published_at
      reviewState.updatedBy = grading.actor_name || grading.actor_email || ''
      reviewState.dirty = false
      reviewState.saveState = 'saved'
      reviewState.deletedAnnotationIds = []
      reviewState.publishConfirmation = `Feedback deleted for ${updatedSession.student_name || 'this student'}.`
      reviewState.deletingFeedback = false
      selectedAnnotationId = null
    }
    clearReviewFeedbackInputsAfterPublish()
    renderReviewSyncStatus()
    renderStudentCards({ skipReviewWorkspace: true })
    renderReviewWorkspace(getSelectedAssignment())
    renderReviewPublishConfirmation()
  } catch (error) {
    if (reviewState?.sessionId === sessionId) {
      reviewState.saveState = 'error'
      reviewState.deletingFeedback = false
    }
    renderReviewSyncStatus()
    window.alert(`Could not delete feedback: ${error.message}`)
  } finally {
    renderReviewPublishButton()
  }
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

function saveReviewSnapshotBeforeSwitch() {
  if (reviewSaveTimer) {
    clearTimeout(reviewSaveTimer)
    reviewSaveTimer = null
  }
  const pendingSave = reviewSavePromise?.catch(() => {}) || Promise.resolve()
  if (!reviewState?.dirty) {
    return pendingSave
  }

  const sessionId = reviewState.sessionId
  const payload = buildReviewPayload()
  reviewState.dirty = false
  reviewState.saveState = 'saving'
  renderReviewSyncStatus()

  return pendingSave
    .then(() =>
      request(`/api/edu/live-sessions/${encodeURIComponent(sessionId)}/grading`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
    )
    .then((updatedSession) => {
      dashboardState = {
        ...dashboardState,
        live_sessions: mergeLiveSessions(getLiveSessions(), [updatedSession]),
      }
      if (reviewState?.sessionId === sessionId) {
        const grading = normalizedSessionGrading(updatedSession)
        reviewState.updatedAt = grading.updated_at
        reviewState.feedbackStatus = grading.feedback_status
        reviewState.publishedAt = grading.published_at
        reviewState.updatedBy = grading.actor_name || grading.actor_email || ''
        reviewState.saveState = 'saved'
        renderReviewSyncStatus()
      }
      renderStudentCards({ skipReviewWorkspace: true })
    })
    .catch((error) => {
      if (reviewState?.sessionId === sessionId) {
        reviewState.dirty = true
        reviewState.saveState = 'error'
        renderReviewSyncStatus()
      }
      throw error
    })
}

function clearReviewComposer() {
  if (!reviewState) return
  reviewState.selection = null
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
  const composerOpen = Boolean(selection)
  elements.reviewComposer.hidden = !composerOpen
  elements.reviewComposerLabel.textContent = 'New comment'
  if (elements.reviewComposerNote && elements.reviewComposerNote.value !== reviewState.composerNote) {
    elements.reviewComposerNote.value = reviewState.composerNote
  }
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
  if (!reviewState?.selection) return
  const { start, end, text } = reviewState.selection
  const reviewText = handtypedMarkdownDisplayText(displaySessionText(currentReviewSession(), reviewState.replayData))
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

async function deleteReviewAnnotation(annotationId) {
  if (!reviewState) return
  const beforeCount = reviewState.inlineAnnotations.length
  reviewState.inlineAnnotations = reviewState.inlineAnnotations.filter((annotation) => annotation.id !== annotationId)
  if (reviewState.inlineAnnotations.length === beforeCount) {
    return
  }
  reviewState.deletedAnnotationIds = [
    ...new Set([...(reviewState.deletedAnnotationIds || []), annotationId].filter(Boolean)),
  ]
  if (selectedAnnotationId === annotationId) {
    selectedAnnotationId = null
  }
  markReviewDirty()
  renderReviewWorkspace(getSelectedAssignment())
  try {
    await flushReviewSave()
  } catch (error) {
    window.alert(`Could not delete comment: ${error.message}`)
  }
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

function reviewPdfAnnotatedDraftHtml(text, annotations = []) {
  const source = String(text || '')
  if (!source) {
    return escapeHtml('(empty draft)')
  }
  const markers = annotations
    .map((annotation, index) => ({
      label: index + 1,
      start: Math.max(0, Math.min(source.length, Number(annotation.start ?? 0) || 0)),
      end: Math.max(0, Math.min(source.length, Number(annotation.end ?? annotation.start ?? 0) || 0)),
      quote: annotation.quote || source.slice(annotation.start, annotation.end) || '(selection unavailable)',
      note: annotation.note || '',
    }))
    .map((marker) => ({
      ...marker,
      end: Math.max(marker.start, marker.end),
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end || a.label - b.label)
  if (!markers.length) {
    return escapeHtml(source)
  }

  let html = ''
  let cursor = 0
  markers.forEach((marker) => {
    const start = Math.max(cursor, marker.start)
    const end = Math.max(start, marker.end)
    html += escapeHtml(source.slice(cursor, start))
    const highlighted = source.slice(start, end)
    if (highlighted) {
      html += `<span class="comment-highlight">${escapeHtml(highlighted)}</span>`
    }
    html += `<sup class="comment-marker">${escapeHtml(marker.label)}</sup>`
    html += `
      <div class="inline-comment">
        <h3>${escapeHtml(`${marker.label}. Comment`)}</h3>
        <p>${escapeHtml(marker.note)}</p>
      </div>
    `
    cursor = end
  })
  html += escapeHtml(source.slice(cursor))
  return html
}

function reviewPdfExportHtml({
  session,
  assignment,
  reviewText,
  teacherComment,
  inlineAnnotations,
  rubricScores,
  gradeLabel,
  gradeScore,
} = {}) {
  const text = handtypedMarkdownDisplayText(reviewText || '')
  const annotations = visibleReviewAnnotations(inlineAnnotations)
    .map((annotation) => annotationDisplayState(annotation, text))
    .sort((a, b) => a.start - b.start || a.end - b.end)
  const studentName = String(session?.student_name || 'Student')
  const assignmentTitle = String(assignment?.title || session?.assignment_title || 'Assignment')
  const classroom = String(session?.classroom || assignment?.classroom_name || '')
  const course = String(session?.course || assignment?.course || '')
  const metaParts = [course, classroom].filter(Boolean)
  const gradeParts = [
    String(gradeLabel || '').trim(),
    String(gradeScore || '').trim(),
  ].filter(Boolean)
  const printedAt = new Date().toLocaleString()
  const rubric = Array.isArray(assignment?.rubric) ? assignment.rubric : []
  const normalizedRubricScores = normalizedRubricScoresForAssignment(rubricScores, assignment)
  const rubricTotal = rubric.reduce((sum, criterion) => sum + Math.max(1, Number(criterion.points || 0)), 0)
  const rubricEarned = rubric.reduce(
    (sum, criterion) => sum + Number(normalizedRubricScores[criterion.id] || 0),
    0,
  )

  const annotationFallbackHtml = annotations.length ? '' : '<p class="muted">No inline comments.</p>'
  const rubricHtml = rubric.length
    ? `
      <section class="rubric-summary">
        <h2>Rubric Score</h2>
        <table>
          <thead>
            <tr>
              <th>Criterion</th>
              <th>Score</th>
            </tr>
          </thead>
          <tbody>
            ${rubric
              .map((criterion) => {
                const max = Math.max(1, Number(criterion.points || 0))
                const score = Number(normalizedRubricScores[criterion.id] || 0)
                return `
                  <tr>
                    <td>
                      <strong>${escapeHtml(criterion.title || 'Criterion')}</strong>
                      ${criterion.description ? `<div class="muted">${escapeHtml(criterion.description)}</div>` : ''}
                    </td>
                    <td>${escapeHtml(`${score}/${max}`)}</td>
                  </tr>
                `
              })
              .join('')}
          </tbody>
          <tfoot>
            <tr>
              <th>Total</th>
              <th>${escapeHtml(`${rubricEarned}/${rubricTotal}`)}</th>
            </tr>
          </tfoot>
        </table>
      </section>
    `
    : ''
  const overallFeedbackHtml = `
    <section class="overall-feedback-summary">
      <h2>Teacher Overall Feedback</h2>
      <div class="overall-comment">${escapeHtml(String(teacherComment || '').trim() || 'No overall feedback.')}</div>
    </section>
  `

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml(`${studentName} - ${assignmentTitle}`)}</title>
    <style>
      @page { margin: 0.7in; }
      body {
        color: #111827;
        font-family: "Times New Roman", Times, serif;
        font-size: 12pt;
        line-height: 1.5;
      }
      header {
        border-bottom: 1px solid #d1d5db;
        margin-bottom: 20px;
        padding-bottom: 12px;
      }
      h1 {
        font-size: 18pt;
        line-height: 1.2;
        margin: 0 0 6px;
      }
      h2 {
        border-bottom: 1px solid #e5e7eb;
        font-size: 14pt;
        margin: 24px 0 10px;
        padding-bottom: 4px;
      }
      h3 {
        font-size: 12pt;
        margin: 0 0 6px;
      }
      .meta,
      .muted {
        color: #4b5563;
      }
      .draft {
        white-space: pre-wrap;
      }
      .overall-comment,
      .comment {
        break-inside: avoid;
        border-left: 3px solid #2563eb;
        margin: 0 0 14px;
        padding-left: 12px;
      }
      .student-text-column h2 {
        margin-top: 0;
      }
      .comment-marker {
        color: #2563eb;
        font-family: Arial, sans-serif;
        font-size: 9pt;
        font-weight: 700;
        line-height: 1;
        margin-left: 2px;
      }
      .comment-highlight {
        background: #fef08a;
        border-bottom: 2px solid #ca8a04;
        box-decoration-break: clone;
        box-shadow: inset 0 -0.32em 0 #fef08a;
        -webkit-box-decoration-break: clone;
        -webkit-print-color-adjust: exact;
        padding: 0 2px;
        print-color-adjust: exact;
      }
      .inline-comment {
        break-inside: avoid;
        border-left: 3px solid #2563eb;
        font-size: 10pt;
        line-height: 1.3;
        margin: 8px 0 14px;
        padding-left: 10px;
        white-space: normal;
      }
      .inline-comment h3 {
        margin: 0 0 5px;
      }
      .inline-comment p {
        margin: 0;
      }
      .overall-feedback-summary,
      .rubric-summary {
        clear: both;
        break-inside: avoid;
        margin-top: 24px;
      }
      table {
        border-collapse: collapse;
        width: 100%;
      }
      th,
      td {
        border-bottom: 1px solid #d1d5db;
        padding: 6px 8px;
        text-align: left;
        vertical-align: top;
      }
      th:last-child,
      td:last-child {
        text-align: right;
        white-space: nowrap;
        width: 1in;
      }
      blockquote {
        border-left: 2px solid #d1d5db;
        color: #374151;
        margin: 0 0 8px;
        padding-left: 10px;
        white-space: pre-wrap;
      }
    </style>
  </head>
  <body>
    <header>
      <h1>${escapeHtml(studentName)}</h1>
      <div class="meta">${escapeHtml(assignmentTitle)}</div>
      ${metaParts.length ? `<div class="meta">${escapeHtml(metaParts.join(' • '))}</div>` : ''}
      ${gradeParts.length ? `<div class="meta">Grade: ${escapeHtml(gradeParts.join(' / '))}</div>` : ''}
      <div class="meta">Exported ${escapeHtml(printedAt)}</div>
    </header>
    <main class="review-export-layout">
      <section class="student-text-column">
        <h2>Student Text</h2>
        ${annotationFallbackHtml}
        <div class="draft">${reviewPdfAnnotatedDraftHtml(text, annotations)}</div>
      </section>
    </main>
    ${overallFeedbackHtml}
    ${rubricHtml}
  </body>
</html>`
}

function exportCurrentReviewPdf() {
  const session = currentReviewSession()
  const assignment = getSelectedAssignment()
  if (!session || !assignment || !reviewState) {
    window.alert('Choose a student before exporting feedback.')
    return
  }
  const reviewText = displaySessionText(session, reviewState.replayData)
  const html = reviewPdfExportHtml({
    session,
    assignment,
    reviewText,
    teacherComment: elements.reviewTeacherComment?.value ?? reviewState.teacherComment,
    inlineAnnotations: reviewState.inlineAnnotations,
    rubricScores: reviewState.rubricScores,
    gradeLabel: elements.reviewGradeLabel?.value ?? reviewState.gradeLabel,
    gradeScore: elements.reviewGradeScore?.value ?? reviewState.gradeScore,
  })
  const popup = window.open('', '_blank')
  if (!popup?.document) {
    window.alert('Could not open the PDF export window. Please allow popups for Handtyped EDU and try again.')
    return
  }
  popup.document.open()
  popup.document.write(html)
  popup.document.close()
  popup.focus?.()
  setTimeout(() => popup.print?.(), 50)
}

const REVIEW_WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

function normalizeReviewDateInput(value) {
  const normalized = String(value || '').trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : ''
}

function parseReviewDateList(value) {
  return String(value || '')
    .split(/[,\s]+/)
    .map(normalizeReviewDateInput)
    .filter(Boolean)
}

function parseReviewTimeInput(value) {
  const match = String(value || '').trim().match(/^(\d{1,2})(?::(\d{1,2}))?\s*([ap])m?$/i)
  if (!match) {
    return null
  }
  const hour = Number(match[1])
  const minute = match[2] == null ? 0 : Number(match[2])
  const meridiem = String(match[3]).toLowerCase()
  if (minute < 0 || minute > 59) {
    return null
  }
  if (hour < 1 || hour > 12) {
    return null
  }
  const normalizedHour = meridiem === 'a'
    ? hour === 12 ? 0 : hour
    : hour === 12 ? 12 : hour + 12
  return normalizedHour * 60 + minute
}

function parseReviewNativeTimeInput(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!match) {
    return null
  }
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null
  }
  return hour * 60 + minute
}

function parseReviewHighlightTimeInput(value) {
  return parseReviewNativeTimeInput(value) ?? parseReviewTimeInput(value)
}

function reviewReplayLocalParts(absoluteMs) {
  if (absoluteMs == null || absoluteMs === '') {
    return null
  }
  const date = new Date(Number(absoluteMs))
  if (Number.isNaN(date.getTime()) || date.getTime() <= 0) {
    return null
  }
  return {
    date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
      date.getDate(),
    ).padStart(2, '0')}`,
    weekday: REVIEW_WEEKDAYS[date.getDay()],
    minuteOfDay: date.getHours() * 60 + date.getMinutes(),
  }
}

function replayTeacherDateInputValue(absoluteMs) {
  const parts = reviewReplayLocalParts(absoluteMs)
  return parts?.date || ''
}

function reviewHighlightFilterForState() {
  const selectedDates = new Set([
    normalizeReviewDateInput(reviewState?.highlightDate),
    ...parseReviewDateList(reviewState?.highlightDates),
  ].filter(Boolean))
  const selectedWeekdays = new Set(
    (Array.isArray(reviewState?.highlightWeekdays) ? reviewState.highlightWeekdays : [])
      .map((day) => String(day || '').toLowerCase())
      .filter((day) => REVIEW_WEEKDAYS.includes(day)),
  )
  const startMinute = parseReviewHighlightTimeInput(reviewState?.highlightStartTime)
  const endMinute = parseReviewHighlightTimeInput(reviewState?.highlightEndTime)
  return {
    selectedDates,
    selectedWeekdays,
    startMinute,
    endMinute,
    hasDateFilter: selectedDates.size > 0 || selectedWeekdays.size > 0,
    hasTimeFilter: startMinute != null || endMinute != null,
  }
}

function reviewTimeValue(hour = 0, minute = 0) {
  return formatClockTime(hour, minute)
}

function assignmentTimeInputValue(hour = 0, minute = 0) {
  const normalizedHour = Number.isFinite(Number(hour)) ? Number(hour) : 0
  const normalizedMinute = Number.isFinite(Number(minute)) ? Number(minute) : 0
  return `${String(normalizedHour).padStart(2, '0')}:${String(normalizedMinute).padStart(2, '0')}`
}

function setReviewHighlightModeFromControls() {
  if (!reviewState) return
  const hasDates = Boolean(normalizeReviewDateInput(reviewState.highlightDate) || parseReviewDateList(reviewState.highlightDates).length)
  const hasWeekdays = Array.isArray(reviewState.highlightWeekdays) && reviewState.highlightWeekdays.length > 0
  const hasTime = Boolean(parseReviewHighlightTimeInput(reviewState.highlightStartTime) != null || parseReviewHighlightTimeInput(reviewState.highlightEndTime) != null)
  reviewState.highlightMode = hasDates || hasWeekdays || hasTime ? 'custom' : 'none'
}

function setReviewWeekdays(days = []) {
  if (!reviewState) return
  const selected = new Set(days)
  reviewState.highlightWeekdays = REVIEW_WEEKDAYS.filter((day) => selected.has(day))
}

function applyReviewHighlightPreset(preset) {
  if (!reviewState) return
  const assignment = getSelectedAssignment()
  const window = assignment?.windows?.[0] || null
  if (preset === 'all') {
    reviewState.highlightDate = ''
    reviewState.highlightDates = ''
    reviewState.highlightStartTime = ''
    reviewState.highlightEndTime = ''
    reviewState.highlightWeekdays = []
    reviewState.highlightMode = 'custom'
    return
  }
  if (preset === 'weekdays') {
    setReviewWeekdays(['monday', 'tuesday', 'wednesday', 'thursday', 'friday'])
    setReviewHighlightModeFromControls()
    return
  }
  if (preset === 'window' && window) {
    reviewState.highlightStartTime = reviewTimeValue(window.start_hour, window.start_minute)
    reviewState.highlightEndTime = reviewTimeValue(window.end_hour, window.end_minute)
    setReviewHighlightModeFromControls()
    return
  }
  if (preset === 'after-school') {
    reviewState.highlightStartTime = window
      ? reviewTimeValue(window.end_hour, window.end_minute)
      : '3:00 PM'
    reviewState.highlightEndTime = '11:59 PM'
    setReviewHighlightModeFromControls()
    return
  }
  if (preset === 'evening') {
    reviewState.highlightStartTime = '6:00 PM'
    reviewState.highlightEndTime = '11:59 PM'
    setReviewHighlightModeFromControls()
  }
}

function syncReviewHighlightInputValue(input, value) {
  if (!input || document.activeElement === input) {
    return
  }
  input.value = value || ''
}

function nativeReviewTimeValue(value) {
  const minutes = parseReviewHighlightTimeInput(value)
  if (minutes == null) {
    return ''
  }
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

function syncReviewHighlightTimeInput(input, value) {
  if (!input || document.activeElement === input) {
    return
  }
  input.value = nativeReviewTimeValue(value)
}

function reviewTimestampMatchesHighlight(insertedAtMs) {
  const parts = reviewReplayLocalParts(insertedAtMs)
  if (!parts) {
    return false
  }
  const filter = reviewHighlightFilterForState()
  const dateMatches =
    !filter.hasDateFilter || filter.selectedDates.has(parts.date) || filter.selectedWeekdays.has(parts.weekday)
  if (!dateMatches) {
    return false
  }
  if (!filter.hasTimeFilter) {
    return true
  }
  const minute = parts.minuteOfDay
  if (filter.startMinute != null && filter.endMinute != null) {
    return filter.startMinute <= filter.endMinute
      ? minute >= filter.startMinute && minute <= filter.endMinute
      : minute >= filter.startMinute || minute <= filter.endMinute
  }
  if (filter.startMinute != null) {
    return minute >= filter.startMinute
  }
  return minute <= filter.endMinute
}

function reviewTimestampEntryMatchesHighlight(entry) {
  const insertedAtMs = Number(entry?.insertedAtMs)
  return Number.isFinite(insertedAtMs) && reviewTimestampMatchesHighlight(insertedAtMs)
}

function reviewHighlightRangesForState(session, assignment) {
  if (!reviewState?.replayData?.attributedDocument) {
    return []
  }
  return reviewHighlightModeActive() ? [{ custom: true }] : []
}

function reviewHighlightModeActive() {
  return Boolean(reviewState?.highlightMode && reviewState.highlightMode !== 'none')
}

function reviewHighlightRequiresPreciseTiming() {
  if (!reviewHighlightModeActive()) {
    return false
  }
  const filter = reviewHighlightFilterForState()
  return Boolean(filter.hasDateFilter || filter.hasTimeFilter)
}

function attributedDocumentHasReliableInsertionTiming(attributed = {}) {
  const chars = Array.isArray(attributed?.chars) ? attributed.chars : []
  const finiteTimes = chars
    .map((entry) => Number(entry?.insertedAtMs))
    .filter((value) => Number.isFinite(value))
  if (!finiteTimes.length) {
    return false
  }
  if (chars.length > 1 && new Set(finiteTimes).size <= 1) {
    return false
  }
  return true
}

function reviewHighlightTimingUnavailableMessage() {
  return 'Precise replay timing is not available for this draft, so time-based highlighting cannot be applied reliably.'
}

function reviewHighlightIndexSet(text, ranges, sourceMarkdown = '') {
  if (!reviewState?.replayData?.attributedDocument || !Array.isArray(ranges) || !ranges.length) {
    return new Set()
  }
  const attributed = reviewState.replayData.attributedDocument
  const active = new Set()
  const collectReplayHistoryIndexes = () => {
    const replay = reviewState?.replayData?.replay || {}
    const history = annotateReplayHistoryWithEventTimes(replay)
    const finalChars = Array.from(String(text || ''))
    history.forEach((entry) => {
      if (!reviewTimestampEntryMatchesHighlight({ insertedAtMs: Number(entry?.absolute_wall_ms) })) {
        return
      }
      const pos = Number(entry?.pos)
      const inserted = String(entry?.ins || '')
      if (!Number.isInteger(pos) || pos < 0 || !inserted) {
        return
      }
      if (pos === 0 && !String(entry?.del || '') && Array.from(inserted).length >= 8) {
        return
      }
      const insertedChars = Array.from(inserted)
      if (finalChars.slice(pos, pos + insertedChars.length).join('') !== inserted) {
        return
      }
      for (let index = pos; index < pos + insertedChars.length && index < finalChars.length; index += 1) {
        active.add(index)
      }
    })
  }
  const collectAttributedIndexes = (chars = attributed.chars) => {
    chars.forEach((entry, index) => {
      if (ranges.some((range) => range.custom ? reviewTimestampEntryMatchesHighlight(entry) : Number(entry?.insertedAtMs) >= range.startMs && Number(entry?.insertedAtMs) <= range.endMs)) {
        active.add(index)
      }
    })
  }
  const suppressCoarseFullHighlight = () =>
    ranges.some((range) => range.custom) &&
    reviewHighlightRequiresPreciseTiming() &&
    !attributedDocumentHasReliableInsertionTiming(attributed) &&
    active.size >= Array.from(String(text || '')).length

  if (attributed.text === String(text || '')) {
    collectAttributedIndexes()
    collectReplayHistoryIndexes()
    if (suppressCoarseFullHighlight()) {
      return new Set()
    }
    return active
  }

  if (attributed.text && String(text || '').startsWith(attributed.text)) {
    collectAttributedIndexes()
    if (suppressCoarseFullHighlight()) {
      return new Set()
    }
    return active
  }

  const source = String(sourceMarkdown || '')
  if (source && attributed.text === source) {
    const model = handtypedMarkdownDisplayModel(source)
    if (model.text !== String(text || '')) {
      return active
    }
    model.chars.forEach((entry, displayIndex) => {
      const sourceEntry = attributed.chars[entry.sourceIndex]
      const insertedAtMs = Number(sourceEntry?.insertedAtMs)
      if (ranges.some((range) => range.custom ? reviewTimestampEntryMatchesHighlight(sourceEntry) : insertedAtMs >= range.startMs && insertedAtMs <= range.endMs)) {
        active.add(displayIndex)
      }
    })
  }
  if (source && source.startsWith(attributed.text || '')) {
    const attributedModel = handtypedMarkdownDisplayModel(attributed.text || '')
    if (String(text || '').startsWith(attributedModel.text)) {
      attributedModel.chars.forEach((entry, displayIndex) => {
        const sourceEntry = attributed.chars[entry.sourceIndex]
        const insertedAtMs = Number(sourceEntry?.insertedAtMs)
        if (ranges.some((range) => range.custom ? reviewTimestampEntryMatchesHighlight(sourceEntry) : insertedAtMs >= range.startMs && insertedAtMs <= range.endMs)) {
          active.add(displayIndex)
        }
      })
    }
  }
  if (suppressCoarseFullHighlight()) {
    return new Set()
  }
  return active
}

function renderIndexedSlice(text, start, end, annotation, highlightIndexes, selectionIndexes) {
  return renderIndexedSegments(
    handtypedMarkdownDisplayModel(text),
    start,
    end,
    annotation,
    highlightIndexes,
    selectionIndexes,
  )
}

function markdownStyleKey(mark = {}) {
  return [
    mark.align || '',
    mark.size || '',
    mark.font || '',
    mark.bold ? 'b' : '',
    mark.italic ? 'i' : '',
    mark.underline ? 'u' : '',
    mark.highlight ? 'h' : '',
    mark.heading || '',
    mark.pageBreak ? 'page' : '',
  ].join('|')
}

function copyMarkdownMarks(active, extra = {}) {
  return {
    size: active.size || '',
    font: active.font || '',
    bold: Boolean(active.bold),
    italic: Boolean(active.italic),
    underline: Boolean(active.underline),
    highlight: Boolean(active.highlight),
    align: active.align || '',
    heading: active.heading || '',
    pageBreak: Boolean(active.pageBreak),
    ...extra,
  }
}

function handtypedMarkdownDisplayModel(markdown = '') {
  const raw = String(markdown || '').replace(/\r/g, '')
  const chars = []
  const active = {}
  let index = 0
  let atLineStart = true
  let heading = ''

  const pushChar = (char, sourceIndex) => {
    chars.push({
      char,
      sourceIndex,
      marks: copyMarkdownMarks(active, { heading }),
    })
    atLineStart = char === '\n'
    if (char === '\n') {
      heading = ''
    }
  }
  const pushPageBreak = (sourceIndex) => {
    chars.push({
      char: '\n',
      sourceIndex,
      marks: copyMarkdownMarks(active, { heading: '', pageBreak: true }),
    })
    atLineStart = true
    heading = ''
  }

  while (index < raw.length) {
    const rest = raw.slice(index)
    if (atLineStart) {
      const pageBreakMatch = rest.match(/^(?:-{3,}|\*{3,}|_{3,})[ \t]*(?:\n|$)/)
      if (pageBreakMatch) {
        pushPageBreak(index)
        index += pageBreakMatch[0].length
        continue
      }
      const headingMatch = rest.match(/^(#{1,3})[ \t]+/)
      if (headingMatch) {
        heading = `h${headingMatch[1].length}`
        index += headingMatch[0].length
        atLineStart = false
        continue
      }
    }

    const softTabPairMatch = rest.match(/^\\?\[handtyped-tab\\?\]\\?\[\/handtyped-tab\\?\]/i)
    if (softTabPairMatch) {
      pushChar('\t', index)
      index += softTabPairMatch[0].length
      continue
    }

    const softTabMatch = rest.match(/^\\?\[\/?handtyped-tab\\?\]/i)
    if (softTabMatch) {
      pushChar('\t', index)
      index += softTabMatch[0].length
      continue
    }

    const bracketMatch = rest.match(/^\[(\/?)(size|font|u|highlight|align)(?:[ =]([^\]]+))?\]/i)
    if (bracketMatch) {
      const closing = Boolean(bracketMatch[1])
      const name = bracketMatch[2].toLowerCase()
      const value = String(bracketMatch[3] || '').trim().toLowerCase()
      if (name === 'size') {
        active.size = closing ? '' : value.replace(/[^\d]/g, '')
      } else if (name === 'font') {
        active.font = closing ? '' : value
      } else if (name === 'u') {
        active.underline = !closing
      } else if (name === 'highlight') {
        active.highlight = !closing
      } else if (name === 'align') {
        active.align = closing ? '' : ['left', 'center', 'right', 'justify'].includes(value) ? value : ''
      }
      index += bracketMatch[0].length
      continue
    }

    if (rest.startsWith('**')) {
      active.bold = !active.bold
      index += 2
      continue
    }
    if (rest.startsWith('__')) {
      active.bold = !active.bold
      index += 2
      continue
    }
    if (rest[0] === '*' && rest[1] !== '*') {
      active.italic = !active.italic
      index += 1
      continue
    }
    if (rest[0] === '_' && rest[1] !== '_') {
      active.italic = !active.italic
      index += 1
      continue
    }

    pushChar(raw[index], index)
    index += 1
  }

  return {
    text: chars.map((entry) => entry.char).join(''),
    chars,
  }
}

function handtypedMarkdownDisplayText(markdown = '') {
  return handtypedMarkdownDisplayModel(markdown).text
}

function reviewDraftStyleForMarks(marks = {}) {
  const styles = []
  const size = Number(marks.size)
  if (Number.isFinite(size) && size >= 10 && size <= 100) {
    styles.push(`font-size:${size}px`)
  }
  const fontFamilies = {
    arial: 'Arial, Helvetica, sans-serif',
    serif: 'Georgia, "Times New Roman", serif',
    sans: 'Inter, Arial, Helvetica, sans-serif',
    mono: '"Courier New", monospace',
    georgia: 'Georgia, serif',
    times: '"Times New Roman", serif',
    garamond: 'Garamond, Georgia, serif',
    palatino: 'Palatino, "Palatino Linotype", serif',
    baskerville: 'Baskerville, Georgia, serif',
    verdana: 'Verdana, Geneva, sans-serif',
    trebuchet: '"Trebuchet MS", Arial, sans-serif',
    tahoma: 'Tahoma, Geneva, sans-serif',
    helvetica: 'Helvetica, Arial, sans-serif',
    courier: '"Courier New", Courier, monospace',
    'comic-sans': '"Comic Sans MS", "Comic Sans", cursive',
    lucida: '"Lucida Sans", "Lucida Grande", sans-serif',
  }
  if (fontFamilies[marks.font]) {
    styles.push(`font-family:${fontFamilies[marks.font]}`)
  }
  return styles.join(';')
}

function renderWysiwygContent(content, marks = {}) {
  if (marks.pageBreak) {
    return '<span class="review-draft-page-break" role="separator" aria-label="Page break"></span>'
  }
  let html = escapeHtml(content)
  if (marks.underline) {
    html = `<u>${html}</u>`
  }
  if (marks.italic) {
    html = `<em>${html}</em>`
  }
  if (marks.bold || marks.heading) {
    html = `<strong>${html}</strong>`
  }
  const classes = []
  if (marks.highlight) classes.push('review-draft-highlight-mark')
  if (marks.heading) classes.push(`review-draft-heading-${marks.heading}`)
  const style = reviewDraftStyleForMarks(marks)
  if (classes.length || style) {
    html = `<span${classes.length ? ` class="${classes.join(' ')}"` : ''}${style ? ` style="${escapeHtml(style)}"` : ''}>${html}</span>`
  }
  return html
}

function renderIndexedSegments(model, start, end, annotation, highlightIndexes, selectionIndexes) {
  let html = ''
  let cursor = start
  const text = model.text || ''
  const chars = model.chars || []

  while (cursor < end) {
    const highlighted = highlightIndexes.has(cursor)
    const selected = selectionIndexes.has(cursor)
    const markKey = markdownStyleKey(chars[cursor]?.marks || {})
    let next = cursor + 1
    while (
      next < end &&
      highlightIndexes.has(next) === highlighted &&
      selectionIndexes.has(next) === selected &&
      markdownStyleKey(chars[next]?.marks || {}) === markKey
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

    const content = renderWysiwygContent(String(text || '').slice(cursor, next), chars[cursor]?.marks || {})
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

function reviewDraftLineAlign(model, start, end) {
  const chars = model.chars || []
  for (let index = start; index < end; index += 1) {
    const char = chars[index]?.char
    if (char && char !== '\n') {
      return chars[index]?.marks?.align || 'left'
    }
  }
  return chars[start]?.marks?.align || 'left'
}

function renderIndexedLines(model, annotations, highlightIndexes, selectionIndexes) {
  const text = model.text || ''
  const chars = model.chars || []
  const displayAnnotations = annotations
    .map((annotation) => annotationDisplayState(annotation, text))
    .sort((a, b) => a.start - b.start || a.end - b.end)
  const renderRange = (start, end) => {
    let cursor = start
    const parts = []
    for (const annotation of displayAnnotations) {
      const annotationStart = Math.max(start, Math.min(annotation.start, end))
      const annotationEnd = Math.max(annotationStart, Math.min(annotation.end, end))
      if (annotationEnd <= start || annotationStart >= end) {
        continue
      }
      if (annotationStart === annotationEnd) {
        if (annotationStart > cursor) {
          parts.push(renderIndexedSegments(model, cursor, annotationStart, null, highlightIndexes, selectionIndexes))
        }
        parts.push(
          `<span class="review-annotation-anchor-marker" data-annotation-id="${escapeHtml(annotation.id)}" aria-hidden="true"></span>`,
        )
        cursor = annotationStart
        continue
      }
      if (annotationStart > cursor) {
        parts.push(renderIndexedSegments(model, cursor, annotationStart, null, highlightIndexes, selectionIndexes))
      }
      parts.push(renderIndexedSegments(model, annotationStart, annotationEnd, annotation, highlightIndexes, selectionIndexes))
      cursor = annotationEnd
    }
    if (cursor < end) {
      parts.push(renderIndexedSegments(model, cursor, end, null, highlightIndexes, selectionIndexes))
    }
    return parts.join('')
  }

  let html = ''
  let lineStart = 0
  for (let index = 0; index <= text.length; index += 1) {
    if (index < text.length && text[index] !== '\n') {
      continue
    }
    if (index < text.length && chars[index]?.marks?.pageBreak) {
      if (lineStart < index) {
        const align = reviewDraftLineAlign(model, lineStart, index)
        html += `<div class="review-draft-line review-draft-align-${align}">${renderRange(lineStart, index)}</div>\n`
      }
      html += renderWysiwygContent('\n', chars[index]?.marks || {})
      lineStart = index + 1
      continue
    }
    const align = reviewDraftLineAlign(model, lineStart, index)
    const content = lineStart < index ? renderRange(lineStart, index) : '<br>'
    html += `<div class="review-draft-line review-draft-align-${align}">${content}</div>`
    if (index < text.length) {
      html += renderIndexedSegments(model, index, index + 1, null, highlightIndexes, selectionIndexes)
    }
    lineStart = index + 1
  }
  return html
}

function renderReviewHighlightUi(session, assignment) {
  if (!reviewState || !elements.reviewHighlightMeta) {
    return
  }

  if (elements.reviewHighlightDate) {
    syncReviewHighlightInputValue(elements.reviewHighlightDate, reviewState.highlightDate)
  }
  if (elements.reviewHighlightDates) {
    syncReviewHighlightInputValue(elements.reviewHighlightDates, reviewState.highlightDates)
  }
  syncReviewHighlightTimeInput(elements.reviewHighlightStartTime, reviewState.highlightStartTime)
  syncReviewHighlightTimeInput(elements.reviewHighlightEndTime, reviewState.highlightEndTime)
  const selectedWeekdays = new Set(reviewState.highlightWeekdays || [])
  elements.reviewHighlightWeekdays?.forEach((checkbox) => {
    checkbox.checked = selectedWeekdays.has(checkbox.value)
  })

  const noReplay = reviewState.replayLoadState === 'missing' && !reviewState.replayError
  const loading = reviewState.replayLoadState === 'loading'
  const ready = reviewState.replayLoadState === 'ready'
  const disablePresets = loading
  ;[
    elements.reviewHighlightDate,
    elements.reviewHighlightDates,
    elements.reviewHighlightStartTime,
    elements.reviewHighlightEndTime,
    elements.reviewHighlightPresetWindow,
    elements.reviewHighlightPresetAfterSchool,
    elements.reviewHighlightPresetEvening,
    elements.reviewHighlightPresetWeekdays,
    elements.reviewHighlightAll,
    ...elements.reviewHighlightWeekdays,
  ].forEach((control) => {
    if (control) {
      control.disabled = disablePresets
    }
  })
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
  const highlights = reviewHighlightIndexSet(handtypedMarkdownDisplayText(displayText), ranges, displayText)
  if (reviewHighlightModeActive() && !highlights.size) {
    elements.reviewHighlightMeta.textContent = reviewHighlightRequiresPreciseTiming() &&
      !attributedDocumentHasReliableInsertionTiming(reviewState.replayData?.attributedDocument)
      ? 'No confidently timed surviving characters matched that time filter.'
      : 'No surviving characters matched that time filter.'
    return
  }
  if (reviewHighlightModeActive()) {
    const filter = reviewHighlightFilterForState()
    const dateLabel = filter.hasDateFilter ? 'selected dates/days' : 'any day'
    const timeLabel = filter.hasTimeFilter ? 'selected time range' : 'any time'
    elements.reviewHighlightMeta.textContent = `${highlights.size} surviving character${highlights.size === 1 ? '' : 's'} highlighted from ${dateLabel}, ${timeLabel}.`
    return
  }
  elements.reviewHighlightMeta.textContent = 'Pick dates, weekdays, or a time range to highlight surviving text added then.'
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
      cached = buildReviewReplayCacheEntry(mergeReviewReplayWithLiveSession(replay, currentReviewSession() || session))
      reviewReplayCache.set(session.id, cached)
    } else {
      const mergedReplay = mergeReviewReplayWithLiveSession(cached.replay, currentReviewSession() || session)
      if (mergedReplay !== cached.replay) {
        cached = buildReviewReplayCacheEntryFromPrevious(mergedReplay, cached)
        reviewReplayCache.set(session.id, cached)
      }
    }

    if (!reviewState || reviewState.sessionId !== session.id) {
      return
    }
    reviewState.replayData = cached
    reviewState.replayLoadState = 'ready'
    if (!reviewState.highlightDate) {
      reviewState.highlightDate = replayTeacherDateInputValue(
        cached.attributedDocument.firstInsertedAtMs || cached.attributedDocument.lastInsertedAtMs,
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
    const nextAssignmentSessions = mergeAssignmentLiveSummaries(preserveSelectedReviewSessionInSummaries(payload.live_sessions))
    const selectedSession =
      selectedReviewSessionId
        ? nextAssignmentSessions.find((session) => session.id === selectedReviewSessionId) || null
        : null
    dashboardState = {
      ...dashboardState,
      live_sessions: mergeLiveSessions(
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
    const updatedSelectedSession =
      selectedReviewSessionId && reviewWorkspaceOpen
        ? currentReviewSession()
        : selectedSession
    if (updatedSelectedSession && reviewWorkspaceOpen) {
      selectedReviewSessionSnapshot = { ...updatedSelectedSession }
      if (reviewState?.sessionId === updatedSelectedSession.id || reviewState?.sessionId === selectedReviewSessionId) {
        scheduleReviewWorkspaceLiveContent(getSelectedAssignment())
      }
    }
    renderStudentCards({ skipReviewWorkspace: preserveReviewInputs })
  }
}

function handleRealtimeAccessRequest(payload) {
  if (!payload?.assignment) return
  upsertAssignmentInState(payload.assignment)
  if (currentView === 'assignment' && selectedAssignmentId === payload.assignment.id) {
    renderStudentCards({ skipReviewWorkspace: Boolean(activeReviewEditorElement()) })
    return
  }
  renderView()
}

function handleRealtimeReplay(payload) {
  if (!payload?.id) return
  const cached = reviewReplayCache.get(payload.id)
  const mergedReplay = mergeReviewReplayWithLiveSession(payload, currentReviewSession())
  const nextCache = buildReviewReplayCacheEntryFromPrevious(mergedReplay, cached)
  reviewReplayCache.set(payload.id, nextCache)
  mergeReplayIntoSessionState(payload.id, mergedReplay)
  if (!reviewState || reviewState.sessionId !== payload.id) {
    return
  }
  reviewState.replayData = nextCache
  reviewState.replayLoadState = 'ready'
  scheduleReviewWorkspaceLiveContent(getSelectedAssignment())
}

function syncRealtimeSubscriptions() {
  const nextTeacherKey = dashboardState ? dashboardChannel() : ''
  if (nextTeacherKey !== teacherRealtimeKey) {
    closeRealtimeConnection(teacherRealtime)
    teacherRealtimeKey = nextTeacherKey
    teacherRealtime = nextTeacherKey
	      ? openRealtimeConnection([nextTeacherKey], {
	          dashboard: handleRealtimeDashboard,
	          accessRequest: handleRealtimeAccessRequest,
	          error: () => {
	            retryRealtimeConnection('teacher', () => refreshDashboard().catch(() => {}))
	          },
	        }, 'teacher')
	      : null
  }

  const nextAssignmentKey = currentView === 'assignment' && selectedAssignmentId ? assignmentChannel() : ''
  if (nextAssignmentKey !== assignmentRealtimeKey) {
    closeRealtimeConnection(assignmentRealtime)
    assignmentRealtimeKey = nextAssignmentKey
    assignmentRealtime = nextAssignmentKey
	      ? openRealtimeConnection([nextAssignmentKey], {
	          assignment: handleRealtimeAssignment,
	          accessRequest: handleRealtimeAccessRequest,
	          error: () => {
	            retryRealtimeConnection('assignment', () => refreshAssignmentViewData().catch(() => {}))
	          },
	        }, 'assignment')
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
	            retryRealtimeConnection('replay', () => refreshSelectedReviewReplayData().catch(() => {}))
	          },
	        }, 'replay')
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

  const mergedReplay = mergeReviewReplayWithLiveSession(applyLiveReplayUpdates(cached.replay, updates), currentReviewSession())
  const nextCache = buildReviewReplayCacheEntryFromPrevious(mergedReplay, cached)
  reviewReplayCache.set(session.id, nextCache)
  mergeReplayIntoSessionState(session.id, mergedReplay)

  if (!reviewState || reviewState.sessionId !== session.id) {
    return
  }

  reviewState.replayData = nextCache
  reviewState.replayLoadState = 'ready'
  scheduleReviewWorkspaceLiveContent(getSelectedAssignment())
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
    live_sessions: mergeLiveSessions(getLiveSessions(), [selectedSession]),
  }
  syncSelectedReviewSessionSnapshot(currentReviewSession() || selectedSession)

  if (reviewState?.sessionId === selectedSession.id) {
    syncReviewReplayDataWithLiveSession(selectedSession)
    scheduleReviewWorkspaceLiveContent(getSelectedAssignment())
  } else {
    renderStudentCards({ skipReviewWorkspace: true })
  }
}

function cancelScheduledReviewWorkspaceLiveContent() {
  if (reviewLiveContentRenderRaf) {
    const cancelFrame = typeof cancelAnimationFrame === 'function'
      ? cancelAnimationFrame
      : window.cancelAnimationFrame
    if (typeof cancelFrame === 'function') {
      cancelFrame(reviewLiveContentRenderRaf)
    } else {
      clearTimeout(reviewLiveContentRenderRaf)
    }
    reviewLiveContentRenderRaf = 0
  }
}

function requestReviewWorkspaceFrame(callback) {
  const requestFrame = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : window.requestAnimationFrame
  if (typeof requestFrame === 'function') {
    return requestFrame(callback)
  }
  return window.setTimeout(callback, 0)
}

function scheduleReviewWorkspaceLiveContent(selectedAssignment = getSelectedAssignment()) {
  if (!reviewWorkspaceOpen || !reviewState) {
    return
  }
  if (reviewLiveContentRenderRaf) {
    return
  }
  reviewLiveContentRenderRaf = requestReviewWorkspaceFrame(() => {
    reviewLiveContentRenderRaf = 0
    renderReviewWorkspaceLiveContent(selectedAssignment)
  })
}

function reviewAnnotationVersion(annotations = []) {
  return visibleReviewAnnotations(annotations)
    .map((annotation) => [
      annotation.id,
      annotation.start,
      annotation.end,
      annotation.quote,
      annotation.note,
      annotation.updated_at,
      annotation.resolved_by_student,
    ].map((part) => String(part ?? '')).join(':'))
    .join('|')
}

function reviewHighlightVersion(session = currentReviewSession(), assignment = getSelectedAssignment()) {
  return [
    reviewState?.highlightDate || '',
    reviewState?.highlightDates || '',
    reviewState?.highlightStartTime || '',
    reviewState?.highlightEndTime || '',
    reviewState?.highlightWeekdays ? JSON.stringify(reviewState.highlightWeekdays) : '',
    (reviewHighlightRangesForState(session, assignment) || [])
      .map((range) => `${range.start}:${range.end}`)
      .join('|'),
  ].join('\u001f')
}

function renderDraftSurface(text, annotations) {
  const model = handtypedMarkdownDisplayModel(text)
  const safeText = model.text
  const mode = reviewDraftRenderMode(safeText)
  const nextSignature = reviewDraftRenderSignature({
    text: safeText,
    annotationVersion: reviewAnnotationVersion(annotations),
    highlightVersion: reviewHighlightVersion(),
    mode,
  })
  if (reviewDraftSurfaceSignature === nextSignature) {
    return
  }
  reviewDraftSurfaceSignature = nextSignature

  if (!safeText) {
    const emptyHtml = '<span class="student-meta">(empty draft)</span>'
    if (reviewDraftSurfaceHtml !== emptyHtml) {
      elements.reviewDraftSurface.innerHTML = emptyHtml
      reviewDraftSurfaceHtml = emptyHtml
    }
    return
  }
  if (mode === 'plain') {
    const plainHtml = `<pre class="review-draft-large-doc">${escapeHtml(safeText)}</pre>`
    if (reviewDraftSurfaceHtml !== plainHtml) {
      elements.reviewDraftSurface.innerHTML = plainHtml
      reviewDraftSurfaceHtml = plainHtml
    }
    return
  }

  const highlightIndexes = reviewHighlightIndexSet(safeText, reviewHighlightRangesForState(currentReviewSession(), getSelectedAssignment()), text)
  const pendingSelection = normalizedPendingReviewSelection(safeText, reviewState?.selection)
  const selectionIndexes = new Set()
  if (pendingSelection) {
    for (let index = pendingSelection.start; index < pendingSelection.end; index += 1) {
      selectionIndexes.add(index)
    }
  }
  const nextHtml = renderIndexedLines(model, annotations, highlightIndexes, selectionIndexes)
  if (reviewDraftSurfaceHtml !== nextHtml) {
    elements.reviewDraftSurface.innerHTML = nextHtml
    reviewDraftSurfaceHtml = nextHtml
  }
}

function renderReviewAnnotationList(session) {
  if (!reviewState) return
  const text = handtypedMarkdownDisplayText(session?.current_text || '')
  const annotations = visibleReviewAnnotations(reviewState.inlineAnnotations)
    .map((annotation) => annotationDisplayState(annotation, text))
    .sort((a, b) => a.start - b.start || a.end - b.end)

  elements.reviewAnnotationMeta.textContent = annotations.length
    ? `${annotations.length} inline ${annotations.length === 1 ? 'note' : 'notes'}`
    : 'No inline notes yet.'

  if (!annotations.length) {
    elements.reviewAnnotationList.innerHTML =
      '<div class="review-annotation-empty">Select text to anchor feedback directly in the draft.</div>'
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
    button.addEventListener('click', () => {
      deleteReviewAnnotation(button.dataset.deleteAnnotation || '').catch(() => {})
    })
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
  )}${sessionPlatformVersionLabel(session) ? ` • ${sessionPlatformVersionLabel(session)}` : ''}${
    reviewState?.updatedBy ? ` • last teacher save by ${reviewState.updatedBy}` : ''
  }`
}

function formatSessionPlatform(platform) {
  const normalized = String(platform || '')
    .trim()
    .toLowerCase()
  if (normalized === 'windows') {
    return 'Windows'
  }
  if (normalized === 'macos' || normalized === 'mac') {
    return 'Mac'
  }
  return ''
}

function sessionPlatformVersionLabel(session = {}) {
  const platform = formatSessionPlatform(session?.client_platform)
  const version = typeof session?.app_version === 'string' ? session.app_version.trim() : ''
  if (platform && version) {
    return `${platform} • v${version}`
  }
  if (platform) {
    return platform
  }
  if (version) {
    return `v${version}`
  }
  return ''
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

function reviewWordCount(text = '') {
  const normalized = String(text || '').trim()
  if (!normalized) return 0
  return normalized.split(/\s+/).filter(Boolean).length
}

function reviewDraftMetaText(reviewDisplayText, rejoinHistory = '') {
  const text = String(reviewDisplayText || '')
  const historySuffix = rejoinHistory ? ` ${rejoinHistory}.` : ''
  if (!text) {
    return `The student draft is still empty.${historySuffix}`
  }
  const words = reviewWordCount(text)
  const wordLabel = words === 1 ? 'word' : 'words'
  const charLabel = text.length === 1 ? 'character' : 'characters'
  return `Live draft is ${words} ${wordLabel} / ${text.length} ${charLabel}. Select text to anchor comments.${historySuffix}`
}

function renderReviewWorkspaceMeta(selectedAssignment = getSelectedAssignment(), session = currentReviewSession()) {
  if (!elements.reviewWorkspaceMeta || !reviewWorkspaceOpen || !selectedAssignment || !session) {
    return
  }
  elements.reviewWorkspaceMeta.textContent = reviewWorkspaceMetaText(selectedAssignment, session)
  renderReviewActivityStatus(session)
}

function renderReviewFocusLosses(session) {
  if (!elements.reviewFocusLosses) {
    return
  }
  const summary = focusLossSummary(session)
  elements.reviewFocusLosses.hidden = !summary
  elements.reviewFocusLosses.innerHTML = summary
    ? `
        <div class="section-label">Focus losses</div>
        <div class="student-meta">${escapeHtml(summary)}</div>
      `
    : ''
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
  syncReviewResolvedAnnotationsFromSession(session)
  syncReviewReplayDataWithLiveSession(session)
  elements.reviewWorkspaceTitle.textContent = session.student_name
  renderReviewWorkspaceMeta(selectedAssignment, session)
  renderReviewNavigationControls(session)
  renderReviewEditActivity(session)
  renderReviewFocusLosses(session)
  const reviewText = displaySessionText(session, reviewState.replayData)
  const reviewDisplayText = handtypedMarkdownDisplayText(reviewText)
  const rejoinHistory = studentRejoinHistorySummary(selectedAssignment, session.student_name)
  elements.reviewDraftMeta.textContent = reviewDraftMetaText(reviewDisplayText, rejoinHistory)
  renderReviewHighlightUi(session, selectedAssignment)
  renderDraftSurface(reviewText, visibleReviewAnnotations(reviewState.inlineAnnotations))
  elements.reviewDraftSurface.querySelectorAll('[data-annotation-id]').forEach((node) => {
    node.addEventListener('click', () => {
      selectedAnnotationId = node.dataset.annotationId || null
      renderReviewWorkspace(selectedAssignment)
    })
  })
  renderReviewAnnotationList({
    ...session,
    current_text: reviewDisplayText,
  })
  renderReviewSelectionUi()
  renderReviewSyncStatus()
}

function renderReviewWorkspace(selectedAssignment) {
  if (!elements.reviewWorkspace) return
  cancelScheduledReviewWorkspaceLiveContent()
  elements.reviewLayout?.classList.toggle('is-review-open', reviewWorkspaceOpen)
  elements.assignmentView?.classList.toggle('is-review-open', reviewWorkspaceOpen)
  elements.reviewWorkspace.hidden = !reviewWorkspaceOpen
  if (!reviewWorkspaceOpen) {
    reviewDraftSurfaceHtml = ''
    reviewDraftSurfaceSignature = ''
    renderReviewEditActivity(null)
    renderReviewFocusLosses(null)
    renderReviewActivityStatus(null)
    renderReviewNavigationControls(null)
    return
  }
  const session = currentReviewSession()
  if (!session || !selectedAssignment) {
    reviewState = null
    selectedAnnotationId = null
    reviewDraftSurfaceHtml = ''
    reviewDraftSurfaceSignature = ''
    elements.reviewWorkspaceEmpty.hidden = false
    elements.reviewWorkspaceContent.hidden = true
    renderReviewEditActivity(null)
    renderReviewFocusLosses(null)
    renderReviewActivityStatus(null)
    renderReviewNavigationControls(null)
    renderReviewSyncStatus()
    return
  }
  syncSelectedReviewSessionSnapshot(session)

  if (!reviewState || reviewState.sessionId !== session.id) {
    reviewState = createReviewStateFromSession(session)
    selectedAnnotationId = null
  }
  syncReviewResolvedAnnotationsFromSession(session)

  elements.reviewWorkspaceEmpty.hidden = true
  elements.reviewWorkspaceContent.hidden = false
  elements.reviewWorkspaceTitle.textContent = session.student_name
  renderReviewWorkspaceMeta(selectedAssignment, session)
  renderReviewNavigationControls(session)
  renderReviewEditActivity(session)
  renderReviewFocusLosses(session)
  if (reviewState.feedbackControlsClearedAfterPublish) {
    clearReviewFeedbackInputsAfterPublish()
  } else {
    elements.reviewGradeLabel.value = reviewState.gradeLabel
    elements.reviewGradeScore.value = reviewState.gradeScore
    elements.reviewTeacherComment.value = reviewState.teacherComment
    elements.reviewReturned.checked = reviewState.returnedForRevision
  }
  renderReviewPublishButton()
  const reviewText = displaySessionText(session, reviewState.replayData)
  const reviewDisplayText = handtypedMarkdownDisplayText(reviewText)
  const rejoinHistory = studentRejoinHistorySummary(selectedAssignment, session.student_name)
  elements.reviewDraftMeta.textContent = reviewDraftMetaText(reviewDisplayText, rejoinHistory)
  renderReviewHighlightUi(session, selectedAssignment)
  renderReviewRubric(selectedAssignment)
  if (reviewState.feedbackControlsClearedAfterPublish) {
    clearReviewFeedbackInputsAfterPublish()
  }
  renderReviewPublishConfirmation()
  renderDraftSurface(reviewText, visibleReviewAnnotations(reviewState.inlineAnnotations))
  elements.reviewDraftSurface.querySelectorAll('[data-annotation-id]').forEach((node) => {
    node.addEventListener('click', () => {
      selectedAnnotationId = node.dataset.annotationId || null
      renderReviewWorkspace(selectedAssignment)
    })
  })
  renderReviewAnnotationList({
    ...session,
    current_text: reviewDisplayText,
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
  const nextSelection = readReviewDraftSelection()
  const selectionChanged =
    nextSelection &&
    (!reviewState.selection ||
      reviewState.selection.start !== nextSelection.start ||
      reviewState.selection.end !== nextSelection.end ||
      reviewState.selection.text !== nextSelection.text)
  reviewState.selection = nextSelection
  reviewState.composerMode = nextSelection ? 'comment' : ''
  if (selectionChanged) {
    reviewState.composerNote = ''
    if (elements.reviewComposerNote) elements.reviewComposerNote.value = ''
  }
  renderReviewWorkspace(getSelectedAssignment())
  if (reviewState.selection) {
    elements.reviewComposerNote?.focus()
  }
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
    if (!document.hidden && shouldUseFallbackRefresh()) {
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
  const previousSave = saveReviewSnapshotBeforeSwitch()
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
  recordTeacherHistoryState()
  if (sameSession) {
    syncSelectedReviewSessionSnapshot()
  }
  previousSave.catch(() => {})
  await Promise.all([
    refreshSelectedReviewSessionData(),
    refreshAssignmentViewData(),
    refreshSelectedReviewReplayData(),
  ]).catch(() => {})
}

async function closeReviewWorkspace() {
  const pendingSave = saveReviewSnapshotBeforeSwitch()
  clearSelectedReviewSession()
  elements.reviewWorkspace?.setAttribute('hidden', '')
  scheduleDashboardRefresh()
  renderStudentCards()
  recordTeacherHistoryState()
  pendingSave.catch((error) => {
    window.alert(`Could not save review changes: ${error.message}`)
  })
}

function editActivityWindowMs() {
  return Math.max(1, Number(editActivityWindowMinutes) || 5) * 60_000
}

function editActivitySampleMs(windowMs) {
  if (windowMs <= 5 * 60_000) {
    return 2500
  }
  return 30000
}

function editActivitySampleLabel(sampleMs) {
  const seconds = Math.max(0.1, sampleMs / 1000)
  if (seconds < 60) {
    const label = Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1)
    return `${label} sec samples`
  }
  return `${Math.max(1, Math.round(seconds / 60))} min samples`
}

function editActivityWindowLabel() {
  const minutes = Math.max(1, Math.round(Number(editActivityWindowMinutes) || 5))
  if (minutes < 60) {
    return `Last ${minutes} min`
  }
  if (minutes === 60) {
    return 'Last hour'
  }
  const hours = minutes / 60
  return Number.isInteger(hours) ? `Last ${hours} hours` : `Last ${minutes} min`
}

function editActivityStartLabel() {
  return editActivityWindowMinutes === 60 ? '1 hour ago' : `${editActivityWindowMinutes} min ago`
}

function editActivityBarHtml(activity) {
  return activity.points.map((count, index) => {
    const label = count > 0 ? 'Edits happened' : 'No edits'
    const height = count > 0 ? '100%' : '3px'
    const emptyClass = count === 0 ? ' is-zero' : ''
    return `<span class="edit-activity-bar${emptyClass}" style="height:${height}" role="img" aria-label="Sample ${index + 1}: ${label}" title="${label}"></span>`
  }).join('')
}

function editActivityDensityClass(pointCount) {
  if (pointCount >= 240) {
    return ' is-dense'
  }
  return ''
}

function renderStudentEditActivity(session) {
  const windowMs = editActivityWindowMs()
  const sampleMs = editActivitySampleMs(windowMs)
  const activity = recentEditActivityCurve(session, { windowMs, sampleMs, nowMs: Date.now() })
  const editLabel = activity.totalEdits === 1 ? 'edit' : 'edits'
  const windowLabel = editActivityWindowLabel()

  return `
    <div class="edit-activity-block">
      <div class="section-label">Edit frequency</div>
      <div class="edit-activity-meta">${activity.totalEdits} ${editLabel} in ${windowLabel.toLowerCase()} • ${editActivitySampleLabel(sampleMs)} edit/no-edit windows</div>
      <div class="edit-activity-chart">
        <div class="edit-activity-graph${editActivityDensityClass(activity.points.length)}" style="grid-template-columns: repeat(${activity.points.length}, minmax(0, 1fr));" aria-label="${escapeHtml(session.student_name || 'Student')} edit frequency">
          ${editActivityBarHtml(activity)}
        </div>
        <div class="edit-activity-axis-x">
          <span>${editActivityStartLabel()}</span>
          <span>now</span>
        </div>
      </div>
    </div>
  `
}

function renderReviewEditActivity(session) {
  if (!elements.reviewEditActivity) {
    return
  }
  if (!reviewWorkspaceOpen || !session) {
    elements.reviewEditActivity.hidden = true
    elements.reviewEditActivity.innerHTML = ''
    return
  }
  elements.reviewEditActivity.hidden = false
  elements.reviewEditActivity.innerHTML = renderStudentEditActivity(session)
}

function refreshStudentEditActivityGraphs() {
  if (!elements.sessionGrid || currentView !== 'assignment' || !selectedAssignmentId) {
    return
  }
  const selectedClassroom = getSelectedClassroom()
  const selectedAssignment = getSelectedAssignment()
  if (!selectedClassroom || !selectedAssignment) {
    return
  }

  const sessionsById = new Map(
    sortSessionsForDisplay(sessionsForAssignment(getLiveSessions(), selectedClassroom.name, selectedAssignment.id))
      .map((session) => [session.id, session]),
  )

  elements.sessionGrid.querySelectorAll('.student-card[data-review-session]').forEach((card) => {
    const session = sessionsById.get(card.dataset.reviewSession)
    const activityBlock = card.querySelector('.edit-activity-block')
    if (session && activityBlock) {
      activityBlock.outerHTML = renderStudentEditActivity(session)
    }
  })
  if (reviewWorkspaceOpen && selectedReviewSessionId) {
    renderReviewEditActivity(currentReviewSession())
  }
}

function renderAssignmentEditActivity() {
  if (!elements.assignmentEditActivityPanel) {
    return
  }

  const selectedAssignment = getSelectedAssignment()
  elements.assignmentEditActivityPanel.hidden = !selectedAssignment
  if (!selectedAssignment) {
    return
  }

  if (elements.editActivitySummary) {
    elements.editActivitySummary.textContent = `Showing ${editActivityWindowLabel().toLowerCase()} on each student card.`
  }

  elements.editActivityWindowButtons?.forEach((button) => {
    const minutes = Number(button.dataset.editActivityWindow)
    button.classList.toggle('is-active', minutes === editActivityWindowMinutes)
    button.setAttribute('aria-pressed', minutes === editActivityWindowMinutes ? 'true' : 'false')
  })
}

function renderStudentCards({ skipReviewWorkspace = false } = {}) {
  const selectedClassroom = getSelectedClassroom()
  const selectedAssignment = getSelectedAssignment()
  syncAccessExtensionDefaults()
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
  renderAssignmentMonitoringStatus()

  renderAccessRequests(selectedAssignment, matchingSessions)
  renderFeedbackRequests(selectedAssignment, matchingSessions)
  if (!selectedClassroom || !selectedAssignment) {
    renderAssignmentEditActivity()
    elements.sessionGrid.innerHTML = `<div class="student-empty">Choose an assignment to see student work.</div>`
    if (!skipReviewWorkspace) {
      renderReviewWorkspace(selectedAssignment)
    }
    return
  }

  if (selectedReviewSessionId && !currentReviewSession()) {
    clearSelectedReviewSession()
  }

  const visibleSessions = sortSessionsForDisplay(matchingSessions)
  renderAssignmentEditActivity()

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
      const pendingFeedbackRequest = selectedAssignment?.student_feedback_requests?.[requestKey]
      const feedbackRequestBadge = pendingFeedbackRequest ? badge('Feedback requested', 'warn') : ''
      const specialAccessBadge = specialAccessBadgeFor(selectedAssignment, session.student_name, now)
      const rejoinHistory = studentRejoinHistorySummary(selectedAssignment, session.student_name)
      const focusSummary = focusLossSummary(session)
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
          data-special-access-active="${specialAccessBadge ? 'true' : 'false'}"
          role="button"
          tabindex="0"
          aria-label="Open ${escapeHtml(session.student_name)} draft review"
        >
          <div class="student-card-header">
            <div>
              <h2>${escapeHtml(session.student_name)}</h2>
              <div class="student-meta" data-student-last-activity>Last activity ${escapeHtml(timeAgoLabel(session.last_activity_at, now))}</div>
              ${
                sessionPlatformVersionLabel(session)
                  ? `<div class="student-meta">${escapeHtml(sessionPlatformVersionLabel(session))}</div>`
                  : ''
              }
              ${rejoinHistory ? `<div class="student-meta student-rejoin-history">${escapeHtml(rejoinHistory)}</div>` : ''}
            </div>
            <div class="student-badges"><span class="student-badge student-badge-${statusTone}" data-student-status-badge>${escapeHtml(statusLabel)}</span>${specialAccessBadge}${requestBadge}${feedbackRequestBadge}</div>
          </div>
          <div class="student-card-body">
            ${selectedSessionReviewSummary(session, selectedAssignment)}
            <div class="student-section">
              <div class="section-label">Status</div>
              <div class="student-meta" data-student-status-text>${escapeHtml(statusLabel)}</div>
            </div>
            <div class="student-section">
              <div class="section-label">Recent browser URLs</div>
              <ul class="student-urls">${summarizeUrls(session, selectedAssignment)}</ul>
            </div>
            ${
              focusSummary
                ? `
                  <div class="student-section">
                    <div class="section-label">Focus losses</div>
                    <div class="student-meta">${escapeHtml(focusSummary)}</div>
                  </div>
                `
                : ''
            }
            ${renderStudentEditActivity(session)}
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
      try {
        const existing = temporaryAccessUntilFor(getSelectedAssignment(), studentName)
        const target = await promptExtensionTarget({
          studentName,
          initialTarget: existing ? new Date(existing) : null,
        })
        if (!target) {
          return
        }
        await extendSelectedAssignmentForStudentUntil(studentName, target)
      } finally {
        clearPendingStudentAccessAction(studentName)
        renderStudentCards({ skipReviewWorkspace: true })
      }
    })
  })

  elements.sessionGrid.querySelectorAll('[data-review-session]').forEach((card) => {
    const openCardReview = async () => {
      try {
        await selectReviewSession(card.dataset.reviewSession)
      } catch (error) {
        window.alert(`Could not switch review sessions: ${error.message}`)
      }
    }
    card.addEventListener('click', async (event) => {
      if (event.target.closest('button, a')) return
      await openCardReview()
    })
    card.addEventListener('keydown', async (event) => {
      if (event.target.closest('button, a')) return
      if (event.key !== 'Enter' && event.key !== ' ') {
        return
      }
      event.preventDefault()
      await openCardReview()
    })
  })

  if (!skipReviewWorkspace) {
    renderReviewWorkspace(selectedAssignment)
  }
}

function refreshStudentCardLiveLabels() {
  if (!dashboardState || currentView !== 'assignment' || reviewWorkspaceOpen || !elements.sessionGrid) {
    return
  }
  const selectedClassroom = getSelectedClassroom()
  const selectedAssignment = getSelectedAssignment()
  if (!selectedClassroom || !selectedAssignment) {
    return
  }
  const now = Date.now()
  const sessionsById = new Map(
    sortSessionsForDisplay(
      sessionsForAssignment(getLiveSessions(), selectedClassroom.name, selectedAssignment.id),
    ).map((session) => [session.id, session]),
  )
  const viewMeta = document.getElementById('assignment-view-meta')
  if (viewMeta) {
    viewMeta.textContent = assignmentViewMeta(selectedAssignment, selectedClassroom, getLiveSessions())
  }

  let needsFullRender = false
  elements.sessionGrid.querySelectorAll('[data-review-session]').forEach((card) => {
    const session = sessionsById.get(card.dataset.reviewSession || '')
    if (!session) {
      needsFullRender = true
      return
    }
    const risk = deriveSessionRisk(session, now)
    const statusLabel = risk.active ? 'Active' : 'Offline'
    const statusTone = risk.active ? (session.focused ? 'good' : 'warn') : 'danger'
    const specialAccessActive = Boolean(specialAccessBadgeFor(selectedAssignment, session.student_name, now))
    if (card.dataset.specialAccessActive !== String(specialAccessActive)) {
      needsFullRender = true
      return
    }
    const activity = card.querySelector('[data-student-last-activity]')
    if (activity) {
      activity.textContent = `Last activity ${timeAgoLabel(session.last_activity_at, now)}`
    }
    const statusText = card.querySelector('[data-student-status-text]')
    if (statusText) {
      statusText.textContent = statusLabel
    }
    const statusBadge = card.querySelector('[data-student-status-badge]')
    if (statusBadge) {
      statusBadge.textContent = statusLabel
      statusBadge.className = `student-badge student-badge-${statusTone}`
    }
  })

  if (needsFullRender) {
    renderStudentCards({ skipReviewWorkspace: true })
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
  const defaultTarget = defaultAccessExtensionTarget()
  const defaultDate = localDateInputValue(defaultTarget)
  const defaultTime = nativeTimeInputValue(defaultTarget)
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
                  <div class="access-request-date-time">
                    <label class="access-request-time">
                      <span>End date</span>
                      <input type="date" value="${escapeHtml(defaultDate)}" data-access-request-date="${escapeHtml(entry.key)}" />
                    </label>
                    <label class="access-request-time">
                      <span>End time</span>
                      <input type="time" value="${escapeHtml(defaultTime)}" data-access-request-time="${escapeHtml(entry.key)}" />
                    </label>
                  </div>
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
      let approvalTarget = null
      try {
        if (!assignmentIsOpenNow(assignment)) {
          const dateInput = elements.accessRequestList.querySelector(`[data-access-request-date="${CSS.escape(requestKey)}"]`)
          const timeInput = elements.accessRequestList.querySelector(`[data-access-request-time="${CSS.escape(requestKey)}"]`)
          approvalTarget = selectedExtensionTarget(dateInput, timeInput)
        }
      } catch (error) {
        window.alert(`Could not approve access: ${error.message}`)
        return
      }
      pendingAccessRequestApprovals.add(requestKey)
      renderAccessRequests(assignment, matchingSessions)
      try {
        if (assignmentIsOpenNow(assignment)) {
          await approveAssignmentAccessRequest(assignment, entry)
          return
        }
        await approveAssignmentAccessRequest(assignment, entry, { target: approvalTarget })
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

function renderFeedbackRequests(assignment, matchingSessions = []) {
  if (!elements.feedbackRequestList) {
    return
  }
  const requests = feedbackRequestsForAssignment(assignment)
  if (!assignment || !requests.length) {
    elements.feedbackRequestList.innerHTML = ''
    elements.feedbackRequestList.closest('.feedback-request-panel')?.setAttribute('hidden', '')
    return
  }

  const sessionKeys = new Set((matchingSessions || []).map((session) => normalizeStudentOverrideKey(session.student_name)))
  elements.feedbackRequestList.closest('.feedback-request-panel')?.removeAttribute('hidden')
  elements.feedbackRequestList.innerHTML = requests
    .map((entry) => {
      const requestTime = entry.requested_at ? timeAgoLabel(entry.requested_at) : 'just now'
      const linkedToLiveSession = sessionKeys.has(entry.key)
      const dismissPending = pendingFeedbackRequestDismissals.has(entry.key)
      return `
        <article class="access-request-card">
          <div class="access-request-copy">
            <div class="access-request-title-row">
              <h3>${escapeHtml(entry.student_name)}</h3>
              <span class="student-badge student-badge-warn">Feedback requested</span>
            </div>
            <div class="student-meta">Requested ${escapeHtml(requestTime)}${linkedToLiveSession ? ' • visible in student list' : ''}</div>
            ${entry.note ? `<p class="access-request-note">${escapeHtml(entry.note)}</p>` : ''}
          </div>
          <div class="access-request-actions">
            <button class="button button-secondary small-button" type="button" data-dismiss-feedback-request="${escapeHtml(entry.key)}" ${dismissPending ? 'disabled' : ''}>
              ${dismissPending ? 'Dismissing…' : 'Dismiss'}
            </button>
          </div>
        </article>
      `
    })
    .join('')

  elements.feedbackRequestList.querySelectorAll('[data-dismiss-feedback-request]').forEach((button) => {
    button.addEventListener('click', async () => {
      const requestKey = button.dataset.dismissFeedbackRequest || ''
      const entry = requests.find((item) => item.key === requestKey)
      if (!assignment || !entry || pendingFeedbackRequestDismissals.has(requestKey)) {
        return
      }
      pendingFeedbackRequestDismissals.add(requestKey)
      renderFeedbackRequests(assignment, matchingSessions)
      try {
        await dismissFeedbackRequest(assignment, entry)
      } catch (error) {
        window.alert(`Could not dismiss feedback request: ${error.message}`)
      } finally {
        pendingFeedbackRequestDismissals.delete(requestKey)
        const nextAssignment = getSelectedAssignment()
        if (nextAssignment) {
          renderFeedbackRequests(nextAssignment, matchingSessions)
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
  markFallbackRefresh('assignment-view')

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
    const nextAssignmentSessions = mergeAssignmentLiveSummaries(preserveSelectedReviewSessionInSummaries(summariesPayload.live_sessions))
    dashboardState = {
      ...dashboardState,
      live_sessions: mergeLiveSessions(
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
        live_sessions: mergeLiveSessions(getLiveSessions(), [selectedSession]),
      }
      syncSelectedReviewSessionSnapshot(currentReviewSession() || selectedSession)
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
    live_sessions: mergeLiveSessions(dashboardState.live_sessions, delta.live_sessions),
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
      scheduleReviewWorkspaceLiveContent(getSelectedAssignment())
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
  if (elements.quickExtendDate) {
    elements.quickExtendDate.disabled = !getSelectedAssignment()
  }
  if (elements.quickExtendTime) {
    elements.quickExtendTime.disabled = !getSelectedAssignment()
  }
  if (getSelectedAssignment()) {
    syncAccessExtensionDefaults()
  }
  if (elements.deleteAssignmentButton) {
    elements.deleteAssignmentButton.disabled = !getSelectedAssignment()
  }
  if (elements.editAssignmentButton) {
    elements.editAssignmentButton.disabled = !selectedAssignmentId
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
  recordTeacherHistoryState()
}

function showClassesView() {
  currentView = 'classes'
  selectedAssignmentId = null
  resetAssignmentViewRefreshState()
  renderView()
  recordTeacherHistoryState()
}

function showAssignmentsView() {
  currentView = getSelectedClassroom() ? 'assignments' : 'classes'
  resetAssignmentViewRefreshState()
  renderView()
  recordTeacherHistoryState()
}

async function refreshDashboard() {
  if (refreshInFlight) {
    refreshQueued = true
    return
  }
  refreshInFlight = true
  try {
    if (!dashboardState) {
      markFallbackRefresh('dashboard-full')
      renderDashboard(await request('/api/edu/dashboard'))
      return
    }
    if (currentView === 'assignment' && selectedAssignmentId) {
      await refreshAssignmentViewData()
      return
    }
    markFallbackRefresh('dashboard-delta')
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
	      if (!document.hidden) {
	        renderRealtimeDebug()
	      }
      if (!document.hidden && dashboardState && !reviewWorkspaceOpen && !activeReviewEditorElement()) {
        refreshStudentCardLiveLabels()
      }
      if (!document.hidden && dashboardState && currentView === 'assignment' && selectedAssignmentId) {
        refreshStudentEditActivityGraphs()
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
  if (!element) {
    return
  }
  element.innerHTML = items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')
  element.hidden = !items.length
}

function hideAssignmentFormToast() {
  if (assignmentFormToastTimer) {
    window.clearTimeout(assignmentFormToastTimer)
    assignmentFormToastTimer = null
  }
  if (!elements.assignmentFormToast) {
    return
  }
  elements.assignmentFormToast.hidden = true
  elements.assignmentFormToast.textContent = ''
  delete elements.assignmentFormToast.dataset.tone
}

function showAssignmentFormToast(message, tone = 'error') {
  if (!elements.assignmentFormToast || !message) {
    return
  }
  if (assignmentFormToastTimer) {
    window.clearTimeout(assignmentFormToastTimer)
  }
  elements.assignmentFormToast.dataset.tone = tone
  elements.assignmentFormToast.textContent = String(message)
  elements.assignmentFormToast.hidden = false
  assignmentFormToastTimer = window.setTimeout(() => {
    hideAssignmentFormToast()
  }, 3600)
}

function labelTextForField(field) {
  const label = field?.closest?.('label')
  const text = label?.querySelector?.('span')?.textContent || field?.getAttribute?.('aria-label') || field?.name || 'Field'
  return String(text).replace(/\s+/g, ' ').trim()
}

function parseDomainLines(value = '') {
  return String(value || '')
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function validateAssignmentDraft() {
  const form = new FormData(elements.assignmentForm)
  const errors = []
  const warnings = []
  const days = readWindowDays(form)
  const hasDay = Object.values(days).some(Boolean)
  const rawStartTime = form.get('window_start_time')
  const rawEndTime = form.get('window_end_time')
  const parsedStartTime = parseReviewNativeTimeInput(rawStartTime) ?? parseReviewTimeInput(rawStartTime)
  const parsedEndTime = parseReviewNativeTimeInput(rawEndTime) ?? parseReviewTimeInput(rawEndTime)
  const start = parseTimeParts(rawStartTime, 10, 0)
  const end = parseTimeParts(rawEndTime, 11, 0)
  const startMinutes = start.hour * 60 + start.minute
  const endMinutes = end.hour * 60 + end.minute
  const browserEnabled = form.get('browser_enabled') === 'on'
  const domains = parseDomainLines(form.get('browser_allowed_domains') || '')

  if (!hasDay) {
    errors.push('Select at least one day of the week.')
  }
  if (parsedStartTime == null) {
    errors.push('Choose a valid start time.')
  }
  if (parsedEndTime == null) {
    errors.push('Choose a valid end time.')
  }
  if (parsedStartTime != null && parsedEndTime != null && endMinutes <= startMinutes) {
    errors.push('End time must be after start time.')
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
  const { errors, warnings } = validateAssignmentDraft()
  renderValidationList(elements.assignmentFormErrors, errors)
  renderValidationList(elements.assignmentFormWarnings, warnings)
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

function setClassroomFormSubmitting(isSubmitting) {
  classroomFormSubmitting = Boolean(isSubmitting)
  if (elements.classroomFormSubmit) {
    elements.classroomFormSubmit.textContent = classroomFormSubmitting ? 'Creating...' : 'Create class'
    elements.classroomFormSubmit.disabled = classroomFormSubmitting
  }
  elements.classroomForm
    ?.querySelectorAll('input, button')
    .forEach((control) => {
      if (control === elements.classroomFormSubmit) {
        return
      }
      control.disabled = classroomFormSubmitting
    })
}

function initButtonPressFeedback() {
  const pressableSelector = [
    'button',
    'a.button',
    '[role="button"]',
    '.selection-card',
    '.student-card',
    '[data-review-session]',
  ].join(',')
  let activeButton = null
  const clearButton = () => {
    activeButton?.classList.remove('is-pressed')
    activeButton = null
  }
  const pressableFromEvent = (event) => {
    const target = event.target instanceof Element ? event.target.closest(pressableSelector) : null
    if (!(target instanceof HTMLElement)) return null
    if (target.matches('button:disabled, [aria-disabled="true"], .is-disabled')) return null
    return target
  }

  document.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    clearButton()
    activeButton = pressableFromEvent(event)
    activeButton?.classList.add('is-pressed')
  }, { passive: true })
  document.addEventListener('pointerup', clearButton, { passive: true })
  document.addEventListener('pointercancel', clearButton, { passive: true })
  document.addEventListener('pointerleave', clearButton, { passive: true })
  document.addEventListener('keydown', (event) => {
    if (event.key !== ' ' && event.key !== 'Enter') return
    pressableFromEvent(event)?.classList.add('is-pressed')
  })
  document.addEventListener('keyup', clearButton)
  window.addEventListener('blur', clearButton)
}

async function selectedAssignmentForEditing() {
  const assignment = getSelectedAssignment()
  if (assignment) {
    return assignment
  }
  if (!selectedAssignmentId) {
    return null
  }
  const fetched = await request(`/api/edu/assignments/${encodeURIComponent(selectedAssignmentId)}`)
  if (fetched?.id) {
    upsertAssignmentInState(fetched)
    return fetched
  }
  return null
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

  elements.editAssignmentButton?.addEventListener('click', async () => {
    elements.editAssignmentButton.disabled = true
    try {
      const assignment = await selectedAssignmentForEditing()
      if (!assignment) {
        window.alert('Select an assignment first.')
        return
      }
      populateAssignmentModalForEdit(assignment)
      openModal(elements.assignmentModal)
    } catch (error) {
      window.alert(`Could not load assignment: ${error.message}`)
    } finally {
      elements.editAssignmentButton.disabled = !selectedAssignmentId
    }
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
      const target = selectedExtensionTarget(elements.quickExtendDate, elements.quickExtendTime)
      await extendSelectedAssignmentUntil(target)
      if (elements.quickExtendStatus) {
        elements.quickExtendStatus.hidden = false
        elements.quickExtendStatus.textContent = `Extended until ${accessExtensionTargetLabel(target)}.`
      }
    } catch (error) {
      window.alert(`Could not extend access: ${error.message}`)
    } finally {
      elements.quickExtendButton.disabled = !getSelectedAssignment()
    }
  })

  elements.editActivityWindowButtons?.forEach((button) => {
    button.addEventListener('click', () => {
      const minutes = Number(button.dataset.editActivityWindow)
      if (!Number.isFinite(minutes) || minutes <= 0) {
        return
      }
      editActivityWindowMinutes = minutes
      renderStudentCards({ skipReviewWorkspace: true })
    })
  })

  elements.modalCloseButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const modalId = button.dataset.closeModal
      if (modalId === 'classroom-modal') closeModal(elements.classroomModal)
      if (modalId === 'assignment-modal') closeModal(elements.assignmentModal)
      if (modalId === 'student-extension-modal') closeModal(elements.studentExtensionModal)
      if (modalId === 'feedback-modal') closeModal(elements.feedbackModal)
    })
  })

  ;[elements.classroomModal, elements.assignmentModal, elements.studentExtensionModal, elements.feedbackModal].forEach((modal) => {
    if (!modal) return
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
    button.addEventListener('mousedown', (event) => {
      event.preventDefault()
    })
    button.addEventListener('click', () => {
      execStarterDocumentCommand(button.dataset.starterCommand)
    })
  })
  elements.starterDocumentEditor?.addEventListener('input', () => {
    syncStarterDocumentField()
    updateStarterDocumentToolbarState()
    updateAssignmentFormGuidance()
  })
  ;['focus', 'keyup', 'mouseup'].forEach((eventName) => {
    elements.starterDocumentEditor?.addEventListener(eventName, () => {
      updateStarterDocumentToolbarState()
    })
  })
  document.addEventListener('selectionchange', () => {
    updateStarterDocumentToolbarState()
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
  hideAssignmentFormToast()
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
  elements.assignmentForm.elements.namedItem('editor_font_family').value = 'times'
  elements.assignmentForm.elements.namedItem('editor_font_size').value = '12'
  elements.assignmentForm.elements.namedItem('editor_line_height').value = 'double'
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
  hideAssignmentFormToast()
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
    field('window_start_time').value = assignmentTimeInputValue(win.start_hour, win.start_minute)
    field('window_end_time').value = assignmentTimeInputValue(win.end_hour, win.end_minute)
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
    field('images_allowed').value = ''
    field('require_lockdown').checked = assignment.policy.require_lockdown ?? false
    field('require_permission_to_rejoin').checked = assignment.policy.require_permission_to_rejoin ?? false
    field('show_rubric_to_student').checked = assignment.policy.show_rubric_to_student ?? false
  }

  if (assignment.editor_policy) {
    setStarterDocumentMarkdown(assignment.starter_document || '')
    field('editor_font_family').value = assignment.editor_policy.font_family || 'times'
    field('editor_font_size').value = String(assignment.editor_policy.font_size ?? 12)
    field('editor_line_height').value = assignment.editor_policy.line_height || 'double'
    field('editor_font_locked').checked = assignment.editor_policy.font_locked ?? false
  } else {
    setStarterDocumentMarkdown(assignment.starter_document || '')
  }

  if (assignment.browser_policy) {
    field('browser_enabled').checked = assignment.browser_policy.browser_enabled ?? false
    field('browser_mode').value = assignment.browser_policy.mode === 'blacklist' ? 'blacklist' : 'whitelist'
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
    if (classroomFormSubmitting) {
      return
    }
    const formEl = event.currentTarget
    const form = new FormData(formEl)
    setClassroomFormSubmitting(true)
    try {
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
    } finally {
      setClassroomFormSubmitting(false)
    }
  })

  elements.assignmentForm.addEventListener('input', updateAssignmentFormGuidance)
  elements.assignmentForm.addEventListener('change', updateAssignmentFormGuidance)
  elements.assignmentForm.addEventListener('invalid', (event) => {
    const field = event.target
    if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement)) {
      return
    }
    showAssignmentFormToast(`${labelTextForField(field)}: ${field.validationMessage}`)
  }, true)
  elements.assignmentForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    const formEl = event.currentTarget
    if (assignmentFormSubmitting) {
      return
    }
    const validation = validateAssignmentDraft()
    if (validation.errors.length) {
      updateAssignmentFormGuidance()
      showAssignmentFormToast(validation.errors[0])
      return
    }

    try {
      hideAssignmentFormToast()
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
        showAssignmentFormToast('Choose a class first before creating an assignment.')
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
          images_allowed: false,
          require_lockdown: form.get('require_lockdown') === 'on',
          require_permission_to_rejoin: form.get('require_permission_to_rejoin') === 'on',
          require_fullscreen: form.get('require_lockdown') === 'on',
          show_rubric_to_student: form.get('show_rubric_to_student') === 'on',
        },
        editor_policy: {
          font_family: String(form.get('editor_font_family') || 'times'),
          font_size: Number(form.get('editor_font_size') || 12),
          line_height: String(form.get('editor_line_height') || 'double'),
          font_locked: form.get('editor_font_locked') === 'on',
        },
        browser_policy: {
          browser_enabled: form.get('browser_enabled') === 'on',
          mode: form.get('browser_mode') === 'blacklist' ? 'blacklist' : 'whitelist',
          home_url: '',
          allowed_domains: parseDomainLines(form.get('browser_allowed_domains') || ''),
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
      showAssignmentFormToast(`Could not save assignment: ${error.message}`)
    } finally {
      setAssignmentFormSubmitting(false, Boolean(elements.assignmentIdInput.value))
    }
  })
}

function wireReviewWorkspace() {
  elements.reviewGradeLabel?.addEventListener('input', () => {
    if (!ensureReviewStateForPublish()) return
    reviewState.gradeLabel = elements.reviewGradeLabel.value
    markReviewDirty()
    renderStudentCards({ skipReviewWorkspace: true })
  })

  elements.reviewGradeScore?.addEventListener('input', () => {
    if (!ensureReviewStateForPublish()) return
    reviewState.gradeScore = elements.reviewGradeScore.value
    markReviewDirty()
    renderStudentCards({ skipReviewWorkspace: true })
  })

  elements.reviewTeacherComment?.addEventListener('input', () => {
    if (!ensureReviewStateForPublish()) return
    reviewState.teacherComment = elements.reviewTeacherComment.value
    markReviewDirty()
  })

  elements.reviewReturned?.addEventListener('change', () => {
    if (!ensureReviewStateForPublish()) return
    reviewState.returnedForRevision = elements.reviewReturned.checked
    markReviewDirty()
    renderStudentCards({ skipReviewWorkspace: true })
  })

  elements.reviewPublishFeedback?.addEventListener('click', () => {
    publishCurrentReviewFeedback().catch(() => {})
  })

  elements.reviewDeleteFeedback?.addEventListener('click', () => {
    deleteCurrentReviewFeedback().catch(() => {})
  })

  elements.reviewHighlightDate?.addEventListener('input', () => {
    if (!reviewState) return
    reviewState.highlightDate = elements.reviewHighlightDate.value
    setReviewHighlightModeFromControls()
    renderReviewWorkspace(getSelectedAssignment())
  })

  elements.reviewHighlightDates?.addEventListener('input', () => {
    if (!reviewState) return
    reviewState.highlightDates = elements.reviewHighlightDates.value
    setReviewHighlightModeFromControls()
    renderReviewWorkspace(getSelectedAssignment())
  })

  elements.reviewHighlightStartTime?.addEventListener('input', () => {
    if (!reviewState) return
    reviewState.highlightStartTime = elements.reviewHighlightStartTime.value
    setReviewHighlightModeFromControls()
    renderReviewWorkspace(getSelectedAssignment())
  })

  elements.reviewHighlightEndTime?.addEventListener('input', () => {
    if (!reviewState) return
    reviewState.highlightEndTime = elements.reviewHighlightEndTime.value
    setReviewHighlightModeFromControls()
    renderReviewWorkspace(getSelectedAssignment())
  })

  elements.reviewHighlightWeekdays?.forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      if (!reviewState) return
      reviewState.highlightWeekdays = elements.reviewHighlightWeekdays
        .filter((item) => item.checked)
        .map((item) => item.value)
      setReviewHighlightModeFromControls()
      renderReviewWorkspace(getSelectedAssignment())
    })
  })

  elements.reviewHighlightPresetWindow?.addEventListener('click', () => {
    applyReviewHighlightPreset('window')
    renderReviewWorkspace(getSelectedAssignment())
  })

  elements.reviewHighlightPresetAfterSchool?.addEventListener('click', () => {
    applyReviewHighlightPreset('after-school')
    renderReviewWorkspace(getSelectedAssignment())
  })

  elements.reviewHighlightPresetEvening?.addEventListener('click', () => {
    applyReviewHighlightPreset('evening')
    renderReviewWorkspace(getSelectedAssignment())
  })

  elements.reviewHighlightPresetWeekdays?.addEventListener('click', () => {
    applyReviewHighlightPreset('weekdays')
    renderReviewWorkspace(getSelectedAssignment())
  })

  elements.reviewHighlightAll?.addEventListener('click', () => {
    applyReviewHighlightPreset('all')
    renderReviewWorkspace(getSelectedAssignment())
  })

  elements.reviewHighlightClear?.addEventListener('click', () => {
    if (!reviewState) return
    reviewState.highlightMode = 'none'
    reviewState.highlightDate = ''
    reviewState.highlightDates = ''
    reviewState.highlightStartTime = ''
    reviewState.highlightEndTime = ''
    reviewState.highlightWeekdays = []
    renderReviewWorkspace(getSelectedAssignment())
  })

  elements.reviewComposerNote?.addEventListener('input', () => {
    if (!reviewState) return
    reviewState.composerNote = elements.reviewComposerNote.value
  })

  elements.reviewDraftSurface?.addEventListener('mouseup', handleReviewDraftSelection)
  elements.reviewDraftSurface?.addEventListener('keyup', handleReviewDraftSelection)

  elements.reviewCancelAnnotation?.addEventListener('click', clearReviewComposer)
  elements.reviewAddAnnotation?.addEventListener('click', addReviewAnnotation)
  elements.reviewPreviousStudent?.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    selectAdjacentReviewSession(-1).catch((error) => {
      window.alert(`Could not open previous student: ${error.message}`)
    })
  })
  elements.reviewNextStudent?.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    selectAdjacentReviewSession(1).catch((error) => {
      window.alert(`Could not open next student: ${error.message}`)
    })
  })
  elements.reviewExportPdf?.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    exportCurrentReviewPdf()
  })
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
  initButtonPressFeedback()
  wireForms()
  wireReviewWorkspace()
  await refreshDashboard()
  initializeTeacherHistory()
  startDashboardRefresh()
}

loadApp().catch((error) => {
  document.body.innerHTML = `<div style="padding:32px;font-family:'Open Sans', Arial, Helvetica, sans-serif">Could not load Handtyped EDU: ${escapeHtml(error.message)}</div>`
})
