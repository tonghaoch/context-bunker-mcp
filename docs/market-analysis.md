# Market Analysis: Local Codebase MCP Server

## 1. The 7 Mega-Trends in JS/TS (2025-2026)

| # | Trend | Signal | Evidence |
|---|-------|--------|----------|
| 1 | **AI Agent Tooling** | 🔥🔥🔥🔥🔥 | 6 of top 10 fastest-growing GitHub repos are AI infra; LLM SDK repos +178% YoY |
| 2 | **Rust Rewrites of JS Tooling** | 🔥🔥🔥🔥 | Biome, oxc, Rolldown, Rspack — entire toolchain being rewritten |
| 3 | **MCP Ecosystem** | 🔥🔥🔥🔥 | 97M+ monthly SDK downloads; 2000+ servers in registry; backed by OpenAI, Google, Microsoft |
| 4 | **Local-First / Sync Engines** | 🔥🔥🔥 | FOSDEM 2026 dedicated track; Electric SQL, PowerSync, Prisma adding local-first |
| 5 | **Edge-Native Everything** | 🔥🔥🔥 | Hono exploding; Cloudflare Agents SDK; edge SQLite (Turso/D1) |
| 6 | **Full-Stack Type Safety** | 🔥🔥🔥 | Drizzle + tRPC + Zod stack; Standard Schema spec unifying validators |
| 7 | **AI Code Quality Crisis** | 🔥🔥🔥 | AI PRs have 1.7x more bugs, 2.74x more security vulns; maintainers shutting down repos |

## 2. MCP Ecosystem Growth

- MCP servers: 425 (Aug 2025) → 1,412 (Feb 2026) — **232% increase in 6 months**
- PulseMCP registry: 5,500+ servers listed
- 97M+ monthly SDK downloads
- 81% of adopters are companies with <200 employees
- Remote MCP servers up 4x since May 2025

Sources:
- [MCP Adoption Statistics](https://mcpmanager.ai/blog/mcp-adoption-statistics/)
- [MCP First Anniversary](https://blog.modelcontextprotocol.io/posts/2025-11-25-first-mcp-anniversary/)

## 3. The Context Problem — Quantified Demand

| Signal | Data Point | Source |
|--------|-----------|--------|
| Stars velocity | Serena: 0→20.7K in 11 months. claude-context: 0→5.4K in 9 months | GitHub |
| Token waste | AI agents spend **80% of tokens on "orientation"** not actual coding | [EarEzki](https://earezki.com/ai-news/2026-02-26-how-i-cut-my-ai-coding-agents-token-usage-by-65-without-changing-models/) |
| Cost pain | 3,177 API calls analyzed; context selection quality directly impacts costs | [BSWEN](https://docs.bswen.com/blog/2026-02-21-ai-context-windows/) |
| Context collapse | Summarization is "lossy by nature" — devs lose project state mid-session | [Medium](https://medium.com/@ram3shpala/context-collapse-the-ai-problem-nobodys-talking-about-5570a2731e25) |
| 70% problem | AI gets 70% there; the gap is mostly context, not intelligence | [Addy Osmani](https://addyo.substack.com/p/the-70-problem-hard-truths-about) |
| Token reduction | AGENTS.md alone = 29% runtime reduction, 17% token reduction | [SmartScope](https://smartscope.blog/en/generative-ai/claude/agents-md-token-optimization-guide-2026/) |
| AST > grep | Replacing grep with AST subgraphs: file reads dropped from 40 → 5 | Same |

## 4. Developer Pain Points (State of JS 2025)

From 13,002 responses:

| Missing Feature | % Want It |
|----------------|-----------|
| Standard library for JS | 43% |
| Signals (reactive primitives) | 39% |
| Native types in JS | 32% |
| Pipe operator | 23% |

Top pain points: date handling, mocking in tests, state management, dependency management, build config.

## 5. AI Coding Tool Frustrations

- **66% of developers** say AI code is "almost right, but not quite"
- **Only 3%** "highly trust" AI output
- **72%** say vibe coding is NOT part of professional work
- AI PRs have **1.7x more defects**, **2.74x more security vulns** (CodeRabbit analysis of 470 PRs)
- Maintainers shutting repos: cURL (bug bounty), Ghostty (banned AI), tldraw (closed PRs)

Sources:
- [InfoQ: AI floods close projects](https://www.infoq.com/news/2026/02/ai-floods-close-projects/)
- [Vibe Coding Statistics](https://www.secondtalent.com/resources/vibe-coding-statistics/)
- [The Vibe Coding Hangover](https://www.contextstudios.ai/blog/the-vibe-coding-hangover-why-developers-are-returning-to-engineering-rigor)

## 6. Why This Project, Why Now

The intersection of three forces:

1. **MCP hit critical mass** (97M downloads, universal client support)
2. **Context is the #1 bottleneck** (80% token waste, session amnesia, orientation cost)
3. **Existing solutions are broken** (cloud-dependent, Python-heavy, complex setup, stale)

The timing window is ~6-12 months before major players (GitHub, Cursor, Windsurf) build this in.
