import { login, register } from './auth.js'
import type { User } from './models/index.js'

export async function handleLogin(email: string, password: string): Promise<void> {
  const user = await login(email, password)
  if (user) console.log('Logged in:', user.name)
  else console.log('Invalid credentials')
}

export async function handleRegister(email: string, password: string): Promise<void> {
  const user = await register(email, password)
  console.log('Registered:', user.name)
}
