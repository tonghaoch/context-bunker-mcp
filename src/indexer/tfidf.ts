import type { DB } from '../store/db.js'

// Split camelCase, PascalCase, snake_case, SCREAMING_CASE into lowercase terms
export function tokenize(text: string): string[] {
  return text
    // Insert space before uppercase letters in camelCase/PascalCase
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    // Replace non-alphanumeric with space
    .replace(/[^a-zA-Z0-9]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(t => t.length > 1) // drop single chars
}

// Compute term frequencies for a single file's content
function computeTF(terms: string[]): Map<string, number> {
  const freq = new Map<string, number>()
  for (const t of terms) freq.set(t, (freq.get(t) ?? 0) + 1)
  const max = Math.max(...freq.values(), 1)
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

  db.prepare('DELETE FROM idf').run()

  // For each term: IDF = log(totalFiles / docFreq)
  const termCounts = db.prepare(
    'SELECT term, COUNT(DISTINCT file_id) as df FROM tfidf GROUP BY term'
  ).all() as { term: string; df: number }[]

  const insert = db.prepare('INSERT INTO idf (term, idf) VALUES (?, ?)')
  for (const { term, df } of termCounts) {
    insert.run(term, Math.log(totalFiles / df))
  }
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
