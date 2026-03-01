import type { User } from '../models/user.js'

export interface ButtonProps {
  label: string
  onClick: () => void
}

// FIXME: hardcoded fallback URL
export async function fetchUser(id: number): Promise<User | null> {
  try {
    const resp = await fetch(`/users/${id}`)
    return resp.json()
  } catch (err) {
    console.error('Failed to fetch user:', err)
    return null
  }
}

export function Button({ label, onClick }: ButtonProps) {
  return { type: 'button', label, onClick }
}
