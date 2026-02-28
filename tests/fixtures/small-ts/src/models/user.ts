export interface User {
  id: number
  email: string
  name: string
  role: 'admin' | 'user'
}

export interface Session {
  token: string
  userId: number
  expiresAt: Date
}
