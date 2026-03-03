import { existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * Walk up from any file/directory path and return the nearest (deepest)
 * directory that looks like a project root. Stops at the first marker found,
 * so monorepo sub-packages are naturally preferred over the monorepo root.
 *
 * Markers: package.json, go.mod, Cargo.toml, pyproject.toml
 */
export function findNearestProjectRoot(startPath: string): string {
  const absPath = resolve(startPath)
  let dir = isFile(absPath) ? dirname(absPath) : absPath

  while (true) {
    if (existsSync(join(dir, 'package.json'))) return dir
    if (existsSync(join(dir, 'go.mod'))) return dir
    if (existsSync(join(dir, 'Cargo.toml'))) return dir
    if (existsSync(join(dir, 'pyproject.toml'))) return dir

    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  // Nothing found — use original path (parent dir if it was a file)
  return isFile(absPath) ? dirname(absPath) : absPath
}

function isFile(p: string): boolean {
  try { return statSync(p).isFile() } catch { return false }
}
