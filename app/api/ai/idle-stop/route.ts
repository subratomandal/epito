import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Called by llm.ts idle timer to stop llama-server and release memory.
// Invokes the Tauri stop_llama_idle command via the global Tauri bridge.
export async function POST() {
  try {
    // In production, this runs inside Tauri's Node.js runtime.
    // We can't directly call Tauri invoke from server-side,
    // so we signal via a file that the Rust side can watch,
    // or we kill via the llama-server process directly.
    const llamaPort = process.env.LLAMA_SERVER_PORT || '8080';

    // Tell llama-server to unload model (frees GPU VRAM)
    await fetch(`http://127.0.0.1:${llamaPort}/slots/0?action=erase`, {
      method: 'POST',
      signal: AbortSignal.timeout(3000),
    }).catch(() => {});

    // Write a signal file that the Rust idle watcher can pick up
    const fs = await import('fs');
    const path = await import('path');
    const signalDir = process.env.EPITO_DATA_DIR || path.resolve(process.cwd(), 'data');
    fs.mkdirSync(signalDir, { recursive: true });
    fs.writeFileSync(path.join(signalDir, '.idle-stop'), Date.now().toString());

    return NextResponse.json({ status: 'idle_stop_signaled' });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
