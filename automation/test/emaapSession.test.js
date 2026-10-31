import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getEmaapSessionStatus,
  EMAAP_STATUS,
  resolveSessionStatusPath,
} from '../src/emaapSession.js';

describe('emaapSession status file', () => {
  let tmpDir;
  let statusPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatc-emaap-'));
    statusPath = path.join(tmpDir, 'emaap', 'session-status.json');
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('defaults to not_logged_in when file is missing', () => {
    const missing = path.join(tmpDir, 'missing', 'session-status.json');
    const status = getEmaapSessionStatus({ statusPath: missing });
    assert.equal(status.status, EMAAP_STATUS.NOT_LOGGED_IN);
    assert.equal(status.loggedIn, false);
    assert.equal(status.label, 'Not Logged In');
    assert.equal(status.source, 'stub');
    assert.match(status.hook, /session-status\.json/);
  });

  it('reports logged_in when status file says so', () => {
    fs.writeFileSync(
      statusPath,
      JSON.stringify({ loggedIn: true, updatedAt: '2026-10-31T12:00:00.000Z' }),
      'utf8',
    );
    const status = getEmaapSessionStatus({ statusPath });
    assert.equal(status.status, EMAAP_STATUS.LOGGED_IN);
    assert.equal(status.loggedIn, true);
    assert.equal(status.label, 'Logged In');
    assert.equal(status.source, 'status_file');
    assert.equal(status.updatedAt, '2026-10-31T12:00:00.000Z');
  });

  it('reports not_logged_in when loggedIn is false', () => {
    fs.writeFileSync(
      statusPath,
      JSON.stringify({ loggedIn: false, updatedAt: '2026-10-31T13:00:00.000Z' }),
      'utf8',
    );
    const status = getEmaapSessionStatus({ statusPath });
    assert.equal(status.status, EMAAP_STATUS.NOT_LOGGED_IN);
    assert.equal(status.label, 'Not Logged In');
  });

  it('resolves path under dataRoot', () => {
    const p = resolveSessionStatusPath({ dataRoot: tmpDir });
    assert.equal(p, path.resolve(tmpDir, 'emaap', 'session-status.json'));
  });
});
