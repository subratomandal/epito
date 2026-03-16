/**
 * Answer Engine — dynamic context extraction layer.
 *
 * Instead of hardcoded entity patterns, this:
 *   1. Extracts key terms from the user's query
 *   2. Finds every occurrence of those terms in the chunks
 *   3. Reads 100 words before and after each match
 *   4. Deduplicates overlapping excerpts
 *   5. Returns these focused excerpts as the prompt context
 *
 * The model gets ONLY the relevant surrounding text, not entire chunks.
 * Less noise = the model actually reads it.
 */

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'what', 'which', 'who',
  'where', 'when', 'how', 'do', 'does', 'did', 'in', 'on', 'at', 'to',
  'for', 'of', 'and', 'or', 'this', 'that', 'all', 'any', 'my', 'your',
  'me', 'it', 'they', 'be', 'been', 'have', 'has', 'had', 'not', 'can',
  'could', 'will', 'would', 'with', 'from', 'by', 'about', 'into',
  'give', 'tell', 'list', 'listed', 'mentioned', 'named', 'written',
  'here', 'there', 'some', 'many', 'much', 'more', 'most', 'other',
  'than', 'then', 'also', 'just', 'but', 'if', 'so', 'no', 'yes',
  'i', 'you', 'we', 'he', 'she', 'its', 'them', 'their', 'our',
  'been', 'being', 'may', 'might', 'must', 'shall', 'should', 'need',
  'up', 'out', 'off', 'over', 'only', 'very', 'such', 'like',
  'what', 'name', 'names', 'please', 'paper', 'note', 'notes',
]);

// ─── Extract Key Terms from Query ────────────────────────────────────────────

function extractQueryTerms(query: string): string[] {
  const words = query.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));

  // Also extract multi-word phrases (2-3 word ngrams that appear as-is)
  const cleaned = query.toLowerCase().replace(/[^\w\s]/g, ' ');
  const allWords = cleaned.split(/\s+/).filter(w => w.length > 0);
  const phrases: string[] = [];

  for (let i = 0; i < allWords.length - 1; i++) {
    const bigram = `${allWords[i]} ${allWords[i + 1]}`;
    if (!STOP_WORDS.has(allWords[i]) || !STOP_WORDS.has(allWords[i + 1])) {
      phrases.push(bigram);
    }
    if (i < allWords.length - 2) {
      const trigram = `${allWords[i]} ${allWords[i + 1]} ${allWords[i + 2]}`;
      phrases.push(trigram);
    }
  }

  // Return unique terms, longest first (phrases before single words)
  const all = [...new Set([...phrases, ...words])];
  all.sort((a, b) => b.length - a.length);
  return all;
}

// ─── Find Matches + Surrounding Context ──────────────────────────────────────

interface ContextMatch {
  term: string;
  position: number;
  excerpt: string; // 100 words before + match + 100 words after
}

function findMatchesWithContext(
  text: string,
  terms: string[],
  windowWords: number = 100,
): ContextMatch[] {
  const textLower = text.toLowerCase();
  const words = text.split(/\s+/);
  const matches: ContextMatch[] = [];
  const coveredRanges: [number, number][] = []; // prevent overlapping excerpts

  for (const term of terms) {
    let searchFrom = 0;

    while (true) {
      const pos = textLower.indexOf(term, searchFrom);
      if (pos === -1) break;
      searchFrom = pos + term.length;

      // Convert character position to word index
      const charsBefore = text.slice(0, pos);
      const wordIdx = charsBefore.split(/\s+/).length - 1;

      // Check if this position overlaps with an already-extracted region
      const start = Math.max(0, wordIdx - windowWords);
      const end = Math.min(words.length, wordIdx + windowWords);

      const overlaps = coveredRanges.some(
        ([cs, ce]) => start < ce && end > cs
      );

      if (!overlaps) {
        const excerpt = words.slice(start, end).join(' ');
        matches.push({ term, position: pos, excerpt });
        coveredRanges.push([start, end]);
      }
    }
  }

  // Sort by position in document (preserve reading order)
  matches.sort((a, b) => a.position - b.position);
  return matches;
}

// ─── Count Occurrences ───────────────────────────────────────────────────────

function countOccurrences(text: string, term: string): number {
  const lower = text.toLowerCase();
  const t = term.toLowerCase();
  let count = 0;
  let pos = 0;
  while ((pos = lower.indexOf(t, pos)) !== -1) {
    count++;
    pos += t.length;
  }
  return count;
}

// ─── Main: Extract Focused Context ───────────────────────────────────────────

export interface ExtractionResult {
  /** The focused excerpts to use as context (replaces full chunks) */
  focusedContext: string;
  /** Number of unique term matches found */
  matchCount: number;
  /** The terms that were found */
  matchedTerms: string[];
  /** Whether enough was found to skip the model entirely */
  directAnswer: string | null;
}

export function extractFocusedContext(
  query: string,
  chunks: string[],
): ExtractionResult {
  if (!chunks || chunks.length === 0) {
    return { focusedContext: '', matchCount: 0, matchedTerms: [], directAnswer: null };
  }

  const combined = chunks.join('\n\n');
  const terms = extractQueryTerms(query);

  if (terms.length === 0) {
    // No meaningful terms extracted — return first 500 words as context
    const words = combined.split(/\s+/);
    return {
      focusedContext: words.slice(0, 500).join(' '),
      matchCount: 0,
      matchedTerms: [],
      directAnswer: null,
    };
  }

  // Find which terms actually appear in the text
  const foundTerms: string[] = [];
  const termCounts = new Map<string, number>();

  for (const term of terms) {
    const count = countOccurrences(combined, term);
    if (count > 0) {
      // Avoid adding a single word if a phrase containing it is already found
      const alreadyCovered = foundTerms.some(
        ft => ft.length > term.length && ft.includes(term)
      );
      if (!alreadyCovered) {
        foundTerms.push(term);
        termCounts.set(term, count);
      }
    }
  }

  if (foundTerms.length === 0) {
    return { focusedContext: '', matchCount: 0, matchedTerms: [], directAnswer: null };
  }

  // Extract context windows around each match
  const matches = findMatchesWithContext(combined, foundTerms, 100);
  const totalMatches = foundTerms.reduce((sum, t) => sum + (termCounts.get(t) || 0), 0);

  // Build focused context from excerpts
  let focusedContext: string;
  if (matches.length === 0) {
    // Terms exist but no non-overlapping windows (very short text)
    focusedContext = combined;
  } else {
    focusedContext = matches.map((m, i) => `[${i + 1}] ${m.excerpt}`).join('\n\n');
  }

  // ─── Entity Extraction for List/Count Queries ───────────────────────────
  const isListQuery = /\b(list|all|every|how many|what are|which|mentioned|name|count|number of)\b/i.test(query.toLowerCase());
  const isCountQuery = /\b(how many|count|number of|total)\b/i.test(query.toLowerCase());

  let directAnswer: string | null = null;

  if ((isListQuery || isCountQuery) && matches.length > 0) {
    // Determine what type of entity to look for from the query
    const qLower = query.toLowerCase();
    const entityPatterns: RegExp[] = [];

    // University/college/institution patterns
    if (/\b(universit|college|institut|school|academ)\b/i.test(qLower)) {
      entityPatterns.push(
        /[A-Z][a-z]+(?:\s+(?:[A-Z][a-z]+|of|the|and|for|in|Sir|General))*\s+(?:University|Institute|College|Academy)/g,
        /University\s+of\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g,
        /[A-Z]{2,}(?:\s+[A-Z][a-z]+)*/g, // MIT, IIT, etc.
      );
    }
    // Company/organization patterns
    if (/\b(compan|organization|firm|corp|enterprise)\b/i.test(qLower)) {
      entityPatterns.push(
        /[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*(?:\s+(?:Inc|Corp|Ltd|LLC|Co|Group|Foundation|Technologies)\.?)/g,
        /[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/g,
      );
    }
    // Person patterns
    if (/\b(person|people|author|researcher|who|name)\b/i.test(qLower)) {
      entityPatterns.push(
        /[A-Z][a-z]{1,15}\s+(?:[A-Z]\.?\s+)?[A-Z][a-z]{1,15}/g,
      );
    }
    // Generic: any capitalized multi-word entity
    if (entityPatterns.length === 0) {
      entityPatterns.push(
        /[A-Z][a-z]+(?:\s+(?:[A-Z][a-z]+|of|the|and|for|in))*\s+[A-Z][a-z]+/g,
      );
    }

    // Scan all excerpts for matching entities
    const entitySet = new Map<string, string>(); // lowercase → original
    for (const match of matches) {
      for (const pattern of entityPatterns) {
        pattern.lastIndex = 0;
        let m;
        while ((m = pattern.exec(match.excerpt)) !== null) {
          const entity = m[0].trim();
          const key = entity.toLowerCase();
          if (entity.length > 4 && !entitySet.has(key)) {
            entitySet.set(key, entity);
          }
        }
      }
    }

    if (entitySet.size > 0) {
      const items = [...entitySet.values()];
      const numbered = items.map((e, i) => `${i + 1}. ${e}`);

      if (isCountQuery) {
        directAnswer = `${items.length} found in your notes:\n\n${numbered.join('\n')}`;
      } else {
        directAnswer = `Found in your notes:\n\n${numbered.join('\n')}\n\nTotal: ${items.length}`;
      }
    }
  }

  console.log(
    `[AnswerEngine] Query: "${query}" | Terms: [${foundTerms.slice(0, 5).join(', ')}] | ` +
    `Matches: ${totalMatches} | Excerpts: ${matches.length} | ` +
    `Context: ${focusedContext.split(/\s+/).length} words`
  );

  return {
    focusedContext,
    matchCount: totalMatches,
    matchedTerms: foundTerms,
    directAnswer,
  };
}
