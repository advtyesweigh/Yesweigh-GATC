import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createApp } from './app.js';

try {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const app = createApp({ config, logger });

  const server = app.listen(config.port, config.host, () => {
    logger.info('Backend listening', {
      host: config.host,
      port: config.port,
      env: config.nodeEnv,
    });
  });

  const shutdown = (signal) => {
    logger.info('Shutting down', { signal });
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
} catch (error) {
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'error',
    message: 'Failed to start backend',
    meta: { error: error.message },
  }));
  process.exit(1);
}
