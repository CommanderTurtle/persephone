import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type ProposalStatus = "pending" | "approved" | "rejected" | "conflicted" | "pushed" | "published";

export interface PublicationProposal {
  id: string;
  repo: string;
  issueNumber: number;
  workspaceKey: string;
  branch: string;
  headSha: string;
  baseSha: string;
  diffSha256: string;
  diffText: string;
  diffTruncated: boolean;
  status: ProposalStatus;
  createdAt: number;
  updatedAt: number;
  approvedAt: number | null;
  publishedAt: number | null;
  prUrl: string | null;
  lastError: string | null;
}

export interface EnsembleJob {
  id: number;
  personaId: string;
  repo: string;
  issueNumber: number;
  sourceCommentId: number;
  sourceBody: string;
  issueTitle: string;
  issueBody: string;
  sourceUrl: string;
  status: "queued" | "running" | "commented" | "skipped" | "failed";
  outputBody: string | null;
  error: string | null;
}

export type DreamStatus = "pending" | "approved" | "rejected" | "issued" | "failed";

export interface DreamProposal {
  id: string;
  repo: string;
  baseSha: string;
  title: string;
  issueBody: string;
  rationale: string;
  implementationBrief: string;
  status: DreamStatus;
  issueNumber: number | null;
  issueUrl: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export class GitHubBridgeDatabase {
  readonly db: Database;

  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new Database(file, { create: true, strict: true });
    this.db.run("PRAGMA journal_mode=WAL");
    this.db.run("PRAGMA busy_timeout=5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS publication_proposals (
        id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        workspace_key TEXT NOT NULL,
        branch TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        base_sha TEXT NOT NULL,
        diff_sha256 TEXT NOT NULL,
        diff_text TEXT NOT NULL,
        diff_truncated INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','conflicted','pushed','published')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        approved_at INTEGER,
        published_at INTEGER,
        pr_url TEXT,
        last_error TEXT,
        UNIQUE(workspace_key, head_sha)
      );
      CREATE INDEX IF NOT EXISTS publication_status_idx ON publication_proposals(status, updated_at);

      CREATE TABLE IF NOT EXISTS ensemble_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        persona_id TEXT NOT NULL,
        repo TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        source_comment_id INTEGER NOT NULL,
        source_body TEXT NOT NULL,
        issue_title TEXT NOT NULL,
        issue_body TEXT NOT NULL,
        source_url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','commented','skipped','failed')),
        output_body TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(persona_id, source_comment_id)
      );
      CREATE INDEX IF NOT EXISTS ensemble_status_idx ON ensemble_jobs(status, created_at);

      CREATE TABLE IF NOT EXISTS dream_proposals (
        id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        base_sha TEXT NOT NULL,
        title TEXT NOT NULL,
        issue_body TEXT NOT NULL,
        rationale TEXT NOT NULL,
        implementation_brief TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','issued','failed')),
        issue_number INTEGER,
        issue_url TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS dream_status_idx ON dream_proposals(status, updated_at);
      CREATE TABLE IF NOT EXISTS dream_schedule (
        repo TEXT PRIMARY KEY,
        last_run_at INTEGER NOT NULL,
        running INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );
    `);
    this.db.run("UPDATE ensemble_jobs SET status='queued', error='Recovered after restart' WHERE status='running'");
    this.db.run("UPDATE dream_schedule SET running=0, last_error='Recovered after restart' WHERE running=1");
    this.db.run("UPDATE dream_proposals SET status='failed', error='Recovered during approved issue publication' WHERE status='approved'");
  }

  close(): void {
    this.db.close();
  }

  putProposal(input: Omit<PublicationProposal, "status" | "createdAt" | "updatedAt" | "approvedAt" | "publishedAt" | "prUrl" | "lastError">): PublicationProposal {
    const now = Date.now();
    this.db.query(`
      INSERT INTO publication_proposals(
        id, repo, issue_number, workspace_key, branch, head_sha, base_sha,
        diff_sha256, diff_text, diff_truncated, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      ON CONFLICT(workspace_key, head_sha) DO UPDATE SET
        diff_sha256=excluded.diff_sha256,
        diff_text=excluded.diff_text,
        diff_truncated=excluded.diff_truncated,
        updated_at=excluded.updated_at
    `).run(
      input.id, input.repo, input.issueNumber, input.workspaceKey, input.branch,
      input.headSha, input.baseSha, input.diffSha256, input.diffText,
      input.diffTruncated ? 1 : 0, now, now,
    );
    return this.getProposal(input.id)!;
  }

  getProposal(id: string): PublicationProposal | null {
    const row = this.db.query("SELECT * FROM publication_proposals WHERE id=?").get(id) as Record<string, unknown> | null;
    return row ? mapProposal(row) : null;
  }

  findProposal(workspaceKey: string, headSha: string): PublicationProposal | null {
    const row = this.db.query("SELECT * FROM publication_proposals WHERE workspace_key=? AND head_sha=?")
      .get(workspaceKey, headSha) as Record<string, unknown> | null;
    return row ? mapProposal(row) : null;
  }

  findPushedProposal(repo: string, branch: string): PublicationProposal | null {
    const row = this.db.query(`
      SELECT * FROM publication_proposals
      WHERE lower(repo)=lower(?) AND branch=? AND status IN ('pushed','published')
      ORDER BY updated_at DESC LIMIT 1
    `).get(repo, branch) as Record<string, unknown> | null;
    return row ? mapProposal(row) : null;
  }

  listProposals(limit = 100): PublicationProposal[] {
    return (this.db.query("SELECT * FROM publication_proposals ORDER BY updated_at DESC LIMIT ?").all(limit) as Record<string, unknown>[])
      .map(mapProposal);
  }

  transitionProposal(id: string, from: ProposalStatus[], to: ProposalStatus, fields: { error?: string | null; prUrl?: string | null } = {}): PublicationProposal | null {
    const now = Date.now();
    const placeholders = from.map(() => "?").join(",");
    const approvedAt = to === "approved" ? now : null;
    const publishedAt = to === "published" ? now : null;
    this.db.query(`
      UPDATE publication_proposals SET status=?, updated_at=?,
        approved_at=COALESCE(?, approved_at), published_at=COALESCE(?, published_at),
        pr_url=COALESCE(?, pr_url), last_error=?
      WHERE id=? AND status IN (${placeholders})
    `).run(to, now, approvedAt, publishedAt, fields.prUrl ?? null, fields.error ?? null, id, ...from);
    return this.getProposal(id);
  }

  enqueueEnsemble(input: Omit<EnsembleJob, "id" | "status" | "outputBody" | "error">): boolean {
    const now = Date.now();
    return this.db.query(`
      INSERT OR IGNORE INTO ensemble_jobs(
        persona_id, repo, issue_number, source_comment_id, source_body,
        issue_title, issue_body, source_url, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.personaId, input.repo, input.issueNumber, input.sourceCommentId,
      input.sourceBody, input.issueTitle, input.issueBody, input.sourceUrl, now, now,
    ).changes > 0;
  }

  claimEnsemble(): EnsembleJob | null {
    return this.db.transaction(() => {
      const row = this.db.query("SELECT * FROM ensemble_jobs WHERE status='queued' ORDER BY created_at, id LIMIT 1")
        .get() as Record<string, unknown> | null;
      if (!row) return null;
      const changed = this.db.query("UPDATE ensemble_jobs SET status='running', updated_at=? WHERE id=? AND status='queued'")
        .run(Date.now(), Number(row.id)).changes;
      return changed ? mapEnsemble({ ...row, status: "running" }) : null;
    })();
  }

  finishEnsemble(id: number, status: "commented" | "skipped" | "failed", outputBody?: string, error?: string): void {
    this.db.query("UPDATE ensemble_jobs SET status=?, output_body=?, error=?, updated_at=? WHERE id=? AND status='running'")
      .run(status, outputBody ?? null, error ?? null, Date.now(), id);
  }

  listEnsemble(limit = 100): EnsembleJob[] {
    return (this.db.query("SELECT * FROM ensemble_jobs ORDER BY updated_at DESC LIMIT ?").all(limit) as Record<string, unknown>[])
      .map(mapEnsemble);
  }

  putDream(input: Omit<DreamProposal, "status" | "issueNumber" | "issueUrl" | "error" | "createdAt" | "updatedAt">): DreamProposal {
    const now = Date.now();
    this.db.query(`
      INSERT INTO dream_proposals(
        id, repo, base_sha, title, issue_body, rationale, implementation_brief,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at
    `).run(
      input.id, input.repo, input.baseSha, input.title, input.issueBody,
      input.rationale, input.implementationBrief, now, now,
    );
    return this.getDream(input.id)!;
  }

  getDream(id: string): DreamProposal | null {
    const row = this.db.query("SELECT * FROM dream_proposals WHERE id=?").get(id) as Record<string, unknown> | null;
    return row ? mapDream(row) : null;
  }

  hasPendingDream(repo: string): boolean {
    return Boolean(this.db.query("SELECT 1 AS found FROM dream_proposals WHERE lower(repo)=lower(?) AND status IN ('pending','approved') LIMIT 1").get(repo));
  }

  listDreams(limit = 100): DreamProposal[] {
    return (this.db.query("SELECT * FROM dream_proposals ORDER BY updated_at DESC LIMIT ?").all(limit) as Record<string, unknown>[])
      .map(mapDream);
  }

  transitionDream(
    id: string,
    from: DreamStatus[],
    to: DreamStatus,
    fields: { issueNumber?: number | null; issueUrl?: string | null; error?: string | null } = {},
  ): DreamProposal | null {
    const placeholders = from.map(() => "?").join(",");
    this.db.query(`
      UPDATE dream_proposals SET status=?, issue_number=COALESCE(?, issue_number),
        issue_url=COALESCE(?, issue_url), error=?, updated_at=?
      WHERE id=? AND status IN (${placeholders})
    `).run(to, fields.issueNumber ?? null, fields.issueUrl ?? null, fields.error ?? null, Date.now(), id, ...from);
    return this.getDream(id);
  }

  initializeDreamSchedule(repositories: string[], now = Date.now()): void {
    const insert = this.db.query("INSERT OR IGNORE INTO dream_schedule(repo, last_run_at, running) VALUES (?, ?, 0)");
    this.db.transaction(() => {
      for (const repo of repositories) insert.run(repo, now);
    })();
  }

  claimDueDream(intervalMs: number, now = Date.now()): string | null {
    return this.db.transaction(() => {
      const row = this.db.query(`
        SELECT repo FROM dream_schedule
        WHERE running=0 AND last_run_at <= ?
        ORDER BY last_run_at, repo LIMIT 1
      `).get(now - intervalMs) as { repo: string } | null;
      if (!row) return null;
      const changed = this.db.query("UPDATE dream_schedule SET running=1, last_run_at=?, last_error=NULL WHERE repo=? AND running=0")
        .run(now, row.repo).changes;
      return changed ? row.repo : null;
    })();
  }

  beginManualDream(repo: string, now = Date.now()): boolean {
    this.db.query("INSERT OR IGNORE INTO dream_schedule(repo, last_run_at, running) VALUES (?, ?, 0)").run(repo, now);
    return this.db.query("UPDATE dream_schedule SET running=1, last_run_at=?, last_error=NULL WHERE repo=? AND running=0")
      .run(now, repo).changes > 0;
  }

  finishDreamRun(repo: string, error?: string): void {
    this.db.query("UPDATE dream_schedule SET running=0, last_error=? WHERE lower(repo)=lower(?)")
      .run(error ?? null, repo);
  }
}

function mapProposal(row: Record<string, unknown>): PublicationProposal {
  return {
    id: String(row.id), repo: String(row.repo), issueNumber: Number(row.issue_number),
    workspaceKey: String(row.workspace_key), branch: String(row.branch), headSha: String(row.head_sha),
    baseSha: String(row.base_sha), diffSha256: String(row.diff_sha256), diffText: String(row.diff_text),
    diffTruncated: Boolean(row.diff_truncated), status: String(row.status) as ProposalStatus,
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    approvedAt: row.approved_at === null ? null : Number(row.approved_at),
    publishedAt: row.published_at === null ? null : Number(row.published_at),
    prUrl: row.pr_url ? String(row.pr_url) : null, lastError: row.last_error ? String(row.last_error) : null,
  };
}

function mapEnsemble(row: Record<string, unknown>): EnsembleJob {
  return {
    id: Number(row.id), personaId: String(row.persona_id), repo: String(row.repo),
    issueNumber: Number(row.issue_number), sourceCommentId: Number(row.source_comment_id),
    sourceBody: String(row.source_body), issueTitle: String(row.issue_title), issueBody: String(row.issue_body),
    sourceUrl: String(row.source_url), status: String(row.status) as EnsembleJob["status"],
    outputBody: row.output_body ? String(row.output_body) : null, error: row.error ? String(row.error) : null,
  };
}

function mapDream(row: Record<string, unknown>): DreamProposal {
  return {
    id: String(row.id), repo: String(row.repo), baseSha: String(row.base_sha),
    title: String(row.title), issueBody: String(row.issue_body), rationale: String(row.rationale),
    implementationBrief: String(row.implementation_brief), status: String(row.status) as DreamStatus,
    issueNumber: row.issue_number === null ? null : Number(row.issue_number),
    issueUrl: row.issue_url ? String(row.issue_url) : null,
    error: row.error ? String(row.error) : null,
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}
