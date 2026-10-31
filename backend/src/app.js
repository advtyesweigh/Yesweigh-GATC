import express from 'express';
import cors from 'cors';
import { checkDb } from './db.js';

export function createApp({ config, logger, pool = null }) {
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

  app.use((err, _req, res, _next) => {
    logger.error('Unhandled error', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
