# Epito threat model

Repository: `subratomandal/epito`. No infrastructure repository: Epito is a desktop app, nothing is deployed to servers (confirmed by the user). No `SECURITY_MODEL.md` existed; the README "Privacy And Security Features" section and `docs/ARCHITECTURE.md` were used.

## System overview and trust boundaries

Epito is a local-first, single-user note and document app shipped as a Tauri v2 desktop app (macOS, Windows, Linux).

- The Rust shell (`src-tauri/src/lib.rs`) spawns a bundled Node.js running the Next.js standalone server on `127.0.0.1:<free port>` (`HOSTNAME=127.0.0.1`, `EPITO_DATA_DIR=~/.epito/data`), then navigates the webview to `http://127.0.0.1:<port>`.
- The Next.js API (`app/api/**`) has **no authentication**. Its only protections are loopback binding and an Origin/Referer check on non-GET requests in `middleware.ts` (requests with no Origin and no Referer are allowed). GET routes are unchecked; the `Host` header is not validated (DNS-rebinding surface).
- The webview runs with `withGlobalTauri: true` and capability `src-tauri/capabilities/default.json` granting `shell:allow-execute`, `shell:allow-open`, `dialog:default`, plus custom commands (`download_model`, `start_llama_lazy`, `save_file_with_dialog`, ...). Script execution in the app origin can therefore reach native commands. CSP allows `'unsafe-inline'` scripts.
- `llama-server` (llama.cpp) runs on `127.0.0.1:<port>`, started/stopped via signal files in the data dir (`.idle-start`, `.idle-stop`, `.idle-kv-clear`) polled by Rust.
- Headless Chrome/Edge (`puppeteer-core`, `--no-sandbox`) renders caller-supplied note HTML for PDF/PNG export (`app/api/export/*`).
- Optional PaddleOCR runs as a Python subprocess (`inference/ocr.ts` -> `scripts/paddleOcr.py`).
- Dev mode (`npm run dev`) serves on `127.0.0.1:3000`; the user keeps it **in scope**.

Trust boundaries: browser/other web origins -> localhost API; imported files and pasted content -> parsers, editor, LLM; LLM output -> UI/actions; webview JS -> Tauri IPC/native; network -> model and binary downloads; other local users/processes -> loopback ports and `~/.epito`.

## Components

| Component | Code |
|---|---|
| Desktop Shell | `src-tauri/**` (lib.rs, llama_server.rs, model.rs, native_win.rs, capabilities, tauri*.conf.json) |
| Local API | `app/api/**` (except export/upload/attachments/ai), `middleware.ts` |
| Web UI | `app/page.tsx`, `app/layout.tsx`, `components/**`, `public/**` (incl. `sw.js`) |
| Ingestion & OCR | `app/api/upload/**`, `app/api/attachments/**`, `app/api/images/**`, `app/api/documents/**`, `inference/ocr.ts`, `scripts/paddleOcr.py` |
| Export | `app/api/export/**`, `inference/export.ts`, `inference/browser.ts` |
| AI & Retrieval | `model/**`, `app/api/ai/**`, `inference/pipeline.ts`, `inference/lifecycle.ts`, `memory/**`, `app/api/search`, `app/api/graph`, `app/api/topics` |
| Storage | `notes/database.ts`, `notes/encryption.ts`, `common/**` |
| Build & Supply Chain | `scripts/**` (except paddleOcr.py), `package.json`, `package-lock.json`, `src-tauri/Cargo.*`, `src-tauri/binaries/**`, model download URL in `src-tauri/src/model.rs` |

## Entry points and who can reach them

- Localhost HTTP API (Next.js, every `app/api` route incl. `POST /api/shutdown`, `GET /api/settings?key=`, uploads, export): any local process or user; any web page in the user's browser via CSRF / no-cors requests / DNS rebinding.
- llama-server HTTP on loopback: any local process; web pages via rebinding.
- Imported files: PDF, DOCX, PNG/JPG (upload), TXT/MD/PDF/DOCX/images (attachments), parsed by pdf-parse, mammoth, sharp, tesseract.js, PaddleOCR.
- Note HTML from the TipTap editor (pasted content) -> stored in SQLite -> rendered in UI and in headless Chrome export.
- LLM prompts built from note/document/OCR text (`model/llm.ts`, `model/answer-engine.ts`) and LLM output rendered in the AI panel.
- Tauri IPC from the webview (custom commands + shell plugin).
- Network downloads: Mistral GGUF from Hugging Face (`MODEL_URL`, no checksum), llama-server binaries (`scripts/downloadLlamaServer.mjs`), Node runtime (`scripts/downloadNode.mjs`), embedding model via `@xenova/transformers`.
- Filesystem: `~/.epito/data` (SQLite, uploads, `encryption.key`, signal files), `~/.epito/models`, `~/.epito/theme`.

## Assets (user: all equally important)

- Code execution / integrity of the user's machine (native command execution via Tauri shell, subprocesses, headless browser).
- Encryption key (`~/.epito/data/encryption.key`) and stored settings.
- Note, document, image and OCR contents, embeddings and chunk caches (confidentiality and integrity).
- Availability of the app (shutdown endpoint, process control).

## Attacker profiles (user: all in scope, rule nothing out)

1. Malicious websites in the user's browser attacking the localhost API or llama-server (CSRF, DNS rebinding, port scanning).
2. Malicious documents/images/pasted content the user imports (parser bugs, stored XSS in notes, path tricks).
3. Prompt injection: content from remote/cloud sources (documents, web pages pasted or imported) that steers the local LLM into reaching local actions or leaking data. The user explicitly asked to check every path from remote prompt injection to local impact.
4. Other users or processes on the same machine (loopback ports, files in `~/.epito`, signal files).
5. Network and supply-chain attackers (unverified model download, bundled/downloaded binaries, npm/cargo dependencies).

## Existing controls

- Loopback binding for Node and llama-server; Origin/Referer CSRF check for mutating API calls (`middleware.ts`), repeated in `/api/shutdown`.
- Security headers + CSP (`middleware.ts`, `tauri.conf.json`), though `script-src 'unsafe-inline'`.
- Upload extension allowlists, size limits (50MB upload / 20MB attachments / 1MB other), UUID storage names, filename regex on `/api/upload/[filename]`, `path.basename` on deletes.
- Settings write allowlist (`note-order`, `sidebar-collapsed`, `insight-collapsed`, theme).
- AES-256-GCM for sensitive settings, key file mode 0600.
- Parameterized SQLite queries (dynamic SET clauses built from fixed column names).
- Task concurrency limit for AI routes.

## Out of scope / accepted risk

The user put **nothing** out of scope and accepts no risk categories: every attacker and asset above is in scope, including dev mode.

## Open questions

- Is the Tauri `shell:allow-execute` permission needed at runtime, and is it scoped in the shell plugin config?
- Should GET API routes (notes, documents, settings) also require an origin/host check or a per-launch token?
