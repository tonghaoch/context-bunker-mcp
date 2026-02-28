// JavaScript AST is nearly identical to TypeScript in tree-sitter.
// The main difference: no type annotations, interfaces, or type aliases.
// The TypeScript extractor handles all of these gracefully (they simply won't appear).
export { extractTypeScript as extractJavaScript } from './typescript.js'
