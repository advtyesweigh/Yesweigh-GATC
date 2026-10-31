import { checkDb } from './db.js';
import { createAuthMiddleware } from './auth.js';
import { getEmaapSessionStatus } from '../../automation/src/emaapSession.js';
import { automationStatus } from '../../automation/src/placeholder.js';

/**
 * Super Admin ops routes (ADMIN role only).
 * eMaap status is read from a status file — no CAPTCHA bypass or auto-login.
 */
export function mountAdminRoutes(app, { config, pool, logger, startedAt = new Date() }) {
  const { requireAuth, requireRole } = createAuthMiddleware({ config, pool, logger });
  const adminOnly = [requireAuth, requireRole('ADMIN')];

  app.get('/api/v1/admin/ops-status', ...adminOnly, async (_req, res) => {
    let dbState = 'unconfigured';
    if (config.databaseUrl) {
      try {
        const db = await checkDb(pool);
        dbState = db.ok ? 'up' : 'down';
      } catch (error) {
        dbState = 'down';
        logger.warn?.('Admin ops DB check failed', { error: error.message });
      }
    }

    const emaap = getEmaapSessionStatus({ dataRoot: config.dataRoot });
    const worker = automationStatus();
    const uptimeSeconds = Math.floor((Date.now() - startedAt.getTime()) / 1000);
    const apiOnline = true;
    const dbOnline = dbState === 'up';
    const workerActive = worker.ready === true;
    const systemHealthy = apiOnline && (dbState === 'up' || dbState === 'unconfigured');

    return res.json({
      data: {
        checkedAt: new Date().toISOString(),
        system: {
          healthy: systemHealthy,
          label: systemHealthy ? 'System Healthy' : 'System Degraded',
          uptimeSeconds,
          uptimePercent: null,
        },
        services: {
          api: {
            id: 'api',
            name: 'API',
            status: 'online',
            label: 'Online',
            online: true,
          },
          db: {
            id: 'db',
            name: 'DB',
            status: dbOnline ? 'online' : dbState === 'unconfigured' ? 'unknown' : 'offline',
            label: dbOnline ? 'Online' : dbState === 'unconfigured' ? 'Unconfigured' : 'Offline',
            online: dbOnline,
          },
          worker: {
            id: 'worker',
            name: 'Worker',
            status: workerActive ? 'online' : 'inactive',
            label: workerActive ? 'Online' : 'Inactive',
            online: workerActive,
            note: worker.note || null,
          },
          emaap: {
            id: 'emaap',
            name: 'eMaap',
            status: emaap.status,
            label: emaap.label,
            online: emaap.loggedIn === true,
            loggedIn: emaap.loggedIn === true,
            updatedAt: emaap.updatedAt,
            source: emaap.source,
            note: emaap.note,
          },
        },
        emaap: {
          status: emaap.status,
          label: emaap.label,
          loggedIn: emaap.loggedIn === true,
          updatedAt: emaap.updatedAt,
          source: emaap.source,
          note: emaap.note,
          hook: emaap.hook,
        },
      },
    });
  });

  /** Narrow alias focused on eMaap session only. */
  app.get('/api/v1/admin/emaap-status', ...adminOnly, (_req, res) => {
    const emaap = getEmaapSessionStatus({ dataRoot: config.dataRoot });
    return res.json({
      data: {
        status: emaap.status,
        label: emaap.label,
        loggedIn: emaap.loggedIn === true,
        updatedAt: emaap.updatedAt,
        source: emaap.source,
        note: emaap.note,
        hook: emaap.hook,
        checkedAt: new Date().toISOString(),
      },
    });
  });
}
