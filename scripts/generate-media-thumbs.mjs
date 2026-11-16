#!/usr/bin/env node
/**
 * Generate list-row thumbnails beside product / vehicle / user images.
 *
 * For each image.<ext> writes image.thumb.jpg (max 96×96, ImageMagick `convert`).
 *
 * Usage:
 *   DATA_ROOT=... node scripts/generate-media-thumbs.mjs
 *   node scripts/generate-media-thumbs.mjs --dry-run --only=products
 *   node scripts/generate-media-thumbs.mjs --size=96 --force
 *
 * Env: DATA_ROOT (from repo .env)
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

for (const line of readFileSync(join(REPO_ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i < 1) continue;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1);
}

function argValue(flag) {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1).trim() : '';
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const SKIP_NAME = /\.thumb\.(jpe?g|png|webp|gif)$/i;

function listFilesRecursive(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) listFilesRecursive(abs, out);
    else if (st.isFile()) out.push(abs);
  }
  return out;
}

function thumbPathFor(abs) {
  const ext = extname(abs);
  const base = abs.slice(0, abs.length - ext.length);
  return `${base}.thumb.jpg`;
}

function findConvert() {
  for (const bin of ['convert', 'magick']) {
    const r = spawnSync(bin, ['-version'], { encoding: 'utf8' });
    if (r.status === 0) return bin;
  }
  return null;
}

function makeThumb(convertBin, src, dest, size) {
  const args =
    convertBin === 'magick'
      ? [
          src,
          '-auto-orient',
          '-thumbnail',
          `${size}x${size}>`,
          '-strip',
          '-quality',
          '82',
          dest,
        ]
      : [
          src,
          '-auto-orient',
          '-thumbnail',
          `${size}x${size}>`,
          '-strip',
          '-quality',
          '82',
          dest,
        ];
  const r = spawnSync(convertBin, args, { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error((r.stderr || r.stdout || `convert failed (${r.status})`).trim().slice(0, 240));
  }
}

async function main() {
  const dataRoot = process.env.DATA_ROOT || '';
  if (!dataRoot) throw new Error('DATA_ROOT required');
  const dryRun = hasFlag('--dry-run');
  const force = hasFlag('--force');
  const size = Math.max(48, Math.min(256, Number(argValue('--size') || '96') || 96));
  const only = String(argValue('--only') || 'all').toLowerCase();

  const convertBin = findConvert();
  if (!convertBin) {
    throw new Error('ImageMagick `convert` / `magick` not found — install imagemagick');
  }

  const roots = [];
  if (only === 'all' || only === 'products') roots.push(join(dataRoot, 'media/yesgatc/products'));
  if (only === 'all' || only === 'vehicles' || only === 'cars') {
    roots.push(join(dataRoot, 'media/yesgatc/vehicles'));
  }
  if (only === 'all' || only === 'users' || only === 'vct') {
    roots.push(join(dataRoot, 'media/yesgatc/users'));
  }

  const stats = {
    dryRun,
    force,
    size,
    convertBin,
    considered: 0,
    created: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  const stemAllow = new Set(['image', 'photo', 'profile', 'scale_image']);

  for (const root of roots) {
    for (const abs of listFilesRecursive(root)) {
      const ext = extname(abs).toLowerCase();
      if (!IMAGE_EXTS.has(ext)) continue;
      if (SKIP_NAME.test(abs)) continue;
      const base = abs.slice(0, abs.length - ext.length);
      const stem = base.split(/[/\\]/).pop() || '';
      // Only primary catalogue / vehicle / profile images.
      if (!stemAllow.has(stem)) continue;
      const dest = thumbPathFor(abs);
      stats.considered += 1;
      if (!force && existsSync(dest) && statSync(dest).size >= 32) {
        stats.skipped += 1;
        continue;
      }
      if (dryRun) {
        stats.created += 1;
        continue;
      }
      try {
        mkdirSync(dirname(dest), { recursive: true });
        makeThumb(convertBin, abs, dest, size);
        stats.created += 1;
      } catch (error) {
        stats.failed += 1;
        stats.errors.push({ src: abs, error: error.message });
      }
    }
  }

  try {
    mkdirSync(join(REPO_ROOT, '.tmp'), { recursive: true });
    writeFileSync(
      join(REPO_ROOT, '.tmp', 'media-thumbs.progress'),
      `${JSON.stringify({ t: new Date().toISOString(), ...stats })}\n`,
    );
  } catch {
    /* ignore */
  }

  console.log(JSON.stringify(stats, null, 2));
  if (stats.failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
