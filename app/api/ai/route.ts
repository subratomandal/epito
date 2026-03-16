import { NextRequest, NextResponse } from 'next/server';
import { summarize, retrieveChunksForSummarization, contextualRetrieveForChat } from '@/lib/ai/pipeline';
import {
  summarizeText, summarizeChunks, explainText,
  chatWithRAG, classifyQuery, getGreetingResponse,
  getModelStatus, cleanInputText, chunkForSummarization, chunkForExplain,
} from '@/lib/ai/llm';
import { canAcceptTask, taskStarted, taskCompleted, isShuttingDown } from '@/lib/lifecycle';
import { extractFocusedContext } from '@/lib/ai/answer-engine';
import * as db from '@/lib/database';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(getModelStatus());
}

export async function POST(request: NextRequest) {
  if (isShuttingDown()) {
    return NextResponse.json({ error: 'Application is shutting down' }, { status: 503 });
  }
  if (!canAcceptTask()) {
    return NextResponse.json({ error: 'Too many concurrent AI tasks. Please wait.' }, { status: 429 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const { action, text, query, sourceId, useExtractive, chatMessage, chatHistory } = body;

  if (!text && !query) {
    return NextResponse.json({ error: 'Text or query required' }, { status: 400 });
  }

  taskStarted();
  try {
    switch (action) {
      case 'summarize':
      case 'summarize-document': {
        if (!useExtractive) {
          const cleaned = cleanInputText(text);

          const chunks = await retrieveChunksForSummarization(sourceId || null, cleaned, 10);

          if (chunks.length > 0) {
            const result = await summarizeChunks(chunks);
            if (result) {
              return NextResponse.json({ ...result, source: 'llm' });
            }
          }

          const directResult = await summarizeText(cleaned);
          if (directResult) {
            return NextResponse.json({ ...directResult, source: 'llm' });
          }
        }
        const sentenceCount = action === 'summarize-document' ? 6 : 4;
        const result = summarize(text, sentenceCount);
        return NextResponse.json({ ...result, source: 'extractive' });
      }

      case 'explain': {
        const cleaned = cleanInputText(text);

        const inputSentences = cleaned
          .split(/(?<=[.!?])\s+/)
          .filter((s: string) => s.trim().length > 10)
          .slice(0, 15);

        if (!useExtractive) {
          const result = await explainText(cleaned);
          if (result) {
            const parsed = parseExplainResponse(result.explanation, inputSentences);
            return NextResponse.json({
              explanation: result.explanation,
              sentences: parsed,
              source: 'llm',
            });
          }
        }

        const fallbackSentences = inputSentences.map((sentence: string) => {
          const words = sentence.toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
          const unique = [...new Set(words)].slice(0, 3);
          return {
            text: sentence.trim(),
            explanation: `This discusses ${unique.length > 0 ? unique.join(', ') : 'the topic'} and conveys a key idea from the text.`,
          };
        });

        return NextResponse.json({
          explanation: fallbackSentences.map((s: { text: string; explanation: string }) => s.explanation).join(' '),
          sentences: fallbackSentences,
          source: 'extractive',
        });
      }

      case 'chat': {
        if (!chatMessage) {
          return NextResponse.json({ error: 'chatMessage required' }, { status: 400 });
        }

        const queryType = classifyQuery(chatMessage);

        if (queryType === 'greeting') {
          return NextResponse.json({ response: getGreetingResponse(), source: 'classification' });
        }

        // Step 1: Retrieve chunks
        const retrieval = await contextualRetrieveForChat(sourceId || null, chatMessage, 5);

        // Step 2: Try code-based extraction on RAW chunks (not compressed)
        if (sourceId) {
          try {
            const rawChunks = db.getChunksByNote(sourceId).map((c: any) => c.content as string);
            console.log(`[API] Raw chunks for extraction: ${rawChunks.length}`);
            if (rawChunks.length > 0) {
              const extraction = extractFocusedContext(chatMessage, rawChunks);
              console.log(`[API] Extraction: matches=${extraction.matchCount} directAnswer=${!!extraction.directAnswer}`);
              if (extraction.directAnswer) {
                return NextResponse.json({
                  response: extraction.directAnswer,
                  source: 'extraction',
                  retrieval: { method: retrieval.method, sources: retrieval.sources },
                });
              }
            }
          } catch (extractErr) {
            console.error('[API] Extraction error:', extractErr);
          }
        }

        // Step 3: Fall through to model (only if code extraction didn't answer)
        try {
          const response = await chatWithRAG(
            retrieval.contexts.length > 0 ? retrieval.contexts : [],
            chatMessage,
            chatHistory || [],
          );
          return NextResponse.json({
            response,
            source: retrieval.contexts.length > 0 ? 'rag' : 'pipeline',
            retrieval: { method: retrieval.method, sources: retrieval.sources },
          });
        } catch (modelError: any) {
          // Model unavailable — return focused context as raw sentences
          if (retrieval.contexts.length > 0) {
            const extraction = extractFocusedContext(chatMessage, retrieval.contexts);
            if (extraction.matchCount > 0) {
              const sentences = extraction.focusedContext.split(/(?<=[.!?])\s+/).filter(s => s.length > 20).slice(0, 5);
              if (sentences.length > 0) {
                return NextResponse.json({
                  response: 'Based on your notes: ' + sentences.join(' '),
                  source: 'extraction_fallback',
                  retrieval: { method: retrieval.method, sources: retrieval.sources },
                });
              }
            }
          }
          return NextResponse.json({
            response: "I couldn't find an answer in your notes for this.",
            source: 'fallback',
          });
        }
      }

      case 'prepare-summary': {
        const cleaned = cleanInputText(text);
        const chunks = chunkForSummarization(cleaned);
        return NextResponse.json({ totalSections: chunks.length, sections: chunks });
      }

      case 'prepare-explain': {
        const sections = chunkForExplain(text);
        return NextResponse.json({ totalSections: sections.length, sections });
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (err) {
    console.error('[API] AI error:', err);
    const msg = err instanceof Error ? err.message : 'AI processing failed';
    const errorText = msg.includes('ECONNREFUSED') || msg.includes('fetch failed')
      ? 'Cannot connect to AI engine. It may still be loading.'
      : msg;
    return NextResponse.json({ error: errorText }, { status: 500 });
  } finally {
    taskCompleted();
  }
}

function parseExplainResponse(
  llmOutput: string,
  originalSentences: string[],
): { text: string; explanation: string }[] {
  const results: { text: string; explanation: string }[] = [];
  const explanationMap = new Map<number, string>();
  const lines = llmOutput.split('\n').filter(l => l.trim());

  for (const line of lines) {
    const match = line.match(/^\[(\d+)\]\s*(.+)/);
    if (match) {
      explanationMap.set(parseInt(match[1], 10), match[2].trim());
    }
  }

  for (let i = 0; i < originalSentences.length; i++) {
    const explanation = explanationMap.get(i + 1);
    if (explanation) {
      results.push({
        text: originalSentences[i].trim(),
        explanation,
      });
    }
  }

  if (results.length === 0 && originalSentences.length > 0) {
    results.push({
      text: originalSentences[0].trim(),
      explanation: llmOutput.replace(/^\[\d+\]\s*/gm, '').trim(),
    });
  }

  return results;
}
