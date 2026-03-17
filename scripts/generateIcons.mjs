#!/usr/bin/env node
import sharp from 'sharp';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';

const ROOT = resolve(import.meta.dirname, '..');
const PUBLIC_DIR = join(ROOT, 'public');
const ICONS_DIR = join(ROOT, 'src-tauri', 'icons');

const SOURCE_IMG = join(ROOT, 'assets', 'iconSource.png');

let sourceBuffer;
if (existsSync(SOURCE_IMG)) {
  sourceBuffer = readFileSync(SOURCE_IMG);
  console.log('[generateIcons] Using source image:', SOURCE_IMG);
} else {
  const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
    <circle cx="256" cy="256" r="256" fill="#0a0a0f"/>
    <text x="256" y="370" font-family="SF Pro Display, Inter, Helvetica Neue, Arial, sans-serif" font-size="340" font-weight="800" fill="#ffffff" text-anchor="middle" letter-spacing="-8">E</text>
  </svg>`;
  sourceBuffer = Buffer.from(SVG);
  console.log('[generateIcons] No source image found, using SVG fallback');
}

// Generate a circular (round) PNG with alpha-transparent corners.
// The source image is cropped to a perfect circle using SVG mask compositing.
async function generateRoundPNG(size, outputPath) {
  const r = Math.floor(size / 2);
  const circleMask = Buffer.from(
    `<svg width="${size}" height="${size}"><circle cx="${r}" cy="${r}" r="${r}" fill="white"/></svg>`
  );

  const resized = await sharp(sourceBuffer)
    .resize(size, size, { fit: 'cover' })
    .png()
    .toBuffer();

  await sharp(resized)
    .composite([{ input: circleMask, blend: 'dest-in' }])
    .png()
    .toFile(outputPath);

  console.log(`  OK: ${outputPath} (${size}x${size} round)`);
}

// Generate a circular PNG buffer (for ICO building)
async function generateRoundBuffer(size) {
  const r = Math.floor(size / 2);
  const circleMask = Buffer.from(
    `<svg width="${size}" height="${size}"><circle cx="${r}" cy="${r}" r="${r}" fill="white"/></svg>`
  );

  const resized = await sharp(sourceBuffer)
    .resize(size, size, { fit: 'cover' })
    .png()
    .toBuffer();

  return sharp(resized)
    .composite([{ input: circleMask, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

async function main() {
  console.log('[generateIcons] Creating round "E" logo icons...');

  const tauriSizes = [
    { size: 32, name: '32x32.png' },
    { size: 128, name: '128x128.png' },
    { size: 256, name: '128x128@2x.png' },
    { size: 256, name: 'icon.png' },
    { size: 30, name: 'Square30x30Logo.png' },
    { size: 44, name: 'Square44x44Logo.png' },
    { size: 71, name: 'Square71x71Logo.png' },
    { size: 89, name: 'Square89x89Logo.png' },
    { size: 107, name: 'Square107x107Logo.png' },
    { size: 142, name: 'Square142x142Logo.png' },
    { size: 150, name: 'Square150x150Logo.png' },
    { size: 284, name: 'Square284x284Logo.png' },
    { size: 310, name: 'Square310x310Logo.png' },
    { size: 50, name: 'StoreLogo.png' },
  ];

  for (const { size, name } of tauriSizes) {
    await generateRoundPNG(size, join(ICONS_DIR, name));
  }

  await generateRoundPNG(512, join(PUBLIC_DIR, 'logo.png'));
  await generateRoundPNG(192, join(PUBLIC_DIR, 'icon-192.png'));
  await generateRoundPNG(512, join(PUBLIC_DIR, 'icon-512.png'));
  await generateRoundPNG(32, join(PUBLIC_DIR, 'favicon.png'));

  // Build ICO with round icons at multiple resolutions
  const icoSizes = [16, 32, 48, 256];
  const icoPngs = [];
  for (const size of icoSizes) {
    const buf = await generateRoundBuffer(size);
    icoPngs.push({ size, buf });
  }
  const ico = buildICO(icoPngs);
  writeFileSync(join(ICONS_DIR, 'icon.ico'), ico);
  console.log('  OK: icon.ico (round)');
  writeFileSync(join(PUBLIC_DIR, 'favicon.ico'), ico);
  console.log('  OK: public/favicon.ico (round)');

  try {
    const iconsetDir = join(ICONS_DIR, 'icon.iconset');
    mkdirSync(iconsetDir, { recursive: true });

    const icnsSizes = [
      { size: 16, name: 'icon_16x16.png' },
      { size: 32, name: 'icon_16x16@2x.png' },
      { size: 32, name: 'icon_32x32.png' },
      { size: 64, name: 'icon_32x32@2x.png' },
      { size: 128, name: 'icon_128x128.png' },
      { size: 256, name: 'icon_128x128@2x.png' },
      { size: 256, name: 'icon_256x256.png' },
      { size: 512, name: 'icon_256x256@2x.png' },
      { size: 512, name: 'icon_512x512.png' },
      { size: 1024, name: 'icon_512x512@2x.png' },
    ];

    for (const { size, name } of icnsSizes) {
      await generateRoundPNG(size, join(iconsetDir, name));
    }

    execSync(`iconutil -c icns "${iconsetDir}" -o "${join(ICONS_DIR, 'icon.icns')}"`, { stdio: 'pipe' });
    execSync(`rm -rf "${iconsetDir}"`);
    console.log('  OK: icon.icns (round)');
  } catch (err) {
    console.warn('  WARN: Could not generate .icns:', err.message);
  }

  console.log('[generateIcons] Done. All icons are circular.');
}

function buildICO(images) {
  const headerSize = 6 + images.length * 16;
  const header = Buffer.alloc(headerSize);

  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  let offset = headerSize;
  const chunks = [header];

  for (let i = 0; i < images.length; i++) {
    const { size, buf } = images[i];
    const entryOffset = 6 + i * 16;

    header.writeUInt8(size < 256 ? size : 0, entryOffset);
    header.writeUInt8(size < 256 ? size : 0, entryOffset + 1);
    header.writeUInt8(0, entryOffset + 2);
    header.writeUInt8(0, entryOffset + 3);
    header.writeUInt16LE(1, entryOffset + 4);
    header.writeUInt16LE(32, entryOffset + 6);
    header.writeUInt32LE(buf.length, entryOffset + 8);
    header.writeUInt32LE(offset, entryOffset + 12);

    chunks.push(buf);
    offset += buf.length;
  }

  return Buffer.concat(chunks);
}

main().catch(err => {
  console.error('[generateIcons] Error:', err);
  process.exit(1);
});
