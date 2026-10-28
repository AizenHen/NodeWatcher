import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { seed } from './seed.js';
export function createStore(filename) {
  mkdirSync(path.dirname(filename), {recursive:true});
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL)');
  if (!db.prepare('SELECT id FROM state WHERE id=1').get()) db.prepare('INSERT INTO state VALUES(1, ?)').run(JSON.stringify(seed()));
  return {
    read: () => JSON.parse(db.prepare('SELECT document FROM state WHERE id=1').get().document),
    write: state => db.prepare('UPDATE state SET document=? WHERE id=1').run(JSON.stringify(state)),
    close: () => db.close()
  };
}
