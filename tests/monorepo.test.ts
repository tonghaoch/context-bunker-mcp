import { describe, it, expect, afterEach } from 'bun:test'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { findNearestProjectRoot } from '../src/utils/monorepo.js'

const TMP = join(import.meta.dir, '.tmp-monorepo-test')

function setup(files: Record<string, string>) {
  rmSync(TMP, { recursive: true, force: true })
  for (const [relPath, content] of Object.entries(files)) {
    const full = join(TMP, relPath)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
}

afterEach(() => {
  try { rmSync(TMP, { recursive: true, force: true }) } catch {}
})

describe('findNearestProjectRoot', () => {
  it('returns dir with package.json for a plain project', () => {
    setup({ 'package.json': '{"name":"my-app"}' })
    expect(findNearestProjectRoot(TMP)).toBe(TMP)
  })

  it('returns project dir when given a file inside', () => {
    setup({
      'package.json': '{"name":"my-app"}',
      'src/index.ts': 'export const x = 1',
    })
    expect(findNearestProjectRoot(join(TMP, 'src', 'index.ts'))).toBe(TMP)
  })

  it('returns sub-package dir in npm monorepo, not root', () => {
    setup({
      'package.json': JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
      'packages/app/package.json': JSON.stringify({ name: '@org/app' }),
      'packages/app/src/index.ts': 'export default 1',
    })
    expect(findNearestProjectRoot(join(TMP, 'packages', 'app', 'src', 'index.ts')))
      .toBe(join(TMP, 'packages', 'app'))
  })

  it('returns sub-package when given sub-package dir directly', () => {
    setup({
      'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
      'packages/lib/package.json': '{"name":"lib"}',
    })
    expect(findNearestProjectRoot(join(TMP, 'packages', 'lib')))
      .toBe(join(TMP, 'packages', 'lib'))
  })

  it('falls back to monorepo root if no deeper project found', () => {
    setup({
      'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
      'src/index.ts': 'export const x = 1',
    })
    // File directly under monorepo root (not in a sub-package)
    expect(findNearestProjectRoot(join(TMP, 'src', 'index.ts'))).toBe(TMP)
  })

  it('returns dir with go.mod', () => {
    setup({
      'go.mod': 'module example.com/myapp',
      'main.go': 'package main',
    })
    expect(findNearestProjectRoot(join(TMP, 'main.go'))).toBe(TMP)
  })

  it('returns Go sub-module inside go.work workspace', () => {
    setup({
      'go.work': 'go 1.21\nuse ./cmd/server',
      'cmd/server/go.mod': 'module example.com/cmd/server',
      'cmd/server/main.go': 'package main',
    })
    expect(findNearestProjectRoot(join(TMP, 'cmd', 'server', 'main.go')))
      .toBe(join(TMP, 'cmd', 'server'))
  })

  it('returns Rust crate dir, not workspace root', () => {
    setup({
      'Cargo.toml': '[workspace]\nmembers = ["crates/core"]',
      'crates/core/Cargo.toml': '[package]\nname = "core"',
      'crates/core/src/lib.rs': 'pub fn hello() {}',
    })
    expect(findNearestProjectRoot(join(TMP, 'crates', 'core', 'src', 'lib.rs')))
      .toBe(join(TMP, 'crates', 'core'))
  })

  it('falls back to Cargo workspace root if no deeper crate', () => {
    setup({
      'Cargo.toml': '[workspace]\nmembers = ["crates/*"]',
      'build.rs': '// build script',
    })
    expect(findNearestProjectRoot(join(TMP, 'build.rs'))).toBe(TMP)
  })

  it('returns dir with pyproject.toml', () => {
    setup({
      'pyproject.toml': '[project]\nname = "myapp"',
      'src/app.py': 'print("hello")',
    })
    expect(findNearestProjectRoot(join(TMP, 'src', 'app.py'))).toBe(TMP)
  })

  it('walks up past directories without markers', () => {
    // When no markers in immediate dir, it walks up until it finds one
    setup({
      'package.json': '{"name":"root"}',
      'some/deep/dir/file.txt': 'hello',
    })
    const subDir = join(TMP, 'some', 'deep', 'dir')
    expect(findNearestProjectRoot(subDir)).toBe(TMP)
  })

  it('handles yarn workspaces object form', () => {
    setup({
      'package.json': JSON.stringify({ workspaces: { packages: ['apps/*'] } }),
      'apps/web/package.json': '{"name":"web"}',
      'apps/web/src/page.tsx': 'export default () => null',
    })
    expect(findNearestProjectRoot(join(TMP, 'apps', 'web', 'src', 'page.tsx')))
      .toBe(join(TMP, 'apps', 'web'))
  })
})
