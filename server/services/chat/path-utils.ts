/**
 * path-utils.ts
 * 
 * Shared JSON-Pointer path utilities for the memory system.
 * Used by both memory-system.ts and memory-db-bridge.ts
 * 
 * This file should remain platform-agnostic.
 */

// ──────────────────────────────────────────────────────────────────────────────
// JSON Pointer Escaping (RFC 6901)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Escape a token for use in a JSON Pointer path.
 * Per RFC 6901: '~' becomes '~0', '/' becomes '~1'
 */
export function escapeToken(token: string): string {
    return token.replace(/~/g, '~0').replace(/\//g, '~1');
  }
  
  /**
   * Unescape a token from a JSON Pointer path.
   * Per RFC 6901: '~1' becomes '/', '~0' becomes '~'
   * Order matters - must unescape ~1 before ~0
   */
  export function unescapeToken(token: string): string {
    return token.replace(/~1/g, '/').replace(/~0/g, '~');
  }
  
  // ──────────────────────────────────────────────────────────────────────────────
  // Path Manipulation
  // ──────────────────────────────────────────────────────────────────────────────
  
  /**
   * Normalize a path to ensure consistent format.
   * - Empty string or "/" becomes ""
   * - Paths always start with "/" (unless empty)
   * - Trailing slashes are removed
   */
  export function normalizePath(path: string): string {
    if (!path || path === '/') return '';
    let p = path.startsWith('/') ? path : '/' + path;
    if (p.endsWith('/') && p.length > 1) p = p.slice(0, -1);
    return p;
  }
  
  /**
   * Split a path into individual tokens.
   * Returns empty array for root path ("" or "/").
   * Tokens are unescaped.
   */
  export function splitPath(path: string): string[] {
    const normalized = normalizePath(path);
    if (!normalized) return [];
    return normalized.slice(1).split('/').map(unescapeToken);
  }
  
  /**
   * Join tokens into a path string.
   * Tokens are escaped before joining.
   */
  export function joinPath(tokens: string[]): string {
    if (tokens.length === 0) return '';
    return '/' + tokens.map(escapeToken).join('/');
  }
  
  /**
   * Get the parent path of a given path.
   * Returns empty string for root-level paths.
   */
  export function getParentPath(path: string): string {
    const tokens = splitPath(path);
    if (tokens.length <= 1) return '';
    return joinPath(tokens.slice(0, -1));
  }
  
  /**
   * Get the last token (key/index) from a path.
   * Returns undefined for root path.
   */
  export function getLastToken(path: string): string | undefined {
    const tokens = splitPath(path);
    return tokens.length > 0 ? tokens[tokens.length - 1] : undefined;
  }
  
  /**
   * Append a token to a path.
   */
  export function appendToPath(basePath: string, token: string | number): string {
    const normalized = normalizePath(basePath);
    return normalized + '/' + escapeToken(String(token));
  }
  
  /**
   * Check if a path is a descendant of another path.
   */
  export function isDescendantOf(childPath: string, parentPath: string): boolean {
    const normalizedChild = normalizePath(childPath);
    const normalizedParent = normalizePath(parentPath);
    
    if (normalizedParent === '') return normalizedChild !== '';
    return normalizedChild.startsWith(normalizedParent + '/');
  }
  
  /**
   * Check if a path is an ancestor of another path.
   */
  export function isAncestorOf(parentPath: string, childPath: string): boolean {
    return isDescendantOf(childPath, parentPath);
  }
  
  /**
   * Get the depth of a path (number of tokens).
   */
  export function getPathDepth(path: string): number {
    return splitPath(path).length;
  }
  
  /**
   * Get the relative path from a base path to a target path.
   * Returns undefined if target is not a descendant of base.
   */
  export function getRelativePath(basePath: string, targetPath: string): string | undefined {
    const normalizedBase = normalizePath(basePath);
    const normalizedTarget = normalizePath(targetPath);
    
    if (normalizedBase === '') return normalizedTarget;
    if (!normalizedTarget.startsWith(normalizedBase + '/')) return undefined;
    
    return normalizedTarget.slice(normalizedBase.length);
  }
  
  // ──────────────────────────────────────────────────────────────────────────────
  // Wildcard Handling
  // ──────────────────────────────────────────────────────────────────────────────
  
  /**
   * Check if a path contains a wildcard (*).
   */
  export function hasWildcard(path: string): boolean {
    return path.includes('*');
  }
  
  /**
   * Check if a path ends with a wildcard.
   */
  export function endsWithWildcard(path: string): boolean {
    const tokens = splitPath(path);
    return tokens.length > 0 && tokens[tokens.length - 1] === '*';
  }
  
  /**
   * Get the base path (everything before the wildcard).
   * Returns the full path if no wildcard present.
   */
  export function getWildcardBasePath(path: string): string {
    const tokens = splitPath(path);
    const wildcardIndex = tokens.indexOf('*');
    if (wildcardIndex === -1) return normalizePath(path);
    return joinPath(tokens.slice(0, wildcardIndex));
  }
  
  // ──────────────────────────────────────────────────────────────────────────────
  // Path Matching
  // ──────────────────────────────────────────────────────────────────────────────
  
  /**
   * Check if a concrete path matches a pattern path (which may contain wildcards).
   * Wildcards match any single token at that position.
   */
  export function pathMatchesPattern(concretePath: string, patternPath: string): boolean {
    const concreteTokens = splitPath(concretePath);
    const patternTokens = splitPath(patternPath);
    
    if (concreteTokens.length !== patternTokens.length) return false;
    
    for (let i = 0; i < patternTokens.length; i++) {
      if (patternTokens[i] !== '*' && patternTokens[i] !== concreteTokens[i]) {
        return false;
      }
    }
    
    return true;
  }
  
  /**
   * Extract the value at a wildcard position from a concrete path.
   * Returns undefined if paths don't match or no wildcard in pattern.
   */
  export function extractWildcardValue(concretePath: string, patternPath: string): string | undefined {
    const concreteTokens = splitPath(concretePath);
    const patternTokens = splitPath(patternPath);
    
    if (concreteTokens.length !== patternTokens.length) return undefined;
    
    for (let i = 0; i < patternTokens.length; i++) {
      if (patternTokens[i] === '*') {
        return concreteTokens[i];
      }
      if (patternTokens[i] !== concreteTokens[i]) {
        return undefined;
      }
    }
    
    return undefined;
  }
  
  // ──────────────────────────────────────────────────────────────────────────────
  // Path Sorting
  // ──────────────────────────────────────────────────────────────────────────────
  
  /**
   * Sort paths by depth (shallowest first).
   * Useful for processing parent paths before children.
   */
  export function sortPathsByDepthAsc(paths: string[]): string[] {
    // Pre-calculate depths for O(n log n) instead of O(n²)
    const withDepths = paths.map(p => ({ path: p, depth: getPathDepth(p) }));
    withDepths.sort((a, b) => a.depth - b.depth);
    return withDepths.map(item => item.path);
  }
  
  /**
   * Sort paths by depth (deepest first).
   * Useful for processing children before parents (e.g., deletions).
   */
  export function sortPathsByDepthDesc(paths: string[]): string[] {
    // Pre-calculate depths for O(n log n) instead of O(n²)
    const withDepths = paths.map(p => ({ path: p, depth: getPathDepth(p) }));
    withDepths.sort((a, b) => b.depth - a.depth);
    return withDepths.map(item => item.path);
  }
  
  // ──────────────────────────────────────────────────────────────────────────────
  // Convenience Type Guards
  // ──────────────────────────────────────────────────────────────────────────────
  
  /**
   * Check if a string looks like an array index.
   */
  export function isArrayIndex(token: string): boolean {
    return /^\d+$/.test(token);
  }
  
  /**
   * Parse a token as an array index, or return undefined if not a valid index.
   */
  export function parseArrayIndex(token: string): number | undefined {
    if (!isArrayIndex(token)) return undefined;
    const num = parseInt(token, 10);
    return Number.isNaN(num) || num < 0 ? undefined : num;
  }
  