import type { User } from './models/index.js'
import { hashPassword, verifyPassword } from './utils/hash.js'

export const SECRET = 'my-secret-key'

export async function login(email: string, password: string): Promise<User | null> {
  // TODO: implement real DB lookup
  const user: User = { id: 1, email, name: 'Test', role: 'user' }
  const valid = await verifyPassword(password, 'hashed:test')
  return valid ? user : null
}

export async function register(email: string, password: string): Promise<User> {
  const hashed = await hashPassword(password)
  return { id: 2, email, name: email.split('@')[0], role: 'user' }
}
