import type { DB } from '../store/db.js'

// Single-pass tokenizer: splits camelCase, PascalCase, snake_case, SCREAMING_CASE
// into lowercase terms. Avoids 3 regex replacements + split + filter on full file content.
export function tokenize(text: string): string[] {
  const terms: string[] = []
  let start = -1 // -1 means not in a token

  for (let i = 0; i <= text.length; i++) {
    const ch = i < text.length ? text.charCodeAt(i) : 0
    const isUpper = ch >= 65 && ch <= 90    // A-Z
    const isLower = ch >= 97 && ch <= 122   // a-z
    const isDigit = ch >= 48 && ch <= 57    // 0-9
    const isAlnum = isUpper || isLower || isDigit

    if (!isAlnum) {
      // End current token
      if (start >= 0 && i - start > 1) {
        terms.push(text.slice(start, i).toLowerCase())
      }
      start = -1
      continue
    }

    if (start < 0) {
      // Start new token
      start = i
      continue
    }

    // CamelCase split: lowercase followed by uppercase (e.g., "myFunc" -> "my", "Func")
    const prevLower = text.charCodeAt(i - 1) >= 97 && text.charCodeAt(i - 1) <= 122
    if (isUpper && prevLower) {
      if (i - start > 1) terms.push(text.slice(start, i).toLowerCase())
      start = i
      continue
    }

    // SCREAMING split: multiple uppercase followed by uppercase+lowercase (e.g., "XMLParser" -> "XML", "Parser")
    const prevUpper = text.charCodeAt(i - 1) >= 65 && text.charCodeAt(i - 1) <= 90
    if (isLower && prevUpper && i - start > 1) {
      if (i - 1 - start > 1) terms.push(text.slice(start, i - 1).toLowerCase())
      start = i - 1
    }
  }

  return terms
}

// Compute term frequencies for a single file's content
function computeTF(terms: string[]): Map<string, number> {
  const freq = new Map<string, number>()
  for (const t of terms) freq.set(t, (freq.get(t) ?? 0) + 1)
  let max = 1
  for (const v of freq.values()) { if (v > max) max = v }
  // Normalize: tf = count / maxCount
  for (const [k, v] of freq) freq.set(k, v / max)
  return freq
}

// Update TF-IDF for a single file
export function updateFileTFIDF(db: DB, fileId: number, content: string) {
  const terms = tokenize(content)
  const tf = computeTF(terms)

  // Clear old entries
  db.prepare('DELETE FROM tfidf WHERE file_id = ?').run(fileId)

  const insert = db.prepare('INSERT INTO tfidf (term, file_id, tf) VALUES (?, ?, ?)')
  for (const [term, score] of tf) {
    insert.run(term, fileId, score)
  }
}

// Recompute IDF across the entire corpus. Call after batch indexing.
export function recomputeIDF(db: DB) {
  const totalFiles = (db.prepare('SELECT COUNT(*) as n FROM files').get() as { n: number }).n
  if (totalFiles === 0) return

  const run = db.transaction(() => {
    db.prepare('DELETE FROM idf').run()

    // Compute and insert IDF entirely in SQL — no JS round-trip for term data
    db.prepare(
      `INSERT INTO idf (term, idf)
       SELECT term, ln(? * 1.0 / COUNT(DISTINCT file_id))
       FROM tfidf GROUP BY term`
    ).run(totalFiles)
  })
  run()
}

// Search: returns file IDs ranked by TF-IDF score
export function searchTFIDF(db: DB, query: string, limit = 20): { fileId: number; score: number }[] {
  const terms = tokenize(query)
  if (terms.length === 0) return []

  const placeholders = terms.map(() => '?').join(',')
  const rows = db.prepare(`
    SELECT t.file_id, SUM(t.tf * COALESCE(i.idf, 1.0)) as score
    FROM tfidf t
    LEFT JOIN idf i ON t.term = i.term
    WHERE t.term IN (${placeholders})
    GROUP BY t.file_id
    ORDER BY score DESC
    LIMIT ?
  `).all(...terms, limit) as { file_id: number; score: number }[]

  return rows.map(r => ({ fileId: r.file_id, score: r.score }))
}
