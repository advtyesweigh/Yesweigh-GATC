import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

function requireInt(name, fallback) {
  const raw = process.env[name] ?? String(fallback);
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) {
    throw new Error(`Invalid integer for ${name}: ${raw}`);
  }
  return value;
}

export function loadConfig() {
  const config = {
    appName: process.env.APP_NAME || 'gatc-vps',
    nodeEnv: process.env.NODE_ENV || 'development',
    host: process.env.APP_HOST || '127.0.0.1',
    port: requireInt('APP_PORT', 3000),
    logLevel: process.env.LOG_LEVEL || 'info',
    corsOrigin: process.env.CORS_ORIGIN || 'http://127.0.0.1:5173',
    databaseUrl: process.env.DATABASE_URL || '',
    dataRoot: process.env.DATA_ROOT || '',
    jwtSecret: process.env.JWT_SECRET || '',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  };

  if (config.port < 1 || config.port > 65535) {
    throw new Error(`APP_PORT out of range: ${config.port}`);
  }

  return config;
}
