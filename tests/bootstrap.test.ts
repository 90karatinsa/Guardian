import { beforeEach, describe, expect, it } from 'vitest';
import config from 'config';
import Database from 'better-sqlite3';
import { bootstrap } from '../src/app.js';
import { clearEvents } from '../src/db.js';

describe('Bootstrap', () => {
  const dbPath = config.get<string>('database.path');

  beforeEach(() => {
    clearEvents();
  });

  it('stores the system up event in the database', async () => {
    await bootstrap();

    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare(
        'SELECT source, detector, severity, message FROM events ORDER BY id DESC LIMIT 1'
      )
      .get();
    db.close();

    expect(row).toBeDefined();
    expect(row.message).toBe('system up');
    expect(row.source).toBe('system');
    expect(row.detector).toBe('bootstrap');
    expect(row.severity).toBe('info');
  });
});
