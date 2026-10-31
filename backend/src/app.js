import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { checkDb } from './db.js';
import { mountAuthRoutes, createAuthMiddleware } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultPublicDir = path.resolve(__dirname, '../../public');

export function createApp({ config, logger, pool = null, publicDir = defaultPublicDir }) {
  const app = express();
  const startedAt = new Date();

  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', async (_req, res) => {
    const body = {
      status: 'ok',
      app: config.appName,
      env: config.nodeEnv,
      uptimeSeconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
      timestamp: new Date().toISOString(),
    };

    if (config.databaseUrl) {
      try {
        const db = await checkDb(pool);
        body.db = db.ok ? 'up' : 'down';
        if (!db.ok) {
          body.status = 'degraded';
        }
      } catch (error) {
        body.db = 'down';
        body.status = 'degraded';
        logger.error?.('Health DB check failed', { error: error.message });
      }
    } else {
      body.db = 'unconfigured';
    }

    // Liveness stays 200; db field reports optional connectivity.
    res.status(200).json(body);
  });

  app.get('/api/status', (_req, res) => {
    res.json({
      connected: true,
      backend: config.appName,
      message: 'Backend is reachable',
      timestamp: new Date().toISOString(),
    });
  });

  // Auth routes always mount; handlers return 503 when DB/JWT are unconfigured.
  mountAuthRoutes(app, { config, pool, logger });
  app.locals.auth = createAuthMiddleware({ config, pool, logger });

  // RC Admin reference UI (and other static assets). API routes above take precedence.
  app.use(express.static(publicDir, { index: 'index.html', fallthrough: true }));
  app.get('/', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'), (err) => {
      if (err) {
        logger.error?.('Failed to serve UI', { error: err.message });
        res.status(500).json({ error: 'UI not available' });
      }
    });
  });

  app.use((err, _req, res, _next) => {
    logger.error('Unhandled error', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
