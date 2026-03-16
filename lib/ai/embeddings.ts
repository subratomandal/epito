import path from 'path';

let embedder: unknown = null;
let initPromise: Promise<void> | null = null;

export const EMBEDDING_DIM = 384;

export async function initEmbeddings(): Promise<void> {
  if (embedder) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const { pipeline, env } = await import('@xenova/transformers') as {
      pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<unknown>;
      env: { cacheDir: string; allowLocalModels: boolean; allowRemoteModels: boolean };
    };

    env.cacheDir = process.env.EPITO_DATA_DIR ? path.resolve(process.env.EPITO_DATA_DIR, 'models') : path.resolve(process.cwd(), 'data', 'models');
    env.allowLocalModels = true;
    env.allowRemoteModels = true;

    embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      quantized: true,
    });

    console.log('[AI] Embedding model loaded');
  })();

  return initPromise;
}

export async function generateEmbedding(text: string): Promise<number[]> {
  await initEmbeddings();

  const truncated = text.slice(0, 2000);

  // 30-second timeout per embedding to prevent infinite hangs
  const result = await Promise.race([
    (embedder as (text: string, opts: Record<string, unknown>) => Promise<{ data: Float32Array }>)(
      truncated,
      { pooling: 'mean', normalize: true }
    ),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Embedding generation timed out (30s)')), 30000)
    ),
  ]);

  return Array.from(result.data);
}

export function isReady(): boolean {
  return embedder !== null;
}
