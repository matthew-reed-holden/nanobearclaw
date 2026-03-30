// container/skills/social-monitor/dedup.ts
import Database from 'better-sqlite3';

export class DedupStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS seen_items (
        item_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        seen_at TEXT NOT NULL DEFAULT (datetime('now')),
        action_taken TEXT,
        PRIMARY KEY (item_id, platform)
      )
    `);
  }

  hasSeen(itemId: string, platform: string): boolean {
    const row = this.db.prepare(
      'SELECT 1 FROM seen_items WHERE item_id = ? AND platform = ?',
    ).get(itemId, platform);
    return !!row;
  }

  markSeen(itemId: string, platform: string, actionTaken?: string): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO seen_items (item_id, platform, action_taken)
      VALUES (?, ?, ?)
    `).run(itemId, platform, actionTaken ?? null);
  }

  filterUnseen<T extends { id: string }>(items: T[], platform: string): T[] {
    return items.filter(item => !this.hasSeen(item.id, platform));
  }

  prune(maxAgeDays = 7): number {
    const result = this.db.prepare(`
      DELETE FROM seen_items
      WHERE seen_at < datetime('now', '-' || ? || ' days')
    `).run(maxAgeDays);
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}
