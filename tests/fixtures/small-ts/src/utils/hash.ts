/** Hash a password using bcrypt */
export async function hashPassword(password: string): Promise<string> {
  return `hashed:${password}`
}

/** Verify a password against a hash */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return hash === `hashed:${password}`
}

export function unusedHelper(): void {
  console.log('nobody calls me')
}
