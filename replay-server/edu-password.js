import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'crypto'

const PASSWORD_HASH_VERSION = 'handtyped-edu-password-v2'
const LEGACY_PASSWORD_HASH_VERSION = 'handtyped-edu-password-v1'
const PASSWORD_KEY_BYTES = 64

export function generateTeacherPasswordSalt() {
  return randomBytes(16).toString('hex')
}

export function hashTeacherPassword(password, salt) {
  return scryptSync(
    String(password || ''),
    `${PASSWORD_HASH_VERSION}:${String(salt || '')}`,
    PASSWORD_KEY_BYTES,
  ).toString('hex')
}

export function hashTeacherPasswordLegacy(password, salt) {
  return createHash('sha256')
    .update(`${LEGACY_PASSWORD_HASH_VERSION}:${String(salt || '')}:${String(password || '')}`)
    .digest('hex')
}

export function buildTeacherPasswordFields(input = {}) {
  if (input.password_hash && input.password_salt) {
    return {
      password_hash: String(input.password_hash),
      password_salt: String(input.password_salt),
    }
  }

  const rawPassword = input.password ?? input.access_code ?? 'handtyped-edu'
  const salt = generateTeacherPasswordSalt()
  return {
    password_hash: hashTeacherPassword(rawPassword, salt),
    password_salt: salt,
  }
}

export function verifyTeacherPassword(teacher, password) {
  if (teacher?.password_hash && teacher?.password_salt) {
    const storedHash = String(teacher.password_hash || '')
    const nextHash = storedHash.length === PASSWORD_KEY_BYTES * 2
      ? hashTeacherPassword(password, teacher.password_salt)
      : hashTeacherPasswordLegacy(password, teacher.password_salt)
    const storedBuffer = Buffer.from(storedHash, 'hex')
    const nextBuffer = Buffer.from(nextHash, 'hex')
    if (!storedBuffer.length || storedBuffer.length !== nextBuffer.length) {
      return false
    }
    return timingSafeEqual(storedBuffer, nextBuffer)
  }

  if (typeof teacher?.password === 'string') {
    return teacher.password === String(password || '')
  }

  return teacher?.access_code === String(password || '')
}
