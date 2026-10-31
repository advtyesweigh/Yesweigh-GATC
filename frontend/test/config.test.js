import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));

describe('frontend scaffold', () => {
  it('includes status check entrypoint', () => {
    const main = readFileSync(path.join(root, '../src/main.js'), 'utf8');
    assert.match(main, /\/api\/status/);
  });
});
