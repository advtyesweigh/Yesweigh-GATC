/**
 * VPS local media helpers (DATA_ROOT/media/yesgatc/…).
 * Single-file multipart parse without extra deps.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

export const DEFAULT_MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

export function isLocalMediaPath(filePath) {
  if (typeof filePath !== 'string') return false;
  const trimmed = filePath.trim().replace(/\\/g, '/');
  return trimmed.startsWith('media/yesgatc/');
}

export function resolveSafeMediaPath(dataRoot, relPath) {
  if (!dataRoot || !isLocalMediaPath(relPath)) return null;
  const normalized = String(relPath).trim().replace(/\\/g, '/');
  if (normalized.includes('..')) return null;
  const abs = path.resolve(dataRoot, normalized);
  const root = path.resolve(dataRoot);
  if (abs !== root && !abs.startsWith(`${root}${path.sep}`)) return null;
  return abs;
}

export function contentTypeForMediaPath(abs, fallback = 'application/octet-stream') {
  const lower = String(abs || '').toLowerCase();
  if (/\.(jpe?g)$/.test(lower)) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  return fallback;
}

export function extForUpload({ contentType, filename, fallback = '.jpg' } = {}) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('jpeg') || ct.includes('jpg')) return '.jpg';
  if (ct.includes('png')) return '.png';
  if (ct.includes('webp')) return '.webp';
  if (ct.includes('gif')) return '.gif';
  if (ct.includes('pdf')) return '.pdf';
  const fromName = path.extname(String(filename || '').split('?')[0] || '').toLowerCase();
  if (fromName && fromName.length <= 5 && /^\.[a-z0-9]+$/.test(fromName)) return fromName;
  return fallback;
}

/**
 * Parse a single multipart/form-data file field (default name: file).
 * @returns {Promise<{ buffer: Buffer, filename: string, contentType: string, fieldName: string }>}
 */
export async function readSingleMultipartFile(req, {
  fieldName = 'file',
  maxBytes = DEFAULT_MAX_UPLOAD_BYTES,
} = {}) {
  const contentTypeHeader = String(req.headers['content-type'] || '');
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentTypeHeader);
  if (!boundaryMatch) {
    const err = new Error('Expected multipart/form-data with a file field');
    err.status = 400;
    err.code = 'BAD_REQUEST';
    throw err;
  }
  const boundary = (boundaryMatch[1] || boundaryMatch[2] || '').trim();
  if (!boundary) {
    const err = new Error('Invalid multipart boundary');
    err.status = 400;
    err.code = 'BAD_REQUEST';
    throw err;
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes + 64 * 1024) {
      const err = new Error(`File too large (max ${Math.round(maxBytes / (1024 * 1024))} MB)`);
      err.status = 413;
      err.code = 'PAYLOAD_TOO_LARGE';
      throw err;
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  const parts = splitMultipart(body, boundary);
  for (const part of parts) {
    if (!part.headers['content-disposition']) continue;
    const disp = part.headers['content-disposition'];
    const nameMatch = /name="([^"]+)"/i.exec(disp);
    const fileMatch = /filename="([^"]*)"/i.exec(disp);
    const name = nameMatch ? nameMatch[1] : '';
    if (name !== fieldName || !fileMatch) continue;
    const filename = fileMatch[1] || 'upload.bin';
    const ct = part.headers['content-type'] || 'application/octet-stream';
    if (part.data.length > maxBytes) {
      const err = new Error(`File too large (max ${Math.round(maxBytes / (1024 * 1024))} MB)`);
      err.status = 413;
      err.code = 'PAYLOAD_TOO_LARGE';
      throw err;
    }
    if (part.data.length < 8) {
      const err = new Error('Empty or invalid file');
      err.status = 400;
      err.code = 'VALIDATION';
      throw err;
    }
    return {
      buffer: part.data,
      filename,
      contentType: ct,
      fieldName: name,
    };
  }
  const err = new Error(`Missing file field "${fieldName}"`);
  err.status = 400;
  err.code = 'VALIDATION';
  throw err;
}

function splitMultipart(body, boundary) {
  const delim = Buffer.from(`--${boundary}`);
  const parts = [];
  let start = indexOfBuffer(body, delim, 0);
  if (start < 0) return parts;
  start += delim.length;
  // skip leading CRLF after first boundary
  if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;
  while (start < body.length) {
    const next = indexOfBuffer(body, delim, start);
    if (next < 0) break;
    let sliceEnd = next;
    // trim trailing CRLF before next boundary
    if (sliceEnd >= 2 && body[sliceEnd - 2] === 0x0d && body[sliceEnd - 1] === 0x0a) {
      sliceEnd -= 2;
    }
    const partBuf = body.subarray(start, sliceEnd);
    const headerEnd = indexOfBuffer(partBuf, Buffer.from('\r\n\r\n'), 0);
    if (headerEnd >= 0) {
      const headerText = partBuf.subarray(0, headerEnd).toString('utf8');
      const data = partBuf.subarray(headerEnd + 4);
      const headers = {};
      for (const line of headerText.split(/\r\n/)) {
        const i = line.indexOf(':');
        if (i > 0) {
          headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
        }
      }
      // closing boundary starts with --
      const peek = body.subarray(next + delim.length, next + delim.length + 2).toString('ascii');
      if (peek === '--') {
        parts.push({ headers, data });
        break;
      }
      parts.push({ headers, data });
    }
    start = next + delim.length;
    if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;
  }
  return parts;
}

function indexOfBuffer(haystack, needle, from = 0) {
  return haystack.indexOf(needle, from);
}

/**
 * Atomically write buffer to DATA_ROOT/<relPath>, replacing any prior stem.*.
 * @returns {{ relPath: string, absPath: string, bytes: number }}
 */
export function writeMediaFile(dataRoot, relPath, buffer) {
  if (!dataRoot) {
    const err = new Error('DATA_ROOT is not configured');
    err.status = 503;
    err.code = 'DATA_UNCONFIGURED';
    throw err;
  }
  if (!isLocalMediaPath(relPath)) {
    const err = new Error('Invalid media path');
    err.status = 400;
    err.code = 'VALIDATION';
    throw err;
  }
  const abs = resolveSafeMediaPath(dataRoot, relPath);
  if (!abs) {
    const err = new Error('Invalid media path');
    err.status = 400;
    err.code = 'VALIDATION';
    throw err;
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.part`;
  fs.writeFileSync(tmp, buffer);
  fs.renameSync(tmp, abs);
  return { relPath: relPath.replace(/\\/g, '/'), absPath: abs, bytes: buffer.length };
}

/** Remove local media file + optional .thumb.jpg sibling when path is under media/yesgatc/. */
export function removeLocalMediaFile(dataRoot, relPath) {
  const abs = resolveSafeMediaPath(dataRoot, relPath);
  if (!abs) return false;
  let removed = false;
  try {
    if (fs.existsSync(abs)) {
      fs.unlinkSync(abs);
      removed = true;
    }
  } catch {
    /* best-effort */
  }
  try {
    const ext = path.extname(abs);
    const thumb = `${abs.slice(0, abs.length - ext.length)}.thumb.jpg`;
    if (fs.existsSync(thumb)) fs.unlinkSync(thumb);
  } catch {
    /* best-effort */
  }
  return removed;
}

/** Remove prior files for the same stem in a directory (logo.png → also drop logo.jpg). */
export function clearMediaStem(dataRoot, relDir, stem) {
  if (!dataRoot || !isLocalMediaPath(relDir)) return;
  const absDir = resolveSafeMediaPath(dataRoot, relDir);
  if (!absDir || !fs.existsSync(absDir)) return;
  let entries = [];
  try {
    entries = fs.readdirSync(absDir);
  } catch {
    return;
  }
  const prefix = `${stem}.`;
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    if (name.endsWith('.part')) continue;
    try {
      fs.unlinkSync(path.join(absDir, name));
    } catch {
      /* ignore */
    }
  }
}

export async function downloadRemoteToMedia(dataRoot, url, relPath) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      Accept: 'image/*,application/pdf,*/*',
      'User-Agent': 'gatc-vps-media-migrate/1.0',
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const abs = resolveSafeMediaPath(dataRoot, relPath);
  if (!abs) throw new Error('Invalid media path');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.part`;
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(tmp));
  const size = fs.statSync(tmp).size;
  if (size < 32) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw new Error(`file too small (${size} bytes)`);
  }
  fs.renameSync(tmp, abs);
  return { size, contentType: response.headers.get('content-type') || '' };
}
