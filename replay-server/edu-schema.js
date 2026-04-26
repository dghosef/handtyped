function randomId(prefix) {
  if (globalThis.crypto?.randomUUID) {
    return `${prefix}_${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
  }

  const bytes = new Uint8Array(8)
  globalThis.crypto.getRandomValues(bytes)
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${prefix}_${hex}`
}

export function normalizeTeacherEmail(value) {
  return String(value || '').trim().toLowerCase()
}

export function nowIso() {
  return new Date().toISOString()
}

export function buildClassroom(input = {}) {
  const now = nowIso()
  return {
    id: input.id || randomId('classroom'),
    name: String(input.name || 'Untitled classroom'),
    join_code: String(input.join_code || 'JOINME').toUpperCase(),
    teacher_name: String(input.teacher_name || 'Teacher'),
    students: Array.isArray(input.students) ? input.students : [],
    created_at: input.created_at || now,
    updated_at: input.updated_at || now,
  }
}

export function buildTeacher(input = {}) {
  const now = nowIso()
  return {
    id: input.id || randomId('teacher'),
    name: String(input.name || 'Teacher'),
    email: normalizeTeacherEmail(input.email || 'teacher@edu.handtyped.app'),
    access_code: String(input.access_code || 'handtyped-edu'),
    created_at: input.created_at || now,
    updated_at: input.updated_at || now,
  }
}

export function buildAssignmentWindow(input = {}) {
  return {
    label: String(input.label || 'Writing window'),
    days: input.days || {
      monday: true,
      tuesday: true,
      wednesday: true,
      thursday: true,
      friday: true,
      saturday: false,
      sunday: false,
    },
    end_date: input.end_date ?? null,
    start_hour: Number(input.start_hour ?? 10),
    start_minute: Number(input.start_minute ?? 0),
    end_hour: Number(input.end_hour ?? 11),
    end_minute: Number(input.end_minute ?? 0),
  }
}

export function buildAssignment(input = {}) {
  const now = nowIso()
  return {
    id: input.id || randomId('assignment'),
    title: String(input.title || 'Untitled assignment'),
    course: String(input.course || 'English'),
    classroom_id: input.classroom_id ?? null,
    classroom_name: input.classroom_name ?? null,
    prompt: String(input.prompt || ''),
    instructions: String(input.instructions || ''),
    starter_document: String(input.starter_document || ''),
    windows: Array.isArray(input.windows)
      ? input.windows.map(buildAssignmentWindow)
      : [buildAssignmentWindow()],
    policy: {
      copy_paste_allowed: Boolean(input.policy?.copy_paste_allowed),
      require_lockdown: input.policy?.require_lockdown ?? false,
      require_fullscreen: input.policy?.require_fullscreen ?? false,
    },
    browser_policy: {
      browser_enabled: input.browser_policy?.browser_enabled ?? true,
      home_url: String(input.browser_policy?.home_url || 'https://www.gutenberg.org'),
      allowed_domains: Array.isArray(input.browser_policy?.allowed_domains)
        ? input.browser_policy.allowed_domains
        : ['gutenberg.org'],
      log_all_navigation: input.browser_policy?.log_all_navigation ?? true,
    },
    temporary_access_until: input.temporary_access_until ?? null,
    created_at: input.created_at || now,
    updated_at: input.updated_at || now,
  }
}

export function buildLiveSession(input = {}) {
  return {
    id: input.id || randomId('live'),
    assignment_id: String(input.assignment_id || ''),
    assignment_title: String(input.assignment_title || ''),
    course: String(input.course || ''),
    classroom: input.classroom ?? null,
    student_name: String(input.student_name || 'Student'),
    current_text: String(input.current_text || ''),
    document_history: Array.isArray(input.document_history) ? input.document_history : [],
    current_url: input.current_url ?? null,
    current_url_title: input.current_url_title ?? null,
    url_history: Array.isArray(input.url_history) ? input.url_history : [],
    violation_count: Number(input.violation_count ?? 0),
    violations: Array.isArray(input.violations) ? input.violations : [],
    last_activity_at: String(input.last_activity_at || nowIso()),
    schedule_open: input.schedule_open ?? true,
    focused: input.focused ?? true,
    hid_active: input.hid_active ?? true,
    replay_session_id: input.replay_session_id ?? null,
    updated_at: String(input.updated_at || nowIso()),
  }
}

export function buildEduReplay(input = {}) {
  return {
    id: input.id || randomId('edu_replay'),
    live_session_id: String(input.live_session_id || ''),
    assignment_id: String(input.assignment_id || ''),
    assignment_title: String(input.assignment_title || ''),
    course: String(input.course || ''),
    classroom: input.classroom ?? null,
    student_name: String(input.student_name || 'Student'),
    current_text: String(input.current_text || ''),
    document_history: Array.isArray(input.document_history) ? input.document_history : [],
    keystroke_log: String(input.keystroke_log || ''),
    focus_events: Array.isArray(input.focus_events) ? input.focus_events : [],
    current_url: input.current_url ?? null,
    current_url_title: input.current_url_title ?? null,
    url_history: Array.isArray(input.url_history) ? input.url_history : [],
    violation_count: Number(input.violation_count ?? 0),
    violations: Array.isArray(input.violations) ? input.violations : [],
    last_activity_at: String(input.last_activity_at || nowIso()),
    focused: input.focused ?? true,
    hid_active: input.hid_active ?? true,
    start_wall_ns: Number(input.start_wall_ns || 0),
    updated_at: String(input.updated_at || nowIso()),
  }
}

export function buildTeacherSessionRecord(input = {}) {
  const now = nowIso()
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString()
  return {
    id: input.id || randomId('teacher_session'),
    teacher_id: String(input.teacher_id || ''),
    teacher_name: String(input.teacher_name || 'Teacher'),
    teacher_email: normalizeTeacherEmail(input.teacher_email || ''),
    provider: String(input.provider || 'access-code'),
    created_at: input.created_at || now,
    expires_at: input.expires_at || expiresAt,
  }
}

export function buildTeacherAuthSession(input = {}) {
  return {
    authenticated: Boolean(input.authenticated),
    teacher_id: input.teacher_id ?? null,
    teacher_name: input.teacher_name ?? null,
    teacher_email: input.teacher_email ?? null,
    provider: input.provider || 'access-code',
  }
}
