// container/skills/social-monitor/engagement-log.ts
import Database from 'better-sqlite3';
import type { EngagementLogEntry } from './interfaces.js';

export class EngagementLog {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS engagement_log (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        action_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        target_url TEXT NOT NULL,
        target_author TEXT NOT NULL,
        target_content TEXT NOT NULL,
        content TEXT,
        approval_id TEXT,
        status TEXT NOT NULL,
        triggered_by TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        executed_at TEXT,
        synced_at TEXT
      )
    `);
  }

  log(entry: EngagementLogEntry): void {
    this.db.prepare(`
      INSERT INTO engagement_log
        (id, platform, action_type, target_id, target_url, target_author,
         target_content, content, approval_id, status, triggered_by, executed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id, entry.platform, entry.actionType, entry.targetId,
      entry.targetUrl, entry.targetAuthor, entry.targetContent,
      entry.content, entry.approvalId, entry.status, entry.triggeredBy,
      entry.executedAt,
    );
  }

  updateStatus(id: string, status: string, executedAt?: string): void {
    this.db.prepare(`
      UPDATE engagement_log SET status = ?, executed_at = ? WHERE id = ?
    `).run(status, executedAt ?? null, id);
  }

  listRecent(platform: string, limit = 50): EngagementLogEntry[] {
    const rows = this.db.prepare(`
      SELECT * FROM engagement_log
      WHERE platform = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(platform, limit) as Record<string, unknown>[];
    return rows.map(r => ({
      id: r.id as string,
      platform: r.platform as string,
      actionType: r.action_type as string,
      targetId: r.target_id as string,
      targetUrl: r.target_url as string,
      targetAuthor: r.target_author as string,
      targetContent: r.target_content as string,
      content: r.content as string | null,
      approvalId: r.approval_id as string | null,
      status: r.status as EngagementLogEntry['status'],
      triggeredBy: r.triggered_by as EngagementLogEntry['triggeredBy'],
      createdAt: r.created_at as string,
      executedAt: r.executed_at as string | null,
    }));
  }

  drainForSync(platform: string): EngagementLogEntry[] {
    const rows = this.db.prepare(`
      SELECT * FROM engagement_log
      WHERE platform = ? AND synced_at IS NULL
      ORDER BY created_at DESC
      LIMIT 100
    `).all(platform) as Record<string, unknown>[];
    const entries = rows.map(r => ({
      id: r.id as string,
      platform: r.platform as string,
      actionType: r.action_type as string,
      targetId: r.target_id as string,
      targetUrl: r.target_url as string,
      targetAuthor: r.target_author as string,
      targetContent: r.target_content as string,
      content: r.content as string | null,
      approvalId: r.approval_id as string | null,
      status: r.status as EngagementLogEntry['status'],
      triggeredBy: r.triggered_by as EngagementLogEntry['triggeredBy'],
      createdAt: r.created_at as string,
      executedAt: r.executed_at as string | null,
    }));
    if (entries.length > 0) {
      const ids = entries.map(e => e.id);
      const placeholders = ids.map(() => '?').join(',');
      this.db.prepare(`UPDATE engagement_log SET synced_at = datetime('now') WHERE id IN (${placeholders})`).run(...ids);
    }
    return entries;
  }

  close(): void {
    this.db.close();
  }
}
