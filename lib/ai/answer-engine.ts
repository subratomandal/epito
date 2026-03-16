/**
 * Answer Engine — code-based extraction layer that sits between retrieval and the model.
 *
 * For every user query:
 *   1. Tries to answer from chunks using code (regex, keyword matching)
 *   2. If code finds the answer → returns it directly, model is never called
 *   3. If code can't answer → returns null, model handles it as normal
 *
 * This fixes the documented Mistral 7B failure where the model receives correct
 * chunks but says "not found" or ignores them (arxiv 2603.11513: 7B models
 * extract correct answers only 14.6% of the time even with oracle retrieval).
 */

// ─── Entity Pattern Registry ─────────────────────────────────────────────────

const ENTITY_PATTERNS: Record<string, RegExp[]> = {
  university: [
    /[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+University(?:\s+(?:of|in|for)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)*/g,
    /University\s+of\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g,
    /[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+Institute\s+of\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g,
    /[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:Defence|Defense)\s+University/g,
    /\bMIT\b/g,
    /\bIIT\s+[A-Z][a-z]+/g,
  ],
  college: [
    /[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+College(?:\s+of\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)*/g,
  ],
  tool: [
    /\bBeautifulSoup\b/g, /\bScrapy\b/g, /\bSelenium\b/g, /\blxml\b/g,
    /\bMechanicalSoup\b/g, /\bFlask\b/g, /\bMongoDB\b/g, /\bDjango\b/g,
    /\bPyTorch\b/g, /\bTensorFlow\b/g, /\bKeras\b/g, /\bNumPy\b/g,
    /\bPandas\b/g, /\bScikit-learn\b/g, /\bOpenCV\b/g,
    /\brequests\b/g, /\bUrllib3?\b/g,
  ],
  person: [
    /[A-Z][a-z]{1,15}\s+(?:[A-Z]\.?\s+)?[A-Z][a-z]{1,15}(?:\s+[A-Z][a-z]{1,15})?/g,
  ],
  reference: [
    /\[\d+\]/g,
  ],
};

const QUERY_TO_ENTITY: Record<string, string[]> = {
  university: ['university', 'universities', 'college', 'colleges', 'institute', 'institutes', 'school', 'schools', 'institution', 'institutions'],
  tool: ['tool', 'tools', 'library', 'libraries', 'framework', 'frameworks', 'software', 'scraper', 'scrapers', 'technology', 'technologies'],
  person: ['author', 'authors', 'who wrote', 'who is', 'who are', 'person', 'people', 'researcher', 'researchers'],
  reference: ['reference', 'references', 'citation', 'citations', 'bibliography'],
};

// ─── Core Functions ──────────────────────────────────────────────────────────

function combineChunks(chunks: string[]): string {
  return chunks.join(' ');
}

function scanChunks(chunks: string[], patterns: RegExp[]): string[] {
  const combined = combineChunks(chunks);
  const found = new Map<string, string>(); // lowercase → original

  for (const pattern of patterns) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(combined)) !== null) {
      const text = m[0].trim().replace(/[,.]$/, '');
      if (text.length > 3) {
        const key = text.toLowerCase();
        if (!found.has(key)) found.set(key, text);
      }
    }
  }

  return [...found.values()];
}

function detectEntityType(query: string): string | null {
  const q = query.toLowerCase();
  for (const [entityType, keywords] of Object.entries(QUERY_TO_ENTITY)) {
    for (const kw of keywords) {
      if (q.includes(kw)) return entityType;
    }
  }
  return null;
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'what', 'which', 'who',
  'where', 'when', 'how', 'do', 'does', 'did', 'in', 'on', 'at', 'to',
  'for', 'of', 'and', 'or', 'this', 'that', 'all', 'any', 'my', 'your',
  'me', 'it', 'they', 'be', 'been', 'have', 'has', 'had', 'not', 'can',
  'could', 'will', 'would', 'with', 'from', 'by', 'about', 'into',
  'give', 'tell', 'listed', 'mentioned', 'named', 'written', 'here',
]);

function findRelevantSentences(query: string, chunks: string[], maxSentences = 5): string[] {
  const combined = combineChunks(chunks);
  const sentences = combined.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 10);

  const queryWords = new Set(
    query.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !STOP_WORDS.has(w))
  );

  const scored: [number, string][] = [];
  for (const sentence of sentences) {
    const sLower = sentence.toLowerCase();
    let overlap = 0;
    for (const w of queryWords) {
      if (sLower.includes(w)) overlap++;
    }
    if (overlap > 0) scored.push([overlap, sentence.trim()]);
  }

  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, maxSentences).map(s => s[1]);
}

// ─── Main Function ───────────────────────────────────────────────────────────

export type AnswerResult = {
  answer: string;
  skipModel: true;
} | {
  tinyPrompt: string;
  skipModel: false;
} | null;

export function tryAnswer(query: string, chunks: string[]): AnswerResult {
  if (!chunks || chunks.length === 0) {
    return { answer: "I don't have any notes to search through. Add some notes first!", skipModel: true };
  }

  const qLower = query.toLowerCase();

  // ─── List/Extraction Queries ───────────────────────────────────────────
  const entityType = detectEntityType(query);
  if (entityType && ENTITY_PATTERNS[entityType]) {
    const isListQuery = /\b(list|all|every|name|names|what are|how many|which|mentioned|written|given|stated)\b/i.test(qLower);

    if (isListQuery || entityType === 'university') {
      let patterns = [...ENTITY_PATTERNS[entityType]];
      if (entityType === 'university') {
        patterns = [...patterns, ...(ENTITY_PATTERNS.college || [])];
      }

      const results = scanChunks(chunks, patterns);

      if (results.length > 0) {
        const label: Record<string, string> = {
          university: 'Universities/institutions',
          college: 'Colleges',
          tool: 'Tools/libraries',
          person: 'People/authors',
          reference: 'References',
        };
        const lines = results.map((item, i) => `${i + 1}. ${item}`);
        return {
          answer: `${label[entityType] || 'Items'} mentioned in your notes:\n${lines.join('\n')}`,
          skipModel: true,
        };
      }
    }
  }

  // ─── "Who is X" Queries ────────────────────────────────────────────────
  const whoMatch = qLower.match(/who (?:is|are|was) (.+?)(?:\?|$)/);
  if (whoMatch) {
    const personName = whoMatch[1].trim();
    const sentences = findRelevantSentences(personName, chunks, 8);
    if (sentences.length > 0) {
      return {
        answer: `Here's what your notes say about ${personName}:\n\n${sentences.slice(0, 5).join(' ')}`,
        skipModel: true,
      };
    }
    return { answer: `I couldn't find information about ${personName} in your notes.`, skipModel: true };
  }

  // ─── Yes/No Queries ────────────────────────────────────────────────────
  if (/^(is|are|does|do|was|were|did|has|have|can)\s/i.test(qLower)) {
    const keyTerms = query.split(/\s+/).slice(1).filter(w => w.length > 3 && !STOP_WORDS.has(w.toLowerCase()));
    const combined = combineChunks(chunks).toLowerCase();
    const matches = keyTerms.filter(t => combined.includes(t.toLowerCase()));
    if (matches.length > 0) {
      const evidence = findRelevantSentences(query, chunks, 2);
      const evText = evidence.length > 0 ? ' ' + evidence[0].slice(0, 200) : '';
      return { answer: `Yes.${evText}`, skipModel: true };
    }
    return { answer: 'Based on your notes, no.', skipModel: true };
  }

  // ─── "What is X" Queries ───────────────────────────────────────────────
  const whatMatch = qLower.match(/what (?:is|are|was|were) (.+?)(?:\?|$)/);
  if (whatMatch) {
    const topic = whatMatch[1].trim();
    const sentences = findRelevantSentences(topic, chunks, 5);
    if (sentences.length > 0) {
      return { answer: sentences.slice(0, 3).join(' '), skipModel: true };
    }
  }

  // ─── Comparison Queries ────────────────────────────────────────────────
  if (/\b(compare|vs|versus|difference|better|faster|which is)\b/i.test(qLower)) {
    const sentences = findRelevantSentences(query, chunks, 8);
    if (sentences.length > 0) {
      return { answer: sentences.join(' '), skipModel: true };
    }
  }

  // ─── Numerical Queries ─────────────────────────────────────────────────
  if (/\b(how many|average|total|count|percentage|rate|runtime)\b/i.test(qLower)) {
    const sentences = findRelevantSentences(query, chunks, 5);
    if (sentences.length > 0) {
      return { answer: sentences.slice(0, 3).join(' '), skipModel: true };
    }
  }

  // ─── Fallback: Condense chunks to relevant sentences for model ─────────
  const relevant = findRelevantSentences(query, chunks, 5);
  if (relevant.length > 0) {
    return {
      tinyPrompt: relevant.join(' '),
      skipModel: false,
    };
  }

  // Nothing found at all
  return null;
}
