import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createLogger } from '../src/logger.js';

const config = {
  appName: 'gatc-vps-test',
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 0,
  logLevel: 'error',
  corsOrigin: 'http://127.0.0.1:5173',
};

describe('health endpoint', () => {
  it('returns ok status', async () => {
    const app = createApp({ config, logger: createLogger('error') });
    const server = app.listen(0);
    const { port } = server.address();

    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.status, 'ok');
      assert.equal(body.app, 'gatc-vps-test');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
