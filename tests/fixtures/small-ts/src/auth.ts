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

// Used ONLY as a default parameter value (Bug fix: should not be flagged as unused)
const DEFAULT_ROLE = 'user'

// Used ONLY in a shorthand property (Bug fix: should not be flagged as unused)
const defaultGreeting = 'Hello'

export async function login(email: string, password: string, role: string = DEFAULT_ROLE): Promise<User | null> {
  // TODO: implement real DB lookup
  const normalized = formatEmail(email)
  const user: User = { id: 1, email: normalized, name: 'Test', role }
  const valid = await verifyPassword(password, 'hashed:test')
  return valid ? user : null
}

export async function register(email: string, password: string): Promise<User> {
  const hashed = await hashPassword(password)
  return { id: 2, email, name: email.split('@')[0], role: 'user' }
}

export function getConfig() {
  // Shorthand property — defaultGreeting used as { defaultGreeting }
  return { defaultGreeting }
}
