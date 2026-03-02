// Normalize path separators — always use forward slashes (DB convention)
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/')
}
