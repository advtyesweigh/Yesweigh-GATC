import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createApp } from './app.js';
import { createPool, setPool } from './db.js';

try {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const pool = createPool(config.databaseUrl);
  setPool(pool);
  const app = createApp({ config, logger, pool });

  const server = app.listen(config.port, config.host, () => {
    logger.info('Backend listening', {
      host: config.host,
      port: config.port,
      env: config.nodeEnv,
      dbConfigured: Boolean(config.databaseUrl),
    });
  });

  const shutdown = async (signal) => {
    logger.info('Shutting down', { signal });
    server.close(async () => {
      if (pool) {
        await pool.end().catch(() => {});
      }
      process.exit(0);
    });
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
} catch (error) {
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'error',
    message: 'Failed to start backend',
    meta: { error: error.message },
  }));
  process.exit(1);
}
