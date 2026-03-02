import type { User } from './models/index.js'
import { hashPassword, verifyPassword } from './utils/hash.js'

export const SECRET = 'my-secret-key'

// Internal helpers — some used, some dead code
function formatEmail(email: string): string {
  return email.trim().toLowerCase()
}

function deadInternalHelper(): void {
  console.log('nobody calls this internal function')
}

const UNUSED_CONST = 42

export async function login(email: string, password: string): Promise<User | null> {
  // TODO: implement real DB lookup
  const normalized = formatEmail(email)
  const user: User = { id: 1, email: normalized, name: 'Test', role: 'user' }
  const valid = await verifyPassword(password, 'hashed:test')
  return valid ? user : null
}

export async function register(email: string, password: string): Promise<User> {
  const hashed = await hashPassword(password)
  return { id: 2, email, name: email.split('@')[0], role: 'user' }
}
