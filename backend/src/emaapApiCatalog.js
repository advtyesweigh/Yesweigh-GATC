import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Structured eMaap (gatcapi) HTTP API catalog — v1 + v2.
 * Prefers $DATA_ROOT/emaap/api-catalog.json; falls back to bundled backend/data/emaap/api-catalog.json.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_PATH = path.resolve(__dirname, '../data/emaap/api-catalog.json');
const FILE_NAME = 'api-catalog.json';

export function resolveEmaapApiCatalogPath(dataRoot) {
  const root = String(dataRoot || '').trim();
  if (root) return path.resolve(root, 'emaap', FILE_NAME);
  return path.resolve(process.cwd(), 'data', 'emaap', FILE_NAME);
}

function normalizeEndpoint(row) {
  if (!row || typeof row !== 'object') return null;
  const method = String(row.method || 'GET').trim().toUpperCase() || 'GET';
  const apiPath = String(row.path || row.url || '').trim();
  if (!apiPath) return null;
  return {
    method,
    path: apiPath,
    description: String(row.description || row.purpose || '').trim(),
  };
}

function normalizeCatalog(raw, { sourcePath = null } = {}) {
  const baseUrl = String(raw?.baseUrl || 'https://emaap.gov.in/gatcapi').replace(/\/+$/, '');
  const v1 = (Array.isArray(raw?.v1) ? raw.v1 : []).map(normalizeEndpoint).filter(Boolean);
  const v2 = (Array.isArray(raw?.v2) ? raw.v2 : []).map(normalizeEndpoint).filter(Boolean);
  return {
    version: Number(raw?.version) || 1,
    source: String(raw?.source || '').trim() || null,
    updatedAt: String(raw?.updatedAt || '').trim() || null,
    baseUrl,
    notes: Array.isArray(raw?.notes) ? raw.notes.map((n) => String(n)).filter(Boolean) : [],
    counts: { v1: v1.length, v2: v2.length, total: v1.length + v2.length },
    v1,
    v2,
    sourcePath: sourcePath || null,
  };
}

function readJsonFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(text);
}

/**
 * @param {{ dataRoot?: string, catalogPath?: string }} opts
 */
export function getEmaapApiCatalog(opts = {}) {
  const candidates = [];
  if (opts.catalogPath) candidates.push(path.resolve(opts.catalogPath));
  candidates.push(resolveEmaapApiCatalogPath(opts.dataRoot));
  candidates.push(BUNDLED_PATH);

  const tried = [];
  for (const filePath of candidates) {
    if (!filePath || tried.includes(filePath)) continue;
    tried.push(filePath);
    try {
      if (!fs.existsSync(filePath)) continue;
      const raw = readJsonFile(filePath);
      return normalizeCatalog(raw, { sourcePath: filePath });
    } catch (error) {
      // try next candidate
      if (filePath === BUNDLED_PATH) {
        throw new Error(`Could not load eMaap API catalog: ${error.message}`);
      }
    }
  }

  throw new Error('eMaap API catalog not found');
}
