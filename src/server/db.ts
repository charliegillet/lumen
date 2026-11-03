import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = import('better-sqlite3').Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  conversation_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL,
  body TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (conversation_id, seq));
CREATE UNIQUE INDEX IF NOT EXISTS uniq_client_msg ON events(conversation_id, json_extract(body,'$.clientMsgId'))
  WHERE type = 'user_message';
`;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA);
  return db;
}
