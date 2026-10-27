const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Decodes the XML entities that OpenCloud leaves in highlights, numeric ones included. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) return String.fromCodePoint(parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(parseInt(entity.slice(1), 10));
    return entities[entity.toLowerCase()] ?? match;
  });
}

/** A highlight as plain text: entities decoded, `<mark>` tags removed, whitespace collapsed. */
export function plainExcerpt(highlights: string): string {
  return decodeEntities(decodeEntities(highlights)).replace(/<\/?mark>/gi, '').replace(/\s+/g, ' ').trim();
}

/**
 * The search patterns of a query: one for names, `*word1*word2*`, and one for the text extracted from the
 * documents, `content:word1 content:word2`. Characters that the query language of OpenCloud interprets are removed.
 */
export function searchPatterns(query: string): Readonly<{ name: string; content: string }> | undefined {
  const words = query.split(/\s+/).map(word => word.replace(/[^\p{L}\p{N}._-]/gu, '')).filter(Boolean);
  if (words.length === 0) return undefined;
  return { name: `*${words.join('*')}*`, content: words.map(word => `content:${word}`).join(' ') };
}

export function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
