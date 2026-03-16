import * as db from '@/lib/database';

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

/** Simple suffix stemmer — "universities" → "university", "mentioned" → "mention" */
function simpleStem(word: string): string {
  if (word.endsWith('ies') && word.length > 4) return word.slice(0, -3) + 'y';
  if (word.endsWith('es') && word.length > 4) return word.slice(0, -2);
  if (word.endsWith('ed') && word.length > 4) return word.slice(0, -2);
  if (word.endsWith('ing') && word.length > 5) return word.slice(0, -3);
  if (word.endsWith('tion') && word.length > 5) return word.slice(0, -4) + 'te';
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) return word.slice(0, -1);
  return word;
}

function extractQueryTerms(query: string): string[] {
  const words = query.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));

  // Add stemmed variants so "universities" matches "university"
  const withStems: string[] = [];
  for (const w of words) {
    withStems.push(w);
    const stemmed = simpleStem(w);
    if (stemmed !== w && stemmed.length > 2) withStems.push(stemmed);
  }

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

  // Combine: phrases + words + stemmed variants
  const all = [...new Set([...phrases, ...withStems])];
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

  // ─── Deterministic Entity Lookup (database index first, regex fallback) ──
  // For structured queries, extract entities from ALL chunks (not just excerpts)
  // then normalize, deduplicate, count, and format with evidence.

  const isListQuery = /\b(list|all|every|how many|what are|what .+ are|which|mentioned|name|count|number of|compared|used|described)\b/i.test(query.toLowerCase());
  const isCountQuery = /\b(how many|count|number of|total)\b/i.test(query.toLowerCase());

  let directAnswer: string | null = null;

  if ((isListQuery || isCountQuery) && combined.length > 0) {
    const qLower = query.toLowerCase();

    // ── Fast path: check pre-built entity index (O(1) database lookup) ──
    // If entities were extracted during ingestion, use those instead of runtime regex
    const dbEntityType = /\b(universit|college|institut|school|academ)/i.test(qLower) ? 'ORG'
      : /\b(compan|organization|firm|corp|enterprise)/i.test(qLower) ? 'ORG'
      : /\b(person|people|author|researcher|who)\b/i.test(qLower) ? 'PERSON'
      : /\b(tool|library|framework|software)\b/i.test(qLower) ? 'TOOL'
      : null;

    if (dbEntityType) {
      try {
        // Search across all documents in the entity index
        const dbEntities = db.searchEntities('%', dbEntityType);
        if (dbEntities.length > 0) {
          // Filter for university-specific if needed
          let filtered = dbEntities;
          if (/\b(universit|college|institut|school|academ)/i.test(qLower)) {
            filtered = dbEntities.filter(e =>
              /university|institute|college|academy|school/i.test(e.entity_name)
            );
            if (filtered.length === 0) filtered = dbEntities; // fallback to all ORG
          }

          const unique = new Map<string, typeof filtered[0]>();
          for (const e of filtered) {
            const key = e.entity_name.toLowerCase();
            if (!unique.has(key)) unique.set(key, e);
          }

          if (unique.size > 0) {
            const items = [...unique.values()];
            const entityLabel = dbEntityType === 'ORG' ? 'Organizations' : dbEntityType === 'PERSON' ? 'People' : 'Tools';
            const lines: string[] = [];
            lines.push(`Answer:`);
            lines.push(`${items.length} ${entityLabel.toLowerCase()} found.\n`);
            lines.push(`${entityLabel}:`);
            for (const { entity_name } of items) lines.push(`• ${entity_name}`);
            if (items.some(e => e.evidence)) {
              lines.push(`\nEvidence:`);
              for (const { entity_name, evidence } of items.slice(0, 5)) {
                if (evidence) lines.push(`"${evidence.slice(0, 120)}" → ${entity_name}`);
              }
            }
            directAnswer = lines.join('\n');
            console.log(`[AnswerEngine] Entity index hit: ${items.length} ${dbEntityType} entities from DB`);

            return { focusedContext, matchCount: totalMatches, matchedTerms: foundTerms, directAnswer };
          }
        }
      } catch (e) {
        // DB not available or table doesn't exist yet — fall through to regex
        console.log('[AnswerEngine] Entity index unavailable, using regex fallback');
      }
    }

    // ── Slow path: runtime regex extraction (fallback when no entity index) ──
    // STRICT: patterns must match the entity TYPE, not just any capitalized phrase.

    type EntityCategory = 'university' | 'company' | 'person' | 'tool';
    let category: EntityCategory | null = null;
    const patterns: RegExp[] = [];

    if (/\b(universit|college|institut|school|academ)/i.test(qLower)) {
      category = 'university';
      // Each pattern MUST contain University/Institute/College/Academy/School
      patterns.push(
        /(?:General\s+(?:Sir\s+)?)?[A-Z][a-z]+(?:\s+(?:[A-Z][a-z]+|of|the|and|for|in|Sir|General))*\s+(?:University|Institute|College|Academy)/g,
        /University\s+of\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g,
        /Massachusetts\s+Institute\s+of\s+Technology/g,
      );
    } else if (/\b(compan|organization|firm|corp|enterprise|business)/i.test(qLower)) {
      category = 'company';
      patterns.push(
        /[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*(?:\s+(?:Inc|Corp|Ltd|LLC|Co|Group|Foundation|Technologies|Labs|Systems)\.?)/g,
      );
    } else if (/\b(person|people|author|researcher|who|writer|scientist)\b/i.test(qLower)) {
      category = 'person';
      patterns.push(
        /[A-Z][a-z]{1,15}\s+(?:[A-Z]\.?\s+)?[A-Z][a-z]{1,15}/g,
      );
    } else if (/\b(tool|librar|framework|software|technolog)/i.test(qLower)) {
      category = 'tool';
      patterns.push(
        /\b(?:BeautifulSoup|Scrapy|Selenium|lxml|MechanicalSoup|Flask|Django|MongoDB|PostgreSQL|MySQL|Redis|TensorFlow|PyTorch|Keras|NumPy|Pandas|React|Angular|Vue|Docker|Kubernetes)\b/g,
      );
    }

    // If we don't know what entity type → don't extract, let the model handle it
    if (!category || patterns.length === 0) {
      // No extraction — fall through to model generation
    } else {
      const rawEntities: { name: string; evidence: string }[] = [];
      const seen = new Map<string, number>();

      for (const chunk of chunks) {
        for (const pattern of patterns) {
          pattern.lastIndex = 0;
          let m;
          while ((m = pattern.exec(chunk)) !== null) {
            const raw = m[0].trim();
            if (raw.length < 4) continue;

            // Normalize
            let normalized = raw;
            if (normalized === 'MIT') normalized = 'Massachusetts Institute of Technology';

            const key = normalized.toLowerCase();

            // For universities: MUST contain university/institute/college/academy
            if (category === 'university') {
              if (!/university|institute|college|academy/i.test(key) && key !== 'massachusetts institute of technology') {
                continue;
              }
            }

            // Deduplicate
            if (!seen.has(key)) {
              const sentenceStart = Math.max(0, chunk.lastIndexOf('.', m.index) + 1);
              const sentenceEnd = chunk.indexOf('.', m.index + raw.length);
              const evidence = chunk.slice(sentenceStart, sentenceEnd > 0 ? sentenceEnd + 1 : m.index + raw.length + 80).trim();

              seen.set(key, rawEntities.length);
              rawEntities.push({ name: normalized, evidence: evidence.slice(0, 150) });
            }
          }
        }
      }

      // Deduplicate: remove entities that are substrings of longer entities
      const deduped = rawEntities.filter((e, i) => {
        return !rawEntities.some((other, j) =>
          i !== j && other.name.length > e.name.length && other.name.toLowerCase().includes(e.name.toLowerCase())
        );
      });

      // Format response
      if (deduped.length > 0) {
        const entityLabel = category === 'university' ? 'Universities/Institutions'
          : category === 'company' ? 'Companies/Organizations'
          : category === 'person' ? 'People'
          : category === 'tool' ? 'Tools/Libraries'
          : 'Items';

        const lines: string[] = [];
        lines.push(`Answer:`);
        lines.push(`${deduped.length} ${entityLabel.toLowerCase()} found.\n`);
        lines.push(`${entityLabel}:`);
        for (const { name } of deduped) {
          lines.push(`• ${name}`);
        }
        lines.push(`\nEvidence:`);
        for (const { name, evidence } of deduped.slice(0, 5)) {
          if (evidence) lines.push(`"${evidence.slice(0, 120)}" → ${name}`);
        }

        directAnswer = lines.join('\n');
      }
    } // end of category extraction block
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
