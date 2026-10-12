import { isAbsolute, join, normalize, relative } from 'node:path';

export function safeFilePath(root, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  // Git metadata and local dotfiles must never be downloadable from the web root.
  if (decoded.includes('\0') || decoded.split(/[\\/]/).some(part => part.startsWith('.'))) return null;
  const requested = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const candidate = normalize(join(root, requested));
  const relation = relative(root, candidate);
  return relation.startsWith('..') || isAbsolute(relation) ? null : candidate;
}
