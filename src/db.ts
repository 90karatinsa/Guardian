import Database from 'better-sqlite3';
import config from 'config';
import fs from 'node:fs';
import path from 'node:path';
import { EventRecord } from './types.js';

const dbPath = config.get<string>('database.path');
const directory = path.dirname(dbPath);
fs.mkdirSync(directory, { recursive: true });

const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    source TEXT NOT NULL,
    detector TEXT NOT NULL,
    severity TEXT NOT NULL,
    message TEXT NOT NULL,
    meta TEXT
  )
`);

const insertStatement = db.prepare(
  'INSERT INTO events (ts, source, detector, severity, message, meta) VALUES (@ts, @source, @detector, @severity, @message, @meta)'
);

export function storeEvent(event: EventRecord) {
  insertStatement.run({
    ts: event.ts,
    source: event.source,
    detector: event.detector,
    severity: event.severity,
    message: event.message,
    meta: event.meta ? JSON.stringify(event.meta) : null
  });
}

export function clearEvents() {
  db.prepare('DELETE FROM events').run();
}

export default db;
