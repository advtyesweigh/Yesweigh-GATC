import express from 'express';
import cors from 'cors';

export function createApp({ config, logger }) {
  const app = express();
  const startedAt = new Date();

  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      app: config.appName,
      env: config.nodeEnv,
      uptimeSeconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
      timestamp: new Date().toISOString(),
    });
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
