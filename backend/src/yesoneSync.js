import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const STATUS_FILE = 'sync-status.json';
const LOCK_FILE = 'sync.lock';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SYNC_SCRIPT = path.resolve(__dirname, '../../scripts/sync-yesgatc.mjs');

export function resolveYesoneSyncStatusPath(dataRoot) {
  const root = String(dataRoot || '').trim();
  if (root) return path.resolve(root, 'yesone', STATUS_FILE);
  return path.resolve(process.cwd(), 'data', 'yesone', STATUS_FILE);
}

export function resolveYesoneSyncLockPath(dataRoot) {
  const root = String(dataRoot || '').trim();
  if (root) return path.resolve(root, 'yesone', LOCK_FILE);
  return path.resolve(process.cwd(), 'data', 'yesone', LOCK_FILE);
}

function emptyStatus() {
  return {
    running: false,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastRun: null,
  };
}

export function readYesoneSyncStatus(opts = {}) {
  const filePath = opts.statusPath
    ? path.resolve(opts.statusPath)
    : resolveYesoneSyncStatusPath(opts.dataRoot);
  try {
    if (!fs.existsSync(filePath)) {
      return { ...emptyStatus(), path: filePath, source: 'missing' };
    }
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      ...emptyStatus(),
      ...raw,
      path: filePath,
      source: 'file',
    };
  } catch (error) {
    return {
      ...emptyStatus(),
      path: filePath,
      source: 'error',
      lastError: error.message,
    };
  }
}

export function writeYesoneSyncStatus(status, opts = {}) {
  const filePath = opts.statusPath
    ? path.resolve(opts.statusPath)
    : resolveYesoneSyncStatusPath(opts.dataRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = {
    ...emptyStatus(),
    ...status,
    updatedAt: new Date().toISOString(),
  };
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  return { ...payload, path: filePath, source: 'file' };
}

export function isYesoneSyncLockAlive(opts = {}) {
  const lockPath = opts.lockPath
    ? path.resolve(opts.lockPath)
    : resolveYesoneSyncLockPath(opts.dataRoot);
  try {
    if (!fs.existsSync(lockPath)) return false;
    const raw = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const pid = Number(raw?.pid);
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
      return false;
    }
  } catch {
    return false;
  }
}

/**
 * Trigger a background sync. Prefer systemd oneshot when available.
 * Returns public status snapshot.
 */
export function triggerYesoneSyncNow(opts = {}) {
  const dataRoot = opts.dataRoot || '';
  const statusPath = resolveYesoneSyncStatusPath(dataRoot);
  const lockPath = resolveYesoneSyncLockPath(dataRoot);
  const scriptPath = opts.scriptPath || DEFAULT_SYNC_SCRIPT;

  if (isYesoneSyncLockAlive({ lockPath })) {
    const err = new Error('Yesgatc sync is already running');
    err.code = 'SYNC_BUSY';
    throw err;
  }

  const status = readYesoneSyncStatus({ statusPath });
  if (status.running && isYesoneSyncLockAlive({ lockPath })) {
    const err = new Error('Yesgatc sync is already running');
    err.code = 'SYNC_BUSY';
    throw err;
  }

  writeYesoneSyncStatus(
    {
      ...status,
      running: true,
      lastStartedAt: new Date().toISOString(),
      lastError: null,
      trigger: opts.trigger || 'manual',
    },
    { statusPath },
  );

  const repoRoot = path.resolve(path.dirname(scriptPath), '..');
  const unitPath = '/etc/systemd/system/gatc-yesgatc-sync.service';
  const useSystemd = opts.preferSystemd !== false
    && fs.existsSync('/bin/systemctl')
    && fs.existsSync(unitPath);

  function spawnNodeSync() {
    if (!fs.existsSync(scriptPath)) {
      const err = new Error(`Sync script missing: ${scriptPath}`);
      err.code = 'SYNC_MISSING';
      throw err;
    }
    const child = spawn(process.execPath, [scriptPath, '--trigger=manual'], {
      detached: true,
      stdio: 'ignore',
      cwd: repoRoot,
      env: {
        ...process.env,
        DATA_ROOT: dataRoot || process.env.DATA_ROOT || '',
      },
    });
    child.unref();
  }

  if (useSystemd) {
    const child = spawn(
      'systemctl',
      ['start', '--no-block', 'gatc-yesgatc-sync.service'],
      {
        detached: true,
        stdio: 'ignore',
        cwd: repoRoot,
      },
    );
    child.on('error', () => {
      try {
        spawnNodeSync();
      } catch {
        /* status file will show failure when job never starts */
      }
    });
    child.unref();
  } else {
    spawnNodeSync();
  }

  return readYesoneSyncStatus({ statusPath });
}

export function publicYesoneSyncStatus(status, opts = {}) {
  const s = status || emptyStatus();
  const running = Boolean(s.running) || isYesoneSyncLockAlive(opts);
  const lastRun = s.lastRun && typeof s.lastRun === 'object' ? s.lastRun : null;
  return {
    running,
    lastStartedAt: s.lastStartedAt || null,
    lastFinishedAt: s.lastFinishedAt || null,
    lastSuccessAt: s.lastSuccessAt || null,
    lastError: s.lastError || null,
    lastRun: lastRun
      ? {
          ok: Boolean(lastRun.ok),
          authMode: lastRun.authMode || null,
          since: lastRun.since || null,
          durationMs: lastRun.durationMs ?? null,
          fetched: lastRun.fetched || null,
          upserted: lastRun.upserted || null,
          pdfDownloaded: lastRun.pdfDownloaded ?? null,
          pdfEnqueued: lastRun.pdfEnqueued ?? null,
          errors: lastRun.errors ?? null,
        }
      : null,
    label: running
      ? 'Syncing…'
      : s.lastError
        ? 'Last sync failed'
        : s.lastSuccessAt
          ? 'Synced'
          : 'Never synced',
  };
}
