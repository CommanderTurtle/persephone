import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { databasePath } from "./paths.ts";
import type { InboxRecord, RouteRecord, ScheduleRecord, ThinkingLevel } from "./types.ts";

export interface OutboxRecord {
  id: number;
  channel: string;
  peerId: string;
  body: string;
  status: string;
  attempts: number;
}

export interface ApprovalRecord {
  id: number;
  workerKey: string;
  requestId: string;
  channel: string;
  peerId: string;
  method: string;
  title: string;
  message: string;
  status: string;
  expiresAt: number;
}

export class PersephoneDatabase {
  readonly db: Database;

  constructor(file = databasePath()) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new Database(file, { create: true, strict: true });
    this.db.run("PRAGMA journal_mode=WAL");
    this.db.run("PRAGMA foreign_keys=ON");
    this.db.run("PRAGMA busy_timeout=5000");
    this.migrate();
    this.recoverInterruptedWork();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS routes (
        channel TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        session_path TEXT,
        cwd TEXT NOT NULL,
        profile TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        thinking TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(channel, peer_id)
      );

      CREATE TABLE IF NOT EXISTS inbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        body TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        UNIQUE(channel, message_id)
      );
      CREATE INDEX IF NOT EXISTS inbox_status_idx ON inbox(status, received_at);

      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        inbox_id INTEGER,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        sent_at INTEGER,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        FOREIGN KEY(inbox_id) REFERENCES inbox(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS outbox_status_idx ON outbox(status, created_at);

      CREATE TABLE IF NOT EXISTS schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        cron TEXT NOT NULL,
        prompt TEXT NOT NULL,
        cwd TEXT NOT NULL,
        profile TEXT NOT NULL,
        channel TEXT,
        peer_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_minute INTEGER,
        last_status TEXT,
        last_error TEXT
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        worker_key TEXT NOT NULL,
        request_id TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'signal',
        peer_id TEXT NOT NULL,
        method TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        response_json TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        UNIQUE(worker_key, request_id)
      );

      CREATE TABLE IF NOT EXISTS worker_state (
        worker_key TEXT PRIMARY KEY,
        session_path TEXT,
        pid INTEGER,
        profile TEXT NOT NULL,
        cwd TEXT NOT NULL,
        status TEXT NOT NULL,
        last_seen INTEGER NOT NULL
      );
    `);
    const approvalColumns = (this.db.query("PRAGMA table_info(approvals)").all() as Array<{ name: string }>).map((column) => column.name);
    if (!approvalColumns.includes("channel")) {
      this.db.run("ALTER TABLE approvals ADD COLUMN channel TEXT NOT NULL DEFAULT 'signal'");
    }
  }

  private recoverInterruptedWork(): void {
    this.db.run("UPDATE inbox SET status='pending', error='Recovered after restart' WHERE status='running'");
    this.db.run("UPDATE outbox SET status='pending', error='Recovered after restart' WHERE status='sending'");
    this.db.run("UPDATE worker_state SET status='stopped', pid=NULL");
    this.db.run("UPDATE approvals SET status='expired' WHERE status='pending'");
  }

  getRoute(channel: string, peerId: string): RouteRecord | null {
    const row = this.db.query(`SELECT * FROM routes WHERE channel=? AND peer_id=?`).get(channel, peerId) as
      | Record<string, unknown>
      | null;
    return row ? mapRoute(row) : null;
  }

  listRoutes(): RouteRecord[] {
    return (this.db.query("SELECT * FROM routes ORDER BY channel, peer_id").all() as Record<string, unknown>[]).map(mapRoute);
  }

  upsertRoute(route: Omit<RouteRecord, "createdAt" | "updatedAt">): RouteRecord {
    const now = Date.now();
    this.db
      .query(`
        INSERT INTO routes(channel, peer_id, session_path, cwd, profile, provider, model, thinking, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(channel, peer_id) DO UPDATE SET
          session_path=excluded.session_path,
          cwd=excluded.cwd,
          profile=excluded.profile,
          provider=excluded.provider,
          model=excluded.model,
          thinking=excluded.thinking,
          updated_at=excluded.updated_at
      `)
      .run(
        route.channel,
        route.peerId,
        route.sessionPath,
        route.cwd,
        route.profile,
        route.provider,
        route.model,
        route.thinking,
        now,
        now,
      );
    return this.getRoute(route.channel, route.peerId)!;
  }

  updateSession(channel: string, peerId: string, sessionPath: string | null): void {
    this.db
      .query("UPDATE routes SET session_path=?, updated_at=? WHERE channel=? AND peer_id=?")
      .run(sessionPath, Date.now(), channel, peerId);
  }

  enqueueInbox(channel: string, peerId: string, messageId: string, body: string, receivedAt = Date.now()): number | null {
    const result = this.db
      .query(`INSERT OR IGNORE INTO inbox(channel, peer_id, message_id, body, received_at) VALUES (?, ?, ?, ?, ?)`)
      .run(channel, peerId, messageId, body, receivedAt);
    return result.changes ? Number(result.lastInsertRowid) : null;
  }

  claimInbox(limit = 16): InboxRecord[] {
    const transaction = this.db.transaction(() => {
      const rows = this.db
        .query("SELECT * FROM inbox WHERE status='pending' ORDER BY received_at, id LIMIT ?")
        .all(limit) as Record<string, unknown>[];
      const update = this.db.query("UPDATE inbox SET status='running', attempts=attempts+1 WHERE id=? AND status='pending'");
      const claimed: InboxRecord[] = [];
      for (const row of rows) {
        const result = update.run(Number(row.id));
        if (result.changes) claimed.push(mapInbox(row, "running", Number(row.attempts) + 1));
      }
      return claimed;
    });
    return transaction();
  }

  finishInbox(id: number, error?: string): void {
    this.db
      .query("UPDATE inbox SET status=?, error=? WHERE id=?")
      .run(error ? "failed" : "done", error ?? null, id);
  }

  enqueueOutbox(channel: string, peerId: string, body: string, inboxId?: number): number {
    const result = this.db
      .query("INSERT INTO outbox(channel, peer_id, inbox_id, body, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(channel, peerId, inboxId ?? null, body, Date.now());
    return Number(result.lastInsertRowid);
  }

  claimOutbox(limit = 16): OutboxRecord[] {
    const transaction = this.db.transaction(() => {
      const rows = this.db
        .query("SELECT id, channel, peer_id, body, status, attempts FROM outbox WHERE status='pending' ORDER BY created_at, id LIMIT ?")
        .all(limit) as Record<string, unknown>[];
      const update = this.db.query("UPDATE outbox SET status='sending', attempts=attempts+1 WHERE id=? AND status='pending'");
      const claimed: OutboxRecord[] = [];
      for (const row of rows) {
        if (!update.run(Number(row.id)).changes) continue;
        claimed.push({
          id: Number(row.id),
          channel: String(row.channel),
          peerId: String(row.peer_id),
          body: String(row.body),
          status: "sending",
          attempts: Number(row.attempts) + 1,
        });
      }
      return claimed;
    });
    return transaction();
  }

  finishOutbox(id: number, error?: string, retry = false): void {
    this.db
      .query("UPDATE outbox SET status=?, sent_at=?, error=? WHERE id=?")
      .run(error && retry ? "pending" : error ? "failed" : "sent", error ? null : Date.now(), error ?? null, id);
  }

  listSchedules(): ScheduleRecord[] {
    return (this.db.query("SELECT * FROM schedules ORDER BY name").all() as Record<string, unknown>[]).map(mapSchedule);
  }

  putSchedule(input: Omit<ScheduleRecord, "id" | "lastMinute" | "lastStatus" | "lastError">): ScheduleRecord {
    this.db
      .query(`
        INSERT INTO schedules(name, cron, prompt, cwd, profile, channel, peer_id, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET cron=excluded.cron, prompt=excluded.prompt,
          cwd=excluded.cwd, profile=excluded.profile, channel=excluded.channel,
          peer_id=excluded.peer_id, enabled=excluded.enabled
      `)
      .run(input.name, input.cron, input.prompt, input.cwd, input.profile, input.channel, input.peerId, input.enabled ? 1 : 0);
    const row = this.db.query("SELECT * FROM schedules WHERE name=?").get(input.name) as Record<string, unknown>;
    return mapSchedule(row);
  }

  removeSchedule(name: string): boolean {
    return this.db.query("DELETE FROM schedules WHERE name=?").run(name).changes > 0;
  }

  markSchedule(id: number, minute: number, error?: string): void {
    this.db
      .query("UPDATE schedules SET last_minute=?, last_status=?, last_error=? WHERE id=?")
      .run(minute, error ? "failed" : "done", error ?? null, id);
  }

  claimSchedule(id: number, minute: number): boolean {
    return (
      this.db
        .query(`
          UPDATE schedules
          SET last_minute=?, last_status='running', last_error=NULL
          WHERE id=? AND enabled=1 AND (last_minute IS NULL OR last_minute<>?)
        `)
        .run(minute, id, minute).changes > 0
    );
  }

  createApproval(input: Omit<ApprovalRecord, "id" | "status">): ApprovalRecord {
    const now = Date.now();
    const result = this.db
      .query(`
        INSERT INTO approvals(worker_key, request_id, channel, peer_id, method, title, message, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(input.workerKey, input.requestId, input.channel, input.peerId, input.method, input.title, input.message, now, input.expiresAt);
    return { ...input, id: Number(result.lastInsertRowid), status: "pending" };
  }

  resolveApproval(id: number, response: object, status: "approved" | "denied"): ApprovalRecord | null {
    this.db
      .query("UPDATE approvals SET status=?, response_json=? WHERE id=? AND status='pending' AND expires_at>=?")
      .run(status, JSON.stringify(response), id, Date.now());
    const row = this.db.query("SELECT * FROM approvals WHERE id=?").get(id) as Record<string, unknown> | null;
    return row ? mapApproval(row) : null;
  }

  getApproval(id: number): ApprovalRecord | null {
    const row = this.db.query("SELECT * FROM approvals WHERE id=?").get(id) as Record<string, unknown> | null;
    return row ? mapApproval(row) : null;
  }

  getApprovalByRequest(workerKey: string, requestId: string): ApprovalRecord | null {
    const row = this.db
      .query("SELECT * FROM approvals WHERE worker_key=? AND request_id=?")
      .get(workerKey, requestId) as Record<string, unknown> | null;
    return row ? mapApproval(row) : null;
  }

  updateWorker(key: string, sessionPath: string | null, pid: number | null, profile: string, cwd: string, status: string): void {
    this.db
      .query(`
        INSERT INTO worker_state(worker_key, session_path, pid, profile, cwd, status, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(worker_key) DO UPDATE SET session_path=excluded.session_path, pid=excluded.pid,
          profile=excluded.profile, cwd=excluded.cwd, status=excluded.status, last_seen=excluded.last_seen
      `)
      .run(key, sessionPath, pid, profile, cwd, status, Date.now());
  }

  markWorkerStopped(key: string): void {
    this.db
      .query("UPDATE worker_state SET status='stopped', pid=NULL, last_seen=? WHERE worker_key=?")
      .run(Date.now(), key);
  }

  status(): Record<string, number> {
    const count = (table: string, where = "1=1") =>
      Number((this.db.query(`SELECT count(*) AS value FROM ${table} WHERE ${where}`).get() as { value: number }).value);
    return {
      pendingInbox: count("inbox", "status='pending'"),
      failedInbox: count("inbox", "status='failed'"),
      pendingOutbox: count("outbox", "status='pending'"),
      failedOutbox: count("outbox", "status='failed'"),
      activeSchedules: count("schedules", "enabled=1"),
      routes: count("routes"),
      workers: count("worker_state", "status='ready' OR status='busy'"),
    };
  }
}

function mapRoute(row: Record<string, unknown>): RouteRecord {
  return {
    channel: String(row.channel),
    peerId: String(row.peer_id),
    sessionPath: row.session_path ? String(row.session_path) : null,
    cwd: String(row.cwd),
    profile: String(row.profile),
    provider: row.provider ? String(row.provider) : null,
    model: row.model ? String(row.model) : null,
    thinking: row.thinking ? (String(row.thinking) as ThinkingLevel) : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapInbox(row: Record<string, unknown>, status?: InboxRecord["status"], attempts?: number): InboxRecord {
  return {
    id: Number(row.id),
    channel: String(row.channel),
    peerId: String(row.peer_id),
    messageId: String(row.message_id),
    body: String(row.body),
    receivedAt: Number(row.received_at),
    status: status ?? (String(row.status) as InboxRecord["status"]),
    attempts: attempts ?? Number(row.attempts),
    error: row.error ? String(row.error) : null,
  };
}

function mapSchedule(row: Record<string, unknown>): ScheduleRecord {
  return {
    id: Number(row.id),
    name: String(row.name),
    cron: String(row.cron),
    prompt: String(row.prompt),
    cwd: String(row.cwd),
    profile: String(row.profile),
    channel: row.channel ? String(row.channel) : null,
    peerId: row.peer_id ? String(row.peer_id) : null,
    enabled: Boolean(row.enabled),
    lastMinute: row.last_minute === null ? null : Number(row.last_minute),
    lastStatus: row.last_status ? String(row.last_status) : null,
    lastError: row.last_error ? String(row.last_error) : null,
  };
}

function mapApproval(row: Record<string, unknown>): ApprovalRecord {
  return {
    id: Number(row.id),
    workerKey: String(row.worker_key),
    requestId: String(row.request_id),
    channel: String(row.channel || "signal"),
    peerId: String(row.peer_id),
    method: String(row.method),
    title: String(row.title),
    message: String(row.message),
    status: String(row.status),
    expiresAt: Number(row.expires_at),
  };
}
