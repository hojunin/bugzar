import type { ReactNode } from 'react';

/** Flatten a Jira ADF doc to plain text for the editable Description field. */
export function adfToText(adf: unknown): string {
  if (!adf || typeof adf !== 'object') return '';
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as { type?: string; text?: string; content?: unknown[] };
    if (n.type === 'text' && typeof n.text === 'string') out.push(n.text);
    if (Array.isArray(n.content)) {
      n.content.forEach(walk);
      if (n.type === 'paragraph') out.push('\n');
    }
  };
  const root = adf as { content?: unknown[] };
  if (Array.isArray(root.content)) root.content.forEach(walk);
  return out.join('').replace(/\n+$/, '').trim();
}

export const initials = (name: string): string => (name.trim()[0] ?? '?').toUpperCase();

/** Wrap the (case-insensitive) substring of `text` matching `query` in a <mark>. */
export function highlightMatch(text: string, query: string): ReactNode {
  const q = query.trim();
  if (!q) return text;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark
        style={{
          background: 'rgba(59, 130, 246, 0.24)',
          color: 'inherit',
          borderRadius: 2,
        }}
      >
        {text.slice(idx, idx + q.length)}
      </mark>
      {text.slice(idx + q.length)}
    </>
  );
}
