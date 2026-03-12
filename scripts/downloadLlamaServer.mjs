#!/usr/bin/env node
/**
 * Downloads the correct llama-server build for the current platform and GPU.
 *
 * GPU selection (matches Ollama/LM Studio approach):
 *   macOS          → Metal build (built-in)
 *   Windows NVIDIA → CUDA build + CUDA runtime DLLs (fastest)
 *   Windows AMD    → Vulkan build (universal GPU)
 *   Windows Intel  → Vulkan build
 *   Windows no GPU → CPU AVX2 build
 *   Linux          → Ubuntu build
 */
import { existsSync, mkdirSync, chmodSync, createWriteStream, statSync, readdirSync, renameSync, copyFileSync, unlinkSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';
import { pipeline } from 'stream/promises';

const ROOT = resolve(import.meta.dirname, '..');
const BIN_DIR = join(ROOT, 'src-tauri', 'binaries');
const LLAMA_CPP_VERSION = 'b4722';
const GITHUB_BASE = `https://github.com/ggerganov/llama.cpp/releases/download/${LLAMA_CPP_VERSION}`;

// ─── GPU Detection ───────────────────────────────────────────────────────────

function detectGpu() {
  if (process.platform === 'darwin') return 'metal';
  if (process.platform !== 'win32') {
    // Linux
    try { execSync('nvidia-smi', { stdio: 'pipe', timeout: 5000 }); return 'nvidia'; } catch {}
    try { execSync('rocminfo', { stdio: 'pipe', timeout: 5000 }); return 'amd'; } catch {}
    return 'cpu';
  }

  // Windows GPU detection — 3 methods for maximum compatibility

  // Method 1: nvidia-smi (NVIDIA driver tool, most reliable for NVIDIA)
  try {
    const out = execSync('nvidia-smi --query-gpu=name --format=csv,noheader', {
      encoding: 'utf8', stdio: 'pipe', timeout: 5000,
    }).trim();
    if (out) { console.log(`[GPU] NVIDIA (nvidia-smi): ${out}`); return 'nvidia'; }
  } catch {}

  // Method 2: PowerShell Get-CimInstance (modern Windows 10/11, works even if WMIC removed)
  try {
    const out = execSync(
      'powershell -NoProfile -NoLogo -Command "Get-CimInstance -ClassName Win32_VideoController | Select-Object -ExpandProperty Name"',
      { encoding: 'utf8', stdio: 'pipe', timeout: 10000 }
    );
    for (const line of out.split('\n').map(l => l.trim()).filter(Boolean)) {
      console.log(`[GPU] Found (PowerShell): ${line}`);
      if (/nvidia|geforce|rtx|gtx|quadro/i.test(line)) return 'nvidia';
      if (/radeon|amd/i.test(line)) return 'amd';
      if (/intel.*(?:arc|iris|uhd|hd)/i.test(line)) return 'intel';
    }
  } catch {}

  // Method 3: WMIC fallback (older Windows, deprecated but still works)
  try {
    const out = execSync('wmic path win32_VideoController get name', {
      encoding: 'utf8', stdio: 'pipe', timeout: 5000,
    });
    for (const line of out.split('\n').map(l => l.trim()).filter(l => l && l !== 'Name')) {
      console.log(`[GPU] Found (WMIC): ${line}`);
      if (/nvidia|geforce|rtx|gtx|quadro/i.test(line)) return 'nvidia';
      if (/radeon|amd/i.test(line)) return 'amd';
      if (/intel.*(?:arc|iris|uhd|hd)/i.test(line)) return 'intel';
    }
  } catch {}

  console.log('[GPU] No GPU detected by any method');
  return 'cpu';
}

// ─── Archive Selection ───────────────────────────────────────────────────────

function getDownloads(platformKey, gpu) {
  // Returns array of { url, description } to download
  const v = LLAMA_CPP_VERSION;

  const ARCHIVES = {
    'darwin-arm64': [{ url: `${GITHUB_BASE}/llama-${v}-bin-macos-arm64.zip`, desc: 'macOS ARM64 (Metal)' }],
    'darwin-x64':  [{ url: `${GITHUB_BASE}/llama-${v}-bin-macos-x64.zip`, desc: 'macOS x64' }],
    'linux-x64':   [{ url: `${GITHUB_BASE}/llama-${v}-bin-ubuntu-x64.zip`, desc: 'Linux x64' }],
  };

  if (ARCHIVES[platformKey]) return ARCHIVES[platformKey];

  if (platformKey === 'win32-x64') {
    switch (gpu) {
      case 'nvidia':
        return [
          { url: `${GITHUB_BASE}/llama-${v}-bin-win-cuda-cu12.4-x64.zip`, desc: 'Windows CUDA 12.4 (NVIDIA)' },
          { url: `${GITHUB_BASE}/cudart-llama-bin-win-cu12.4-x64.zip`, desc: 'CUDA Runtime DLLs' },
        ];
      case 'amd':
      case 'intel':
        return [
          { url: `${GITHUB_BASE}/llama-${v}-bin-win-vulkan-x64.zip`, desc: 'Windows Vulkan (AMD/Intel)' },
        ];
      default:
        return [
          { url: `${GITHUB_BASE}/llama-${v}-bin-win-avx2-x64.zip`, desc: 'Windows CPU (AVX2)' },
        ];
    }
  }

  return null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TRIPLES = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64':   'x86_64-apple-darwin',
  'linux-x64':    'x86_64-unknown-linux-gnu',
  'win32-x64':    'x86_64-pc-windows-msvc',
};

const LIB_EXT = { darwin: '.dylib', linux: '.so', win32: '.dll' }[process.platform] || '.so';

function moveFile(src, dest) {
  try { renameSync(src, dest); } catch { copyFileSync(src, dest); unlinkSync(src); }
}

function findFileRecursive(dir, filename) {
  if (!existsSync(dir)) return null;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isFile() && e.name === filename) return full;
    if (e.isDirectory()) { const f = findFileRecursive(full, filename); if (f) return f; }
  }
  return null;
}

function findAllByExt(dir, ext) {
  const r = [];
  if (!existsSync(dir)) return r;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isFile() && e.name.endsWith(ext)) r.push(full);
    else if (e.isDirectory()) r.push(...findAllByExt(full, ext));
  }
  return r;
}

async function downloadAndExtract(url, desc, tmpDir) {
  console.log(`[download] ${desc}`);
  console.log(`[download] URL: ${url}`);

  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${desc}`);

  const zipPath = join(tmpDir, 'archive.zip');
  await pipeline(response.body, createWriteStream(zipPath));

  const extractDir = join(tmpDir, 'extract_' + Math.random().toString(36).slice(2));
  mkdirSync(extractDir, { recursive: true });

  if (process.platform === 'win32') {
    execSync(`tar -xf "${zipPath}" -C "${extractDir}"`, { stdio: 'pipe' });
  } else {
    execSync(`unzip -o "${zipPath}" -d "${extractDir}"`, { stdio: 'pipe' });
  }

  rmSync(zipPath, { force: true });
  return extractDir;
}

// ─── Main ────────────────────────────────────────────────────────────────────

const platformKey = `${process.platform}-${process.arch}`;
const triple = TRIPLES[platformKey];
if (!triple) { console.error(`Unsupported: ${platformKey}`); process.exit(1); }

const gpu = detectGpu();
const downloads = getDownloads(platformKey, gpu);
if (!downloads) { console.error(`No archive for ${platformKey}`); process.exit(1); }

const ext = process.platform === 'win32' ? '.exe' : '';
const binaryName = `llama-server${ext}`;
const outputPath = join(BIN_DIR, `llama-server-${triple}${ext}`);

// Skip if already set up correctly for the DETECTED GPU
if (existsSync(outputPath) && statSync(outputPath).size > 1000) {
  const libs = readdirSync(BIN_DIR).filter(f => f.endsWith(LIB_EXT));
  // Check for the SPECIFIC backend that matches the detected GPU.
  // NVIDIA must have cuda libs, not just vulkan. AMD needs vulkan or rocm.
  const hasCorrectBackend = (() => {
    if (gpu === 'cpu' || gpu === 'metal') return libs.length > 0;
    if (gpu === 'nvidia') return libs.some(f => f.includes('cuda'));
    if (gpu === 'amd') return libs.some(f => f.includes('vulkan') || f.includes('rocm'));
    if (gpu === 'intel') return libs.some(f => f.includes('vulkan'));
    return libs.length > 0;
  })();
  if (libs.length > 0 && hasCorrectBackend) {
    console.log(`[downloadLlamaServer] Already installed (${gpu} backend): ${outputPath}`);
    process.exit(0);
  }
  console.log(`[downloadLlamaServer] Binary exists but ${gpu} backend libs missing, re-downloading...`);
}

mkdirSync(BIN_DIR, { recursive: true });

console.log(`[downloadLlamaServer] Platform: ${platformKey} | GPU: ${gpu} | Downloads: ${downloads.length}`);

try {
  const tmpDir = join(BIN_DIR, '_download_tmp');
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  // Download all archives (main build + optional CUDA runtime)
  const extractDirs = [];
  for (const dl of downloads) {
    const dir = await downloadAndExtract(dl.url, dl.desc, tmpDir);
    extractDirs.push(dir);
  }

  // Find and install llama-server binary (from the first/main archive)
  const foundBinary = findFileRecursive(extractDirs[0], binaryName);
  if (!foundBinary) throw new Error(`${binaryName} not found in archive`);
  moveFile(foundBinary, outputPath);
  console.log(`[downloadLlamaServer] Installed binary: ${outputPath}`);

  // Find and install ALL shared libraries from ALL archives
  let libCount = 0;
  for (const dir of extractDirs) {
    for (const libPath of findAllByExt(dir, LIB_EXT)) {
      const libName = libPath.split(/[\\/]/).pop();
      if (process.platform !== 'win32' && !libName.startsWith('lib')) continue;
      moveFile(libPath, join(BIN_DIR, libName));
      console.log(`[downloadLlamaServer] Installed lib: ${libName}`);
      libCount++;
    }
  }

  // Set permissions on Unix
  if (process.platform !== 'win32') {
    chmodSync(outputPath, 0o755);
    for (const f of readdirSync(BIN_DIR)) {
      if (f.endsWith(LIB_EXT)) chmodSync(join(BIN_DIR, f), 0o755);
    }
  }

  // Cleanup
  rmSync(tmpDir, { recursive: true, force: true });

  // Validate
  const finalSize = statSync(outputPath).size;
  if (finalSize < 1000) throw new Error(`Binary too small: ${finalSize} bytes`);

  const installedLibs = readdirSync(BIN_DIR).filter(f => f.endsWith(LIB_EXT));
  console.log(`\n[downloadLlamaServer] ═══════════════════════════════════════`);
  console.log(`[downloadLlamaServer] Platform:  ${platformKey}`);
  console.log(`[downloadLlamaServer] GPU:       ${gpu.toUpperCase()}`);
  console.log(`[downloadLlamaServer] Binary:    ${outputPath} (${(finalSize / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`[downloadLlamaServer] Libraries: ${libCount} (${installedLibs.join(', ')})`);

  if (installedLibs.some(f => f.includes('cuda')))
    console.log(`[downloadLlamaServer] Backend:   CUDA (NVIDIA GPU — maximum performance)`);
  else if (installedLibs.some(f => f.includes('vulkan')))
    console.log(`[downloadLlamaServer] Backend:   Vulkan (GPU accelerated)`);
  else if (process.platform === 'darwin')
    console.log(`[downloadLlamaServer] Backend:   Metal (Apple GPU)`);
  else
    console.log(`[downloadLlamaServer] Backend:   CPU only`);

  console.log(`[downloadLlamaServer] ═══════════════════════════════════════\n`);
} catch (err) {
  console.error(`[downloadLlamaServer] Error: ${err.message}`);
  console.error(`\nManual download: https://github.com/ggml-org/llama.cpp/releases/tag/${LLAMA_CPP_VERSION}`);
  console.error(`Place binary at: ${outputPath}`);
  process.exit(1);
}
