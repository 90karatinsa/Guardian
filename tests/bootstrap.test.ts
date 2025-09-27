import { beforeEach, describe, expect, it, vi } from 'vitest';
import config from 'config';
import Database from 'better-sqlite3';
import { clearEvents } from '../src/db.js';

describe('Bootstrap', () => {
  const dbPath = config.get<string>('database.path');

  beforeEach(() => {
    clearEvents();
  });

  it('stores the system up event in the database', async () => {
    const { bootstrap } = await import('../src/app.js');
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

  it('BootstrapSchemaGuards validates configuration via schema enforcement', async () => {
    const validationError = new Error('configuration schema invalid');

    vi.resetModules();
    try {
      vi.doMock('../src/config/index.js', async () => {
        const actual = await vi.importActual<typeof import('../src/config/index.js')>(
          '../src/config/index.js'
        );
        return {
          ...actual,
          validateConfig: vi.fn(() => {
            throw validationError;
          })
        };
      });

      const { bootstrap } = await import('../src/app.js');
      await expect(bootstrap()).rejects.toThrow('configuration schema invalid');
    } finally {
      vi.resetModules();
      vi.doUnmock('../src/config/index.js');
    }
  });
});
