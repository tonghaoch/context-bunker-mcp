import { sep } from 'node:path'

// Normalize path separators to match the OS convention used by Node's `relative()`
// On Windows, DB stores paths with `\`, but user input may use `/`
export function normalizePath(p: string): string {
  return sep === '\\' ? p.replace(/\//g, '\\') : p.replace(/\\/g, '/')
}
