#!/usr/bin/env bun
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { loadRoboOmpGitHubConfig } from "./config.ts";
import { GitHubBridgeDatabase, type DreamProposal, type EnsembleJob, type PublicationProposal } from "./github-database.ts";
import { parseDreamDecision, parseEnsembleDecision } from "./github-contracts.ts";
import { sha256, signInternalRequest } from "./github-security.ts";
import { OmpWorkerPool } from "./rpc.ts";
import type { GitHubEnsemblePersona, RoboOmpGitHubConfig } from "./types.ts";

const config = loadRoboOmpGitHubConfig();
if (!config.enabled) throw new Error("roboomp.github.enabled must be true before starting the bridge");
const webhookSecret = requiredSecret(config.webhookSecretEnv);
const approvalToken = requiredSecret(config.approvalTokenEnv);
const replayToken = process.env[config.replayTokenEnv]?.trim() || "";
const proxyHmacKey = requiredSecret("ROBOMP_GH_PROXY_HMAC_KEY");
const stateFile = process.env.PERSEPHONE_GITHUB_STATE || "/data/persephone-github.sqlite";
const host = process.env.PERSEPHONE_GITHUB_HOST || "0.0.0.0";
const port = envPort("PERSEPHONE_GITHUB_PORT", 8082);
const allowedRepos = new Set(config.allowedRepositories.map(normalizeRepo));
const allowedActors = new Set(config.allowedActors.map(normalizeLogin));
const mainBotLogin = normalizeLogin(config.persephoneBotLogin);
const db = new GitHubBridgeDatabase(stateFile);
const ensemblePool = new OmpWorkerPool(1, 60_000);
const dreamPool = new OmpWorkerPool(1, 60_000);
let ensembleBusy = false;
let dreamBusy = false;

const workerSecretNames = [
  config.webhookSecretEnv, config.approvalTokenEnv, config.replayTokenEnv,
  config.dream.issueProxyKeyEnv, "GITHUB_TOKEN", "GH_TOKEN", "ROBOMP_GH_PROXY_HMAC_KEY",
  ...config.ensemble.personas.map((persona) => persona.commentProxyKeyEnv),
];

mkdirSync(config.ensemble.cwd, { recursive: true, mode: 0o700 });
mkdirSync(config.dream.cwdRoot, { recursive: true, mode: 0o700 });
if (config.dream.enabled) db.initializeDreamSchedule(config.dream.repositories);

const server = Bun.serve({
  hostname: host,
  port,
  async fetch(request) {
    try {
      return await route(request);
    } catch (error) {
      console.error(`[persephone-github] ${message(error)}`);
      return Response.json({ error: message(error) }, { status: 500 });
    }
  },
});

const ensembleTimer = setInterval(() => void processEnsembleQueue(), 500);
const dreamTimer = setInterval(() => void processDreamSchedule(), 30_000);
const dreamReconcileTimer = setInterval(() => void processDreamReconciliation(), 5_000);
console.log(`[persephone-github] bridge listening on ${server.url}`);
console.log(`[persephone-github] publication gate: ${config.dream.automatic ? "timer dreams automatic; all other diffs require approval" : "exact-diff approval required"}`);
console.log(`[persephone-github] ensemble: ${config.ensemble.enabled ? "enabled" : "disabled"}`);
console.log(`[persephone-github] dream loop: ${config.dream.enabled ? `enabled (${config.dream.intervalMinutes}m, ${config.dream.automatic ? "automatic" : "manual dispatch"})` : "disabled"}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void shutdown());
}

async function route(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/healthz") {
    return Response.json({
      ok: true,
      capability: "robomp-publication-gate",
      ensemble: config.ensemble.enabled,
      dream: config.dream.enabled,
      dreamAutomatic: config.dream.automatic,
      pending: db.listProposals().filter((item) => item.status === "pending").length,
      activeDreams: db.listDreams().filter((item) => new Set(["pending", "approved", "issued", "ready"]).has(item.status)).length,
    });
  }
  if (url.pathname === "/webhook/github" && request.method === "POST") return handleWebhook(request);
  if (url.pathname.startsWith("/gh/v1/")) return handleRoboOmpProxy(request, url);
  if (url.pathname === "/" && request.method === "GET") return new Response(DASHBOARD_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  if (url.pathname.startsWith("/api/")) {
    if (!authorized(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handleApi(request, url);
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

async function handleWebhook(request: Request): Promise<Response> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!verifyGitHub(bytes, request.headers.get("x-hub-signature-256"))) {
    return Response.json({ error: "invalid webhook signature" }, { status: 401 });
  }
  const event = request.headers.get("x-github-event") || "";
  const delivery = request.headers.get("x-github-delivery") || "";
  const payload = parseObject(bytes);
  const repo = normalizeRepo(asObject(payload.repository).full_name);
  if (!allowedRepos.has(repo)) return Response.json({ accepted: false, reason: "repository not allowed" }, { status: 202 });

  const sender = normalizeLogin(asObject(payload.sender).login);
  const comment = asObject(payload.comment);
  const commentAuthor = normalizeLogin(asObject(comment.user).login);
  if (config.ensemble.enabled && event === "issue_comment" && payload.action === "created" && commentAuthor === mainBotLogin) {
    enqueueEnsemblePost(repo, asObject(payload.issue), comment);
  }
  const issue = asObject(payload.issue);
  if (config.ensemble.enabled && event === "issues" && payload.action === "opened" && normalizeLogin(asObject(issue.user).login) === mainBotLogin) {
    enqueueEnsemblePost(repo, issue, issue);
  }
  const pullRequest = asObject(payload.pull_request);
  if (config.ensemble.enabled && event === "pull_request" && payload.action === "opened" && normalizeLogin(asObject(pullRequest.user).login) === mainBotLogin) {
    enqueueEnsemblePost(repo, pullRequest, pullRequest);
  }
  const review = asObject(payload.review);
  if (config.ensemble.enabled && event === "pull_request_review" && payload.action === "submitted" && normalizeLogin(asObject(review.user).login) === mainBotLogin) {
    enqueueEnsemblePost(repo, pullRequest, review);
  }
  if (config.ensemble.enabled && event === "pull_request_review_comment" && payload.action === "created" && commentAuthor === mainBotLogin) {
    enqueueEnsemblePost(repo, pullRequest, comment);
  }

  if (!allowedActors.has(sender)) {
    return Response.json({ accepted: true, forwarded: false, ensembleQueued: commentAuthor === mainBotLogin, reason: "actor not allowed" }, { status: 202 });
  }
  const response = await fetch(`${stripSlash(config.orchestratorUrl)}/webhook/github`, {
    method: "POST",
    headers: {
      "Content-Type": request.headers.get("content-type") || "application/json",
      "X-GitHub-Event": event,
      "X-GitHub-Delivery": delivery,
      "X-Hub-Signature-256": request.headers.get("x-hub-signature-256") || "",
    },
    body: bytes,
    signal: AbortSignal.timeout(30_000),
  });
  return passthrough(response);
}

async function handleRoboOmpProxy(request: Request, url: URL): Promise<Response> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  const target = `${url.pathname}${url.search}`;
  if (!verifyRoboOmpHmac(request.method, target, bytes, request.headers)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const input = bytes.length ? parseObject(bytes) : {};
  if (request.method === "POST" && url.pathname === "/gh/v1/git/push") {
    const denied = preparePush(input);
    if (denied) return denied;
  }
  if (request.method === "POST" && url.pathname === "/gh/v1/open_pull_request") {
    const repo = normalizeRepo(input.repo);
    const branch = String(input.head || "");
    const proposal = db.findPushedProposal(repo, branch);
    if (!proposal) return githubError("github", 409, `Persephone refused PR publication: no approved pushed proposal for ${repo}:${branch}`);
  }
  const upstream = await forwardProxy(request.method, target, bytes, request.headers);
  if (upstream.ok && request.method === "POST" && url.pathname === "/gh/v1/git/push") {
    const proposal = db.findProposal(String(input.workspace_key), String(input.expected_head));
    if (proposal) db.transitionProposal(proposal.id, ["approved"], "pushed");
  }
  if (upstream.ok && request.method === "POST" && url.pathname === "/gh/v1/open_pull_request") {
    const proposal = db.findPushedProposal(normalizeRepo(input.repo), String(input.head || ""));
    if (proposal) {
      const responseBody = await cloneResponseJson(upstream);
      db.transitionProposal(proposal.id, ["pushed"], "published", { prUrl: String(responseBody.html_url || responseBody.url || "") || null });
      return Response.json(responseBody, { status: upstream.status, headers: copyHeaders(upstream.headers) });
    }
  }
  return passthrough(upstream);
}

function preparePush(input: Record<string, unknown>): Response | null {
  const repo = normalizeRepo(input.repo);
  const workspaceKey = String(input.workspace_key || "");
  const branch = String(input.branch || "");
  const expectedHead = String(input.expected_head || "");
  if (!allowedRepos.has(repo)) return githubError("git", 403, "repository is not allowed");
  if (!validWorkspaceKey(repo, workspaceKey) || !/^[0-9a-f]{40,64}$/i.test(expectedHead) || !branch) {
    return githubError("git", 400, "invalid publication request");
  }
  let snapshot: DiffSnapshot;
  try {
    snapshot = inspectWorkspace(workspaceKey, expectedHead);
  } catch (error) {
    return githubError("git", 409, message(error));
  }
  const issueNumber = workspaceIssueNumber(workspaceKey);
  const dream = config.dream.automatic ? db.findDreamByIssue(repo, issueNumber) : null;
  const automaticPublication = dream?.status === "dispatched";
  const existing = db.findProposal(workspaceKey, expectedHead);
  if (existing) {
    if (existing.status === "approved") {
      if (existing.baseSha === snapshot.baseSha && existing.diffSha256 === snapshot.diffSha256) return null;
      db.transitionProposal(existing.id, ["approved"], "conflicted", { error: "Workspace changed after approval" });
      return githubError("git", 409, `Persephone approval ${existing.id} conflicted because the exact diff changed`);
    }
    if (existing.status === "pending" && automaticPublication) {
      if (existing.baseSha !== snapshot.baseSha || existing.diffSha256 !== snapshot.diffSha256) {
        db.transitionProposal(existing.id, ["pending"], "conflicted", { error: "Workspace changed before automatic publication" });
        return githubError("git", 409, `Persephone publication ${existing.id} conflicted because the exact diff changed`);
      }
      db.transitionProposal(existing.id, ["pending"], "approved");
      return null;
    }
    if (existing.status === "pushed" || existing.status === "published") return null;
    return githubError("git", 409, `Persephone publication ${existing.id} is ${existing.status}; inspect http://127.0.0.1:${port}/`);
  }
  const id = sha256(`${repo}\n${workspaceKey}\n${branch}\n${expectedHead}\n${snapshot.baseSha}\n${snapshot.diffSha256}`).slice(0, 24);
  db.putProposal({
    id, repo, issueNumber, workspaceKey, branch, headSha: expectedHead,
    baseSha: snapshot.baseSha, diffSha256: snapshot.diffSha256,
    diffText: snapshot.text, diffTruncated: snapshot.truncated,
  });
  if (automaticPublication) {
    db.transitionProposal(id, ["pending"], "approved");
    console.log(`[persephone-github] automatically approved exact diff ${id} for timer-dispatched dream ${dream!.id}`);
    return null;
  }
  return githubError("git", 409, `Persephone staged exact diff ${id}; human approval is required at http://127.0.0.1:${port}/`);
}

async function handleApi(request: Request, url: URL): Promise<Response> {
  if (request.method === "GET" && url.pathname === "/api/proposals") return Response.json(db.listProposals());
  if (request.method === "GET" && url.pathname === "/api/ensemble") return Response.json(db.listEnsemble());
  if (request.method === "GET" && url.pathname === "/api/dreams") return Response.json(db.listDreams());
  if (request.method === "POST" && url.pathname === "/api/dreams/run") {
    if (!config.dream.enabled) return Response.json({ error: "dream loop is disabled" }, { status: 409 });
    const input = asObject(await request.json());
    const repo = configuredDreamRepo(String(input.repo || ""));
    if (!repo) return Response.json({ error: "repository is not configured for dreaming" }, { status: 403 });
    if (dreamBusy || !db.beginManualDream(repo)) return Response.json({ error: "dream analysis is already running" }, { status: 409 });
    void executeDream(repo);
    return Response.json({ accepted: true, repo }, { status: 202 });
  }
  const dreamAction = url.pathname.match(/^\/api\/dreams\/([a-f0-9]{24})\/(approve|reject|dispatch)$/);
  if (request.method === "POST" && dreamAction) {
    const proposal = db.getDream(dreamAction[1]!);
    if (!proposal) return Response.json({ error: "dream proposal not found" }, { status: 404 });
    const action = dreamAction[2];
    if (action === "reject") {
      const changed = db.transitionDream(proposal.id, ["pending", "approved", "issued", "ready"], "rejected");
      return Response.json(changed ?? proposal, { status: changed ? 200 : 409 });
    }
    if (action === "dispatch") return dispatchDream(proposal);
    if (proposal.status === "failed" && proposal.issueNumber) {
      const retried = db.retryFailedEnsemble(proposal.repo, proposal.issueNumber);
      if (!retried) return Response.json({ error: "no failed ensemble jobs are available to retry" }, { status: 409 });
      const issued = db.transitionDream(proposal.id, ["failed"], "issued", { error: null });
      return Response.json({ proposal: issued, retried });
    }
    if (proposal.status !== "pending") return Response.json({ error: `dream proposal is ${proposal.status}` }, { status: 409 });
    return publishDreamIssue(proposal);
  }
  const action = url.pathname.match(/^\/api\/proposals\/([a-f0-9]{24})\/(approve|reject)$/);
  if (request.method === "POST" && action) {
    const proposal = db.getProposal(action[1]!);
    if (!proposal) return Response.json({ error: "proposal not found" }, { status: 404 });
    if (action[2] === "reject") {
      const changed = db.transitionProposal(proposal.id, ["pending", "approved"], "rejected");
      return Response.json(changed ?? proposal, { status: changed ? 200 : 409 });
    }
    if (proposal.status !== "pending") return Response.json({ error: `proposal is ${proposal.status}` }, { status: 409 });
    try {
      const snapshot = inspectWorkspace(proposal.workspaceKey, proposal.headSha);
      if (snapshot.baseSha !== proposal.baseSha || snapshot.diffSha256 !== proposal.diffSha256) {
        const conflicted = db.transitionProposal(proposal.id, ["pending"], "conflicted", { error: "Workspace changed before approval" });
        return Response.json(conflicted, { status: 409 });
      }
    } catch (error) {
      const conflicted = db.transitionProposal(proposal.id, ["pending"], "conflicted", { error: message(error) });
      return Response.json(conflicted, { status: 409 });
    }
    const approved = db.transitionProposal(proposal.id, ["pending"], "approved")!;
    const resumed = await retryIssue(proposal.repo, proposal.issueNumber);
    return Response.json({ proposal: approved, resumed });
  }
  if (request.method === "POST" && url.pathname === "/api/manual/triage") {
    const input = asObject(await request.json());
    const ref = String(input.issue || "").trim();
    if (!validIssueRef(ref)) return Response.json({ error: "issue must be owner/repo#N" }, { status: 400 });
    const [repo] = ref.split("#");
    if (!allowedRepos.has(normalizeRepo(repo))) return Response.json({ error: "repository not allowed" }, { status: 403 });
    return passthrough(await triggerRoboOmp({ mode: "triage", issue: ref }));
  }
  if (request.method === "POST" && url.pathname === "/api/manual/review") {
    const input = asObject(await request.json());
    const repo = normalizeRepo(input.repo);
    const prNumber = Number(input.prNumber);
    if (!allowedRepos.has(repo)) return Response.json({ error: "repository not allowed" }, { status: 403 });
    if (!Number.isSafeInteger(prNumber) || prNumber < 1) return Response.json({ error: "prNumber is invalid" }, { status: 400 });
    return manualReview(repo, prNumber);
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

async function manualReview(repo: string, prNumber: number): Promise<Response> {
  const queryRepo = `/gh/v1/repo?repo=${encodeURIComponent(repo)}`;
  const queryPr = `/gh/v1/pull_request?repo=${encodeURIComponent(repo)}&number=${prNumber}`;
  const [repoResponse, prResponse] = await Promise.all([
    forwardSigned("GET", queryRepo, new Uint8Array()),
    forwardSigned("GET", queryPr, new Uint8Array()),
  ]);
  if (!repoResponse.ok) return passthrough(repoResponse);
  if (!prResponse.ok) return passthrough(prResponse);
  const repoInfo = await repoResponse.json() as Record<string, unknown>;
  const pr = await prResponse.json() as Record<string, unknown>;
  const payload = {
    action: "opened",
    pull_request: {
      number: prNumber,
      title: String(pr.title || ""),
      body: String(pr.body || ""),
      state: String(pr.state || "open"),
      draft: Boolean(pr.draft),
      user: { login: String(pr.author || asObject(pr.user).login || "unknown") },
    },
    repository: {
      full_name: repo,
      default_branch: String(repoInfo.default_branch || "main"),
      clone_url: String(repoInfo.clone_url || `https://github.com/${repo}.git`),
      private: Boolean(repoInfo.private),
    },
  };
  const body = Buffer.from(JSON.stringify(payload));
  const signature = createHmac("sha256", webhookSecret).update(body).digest("hex");
  const response = await fetch(`${stripSlash(config.orchestratorUrl)}/webhook/github`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": "pull_request",
      "X-GitHub-Delivery": `persephone-review-${repo.replace("/", "-")}-${prNumber}-${Date.now()}`,
      "X-Hub-Signature-256": `sha256=${signature}`,
    },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  return passthrough(response);
}

async function processDreamSchedule(): Promise<void> {
  if (!config.dream.enabled || dreamBusy) return;
  const repo = db.claimDueDream(config.dream.intervalMinutes * 60_000);
  if (repo) void executeDream(repo);
}

async function processDreamReconciliation(): Promise<void> {
  for (const proposal of db.listDreams().filter((item) => item.status === "issued" && item.issueNumber)) {
    await reconcileDreamIssue(proposal.repo, proposal.issueNumber!);
  }
}

async function executeDream(repo: string): Promise<void> {
  dreamBusy = true;
  let worktree = "";
  let poolDir = "";
  let workerKey = "";
  try {
    if (db.hasPendingDream(repo)) {
      console.log(`[persephone-github] dream skipped for ${repo}: review its pending proposal first`);
      db.finishDreamRun(repo);
      return;
    }
    const prepared = await prepareDreamWorktree(repo);
    poolDir = prepared.poolDir;
    worktree = prepared.worktree;
    workerKey = `github-dream:${normalizeRepo(repo)}:${Date.now()}`;
    const worker = await dreamPool.acquire({
      key: workerKey,
      command: process.env.PERSEPHONE_DREAM_OMP_COMMAND || "omp",
      profile: config.dream.profile,
      cwd: worktree,
      provider: config.dream.provider ?? null,
      model: config.dream.model ?? null,
      thinking: config.dream.thinking ?? null,
      extraArgs: ["--no-session", "--no-extensions", "--extension=/persephone/src/extension.ts", "--tools=read,grep,glob,web_search,browser", "--no-lsp", "--no-skills", "--approval-mode=yolo"],
      scrubEnv: workerSecretNames,
      onSession: () => undefined,
      onUiRequest: async () => ({ confirmed: false, cancelled: true, reason: "Dream analysis is read-only and non-interactive" }),
    });
    try {
      const result = await worker.runPrompt(dreamPrompt(repo, prepared.baseSha));
      const decision = parseDreamDecision(result.text);
      if (decision.action === "skip") {
        console.log(`[persephone-github] dream skipped for ${repo}: ${decision.reason}`);
      } else {
        const id = sha256(`${normalizeRepo(repo)}\n${prepared.baseSha}\n${decision.title}\n${decision.issueBody}`).slice(0, 24);
        const proposal = db.putDream({
          id, repo, baseSha: prepared.baseSha, title: decision.title,
          issueBody: decision.issueBody, rationale: decision.rationale,
          implementationBrief: decision.implementationBrief,
        });
        if (config.dream.automatic) {
          const response = await publishDreamIssue(proposal);
          if (!response.ok) throw new Error(`automatic dream publication failed: ${response.status} ${(await response.text()).slice(0, 500)}`);
        } else {
          console.log(`[persephone-github] dream proposal ${proposal.id} is ready for human review`);
        }
      }
    } finally {
      worker.release();
      await dreamPool.drop(workerKey);
      workerKey = "";
    }
    db.finishDreamRun(repo);
  } catch (error) {
    const detail = message(error);
    console.error(`[persephone-github] dream analysis failed for ${repo}: ${detail}`);
    db.finishDreamRun(repo, detail);
  } finally {
    if (workerKey) await dreamPool.drop(workerKey).catch(() => undefined);
    cleanupDreamWorktree(poolDir, worktree);
    dreamBusy = false;
  }
}

async function prepareDreamWorktree(repo: string): Promise<{ poolDir: string; worktree: string; baseSha: string }> {
  const repoTarget = `/gh/v1/repo?repo=${encodeURIComponent(repo)}`;
  const repoResponse = await forwardSigned("GET", repoTarget, new Uint8Array());
  if (!repoResponse.ok) throw new Error(`repository lookup failed: ${repoResponse.status} ${(await repoResponse.text()).slice(0, 500)}`);
  const info = await repoResponse.json() as Record<string, unknown>;
  const cloneUrl = String(info.clone_url || "");
  const defaultBranch = String(info.default_branch || "main");
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+(?:\.git)?$/i.test(cloneUrl)) throw new Error("native proxy returned an invalid clone URL");

  const expectedPool = path.join(config.workspaceRoot, "_pool", repo.replace("/", "__"));
  const endpoint = existsSync(path.join(expectedPool, ".git")) ? "/gh/v1/git/fetch" : "/gh/v1/git/clone";
  const payload = endpoint.endsWith("/fetch")
    ? { repo }
    : { repo, clone_url: cloneUrl, default_branch: defaultBranch };
  const poolResponse = await forwardSigned("POST", endpoint, Buffer.from(JSON.stringify(payload)));
  if (!poolResponse.ok) throw new Error(`native ${endpoint} failed: ${poolResponse.status} ${(await poolResponse.text()).slice(0, 500)}`);
  const poolResult = await poolResponse.json() as Record<string, unknown>;
  const poolDir = path.resolve(String(poolResult.pool_dir || expectedPool));
  if (!isChildPath(path.join(config.workspaceRoot, "_pool"), poolDir)) throw new Error("native proxy returned a pool path outside workspaceRoot/_pool");
  const baseSha = git(poolDir, ["rev-parse", `refs/remotes/origin/${defaultBranch}`]).trim();
  if (!/^[0-9a-f]{40,64}$/i.test(baseSha)) throw new Error("could not resolve the repository default branch");

  const worktree = path.resolve(config.dream.cwdRoot, repo.replace("/", "__"), `${Date.now()}-${randomUUID()}`);
  if (!isChildPath(config.dream.cwdRoot, worktree)) throw new Error("refusing dream worktree outside configured root");
  mkdirSync(path.dirname(worktree), { recursive: true, mode: 0o700 });
  git(poolDir, ["worktree", "add", "--detach", worktree, baseSha]);
  return { poolDir, worktree, baseSha };
}

function cleanupDreamWorktree(poolDir: string, worktree: string): void {
  if (!worktree || !isChildPath(config.dream.cwdRoot, worktree)) return;
  if (poolDir && existsSync(poolDir)) {
    spawnSync("git", ["-c", `safe.directory=${poolDir}`, "worktree", "remove", "--force", worktree], {
      cwd: poolDir, encoding: "utf8", timeout: 30_000,
    });
  }
  if (existsSync(worktree)) rmSync(worktree, { recursive: true, force: true });
}

function dreamPrompt(repo: string, baseSha: string): string {
  if (!existsSync(config.dream.promptFile)) throw new Error(`Dream prompt missing: ${config.dream.promptFile}`);
  const role = readFileSync(config.dream.promptFile, "utf8").trim();
  return `${role}\n\nRepository: ${repo}\nExact read-only base commit: ${baseSha}\n` +
    "Inspect this checkout carefully. Return one grounded proposal or skip according to the contract.";
}

async function publishDreamIssue(proposal: DreamProposal): Promise<Response> {
  const marked = db.transitionDream(proposal.id, ["pending"], "approved");
  if (!marked) return Response.json({ error: `dream proposal is ${proposal.status}` }, { status: 409 });
  try {
    const authorization = config.dream.automatic ? "timer-authorized" : "approved by a human";
    const body = `${proposal.issueBody}\n\n## Why Persephone proposed this\n\n${proposal.rationale}\n\n` +
      `## Proposed implementation brief\n\n${proposal.implementationBrief}\n\n` +
      `_Generated from an isolated read-only analysis of commit \`${proposal.baseSha}\`. Issue creation was ${authorization}. Implementation waits for the three-person ensemble; publication remains governed by the configured exact-diff gate._`;
    const issue = await createDreamIssue(proposal, body);
    const issueNumber = Number(issue.number);
    const sourceId = Number(issue.id);
    if (!Number.isSafeInteger(issueNumber) || issueNumber < 1 || !Number.isSafeInteger(sourceId) || sourceId < 1) {
      throw new Error("issue-only proxy returned an invalid issue identity");
    }
    const issued = db.transitionDream(proposal.id, ["approved"], "issued", {
      issueNumber, issueUrl: String(issue.url || ""), error: null,
    })!;
    if (config.ensemble.enabled) {
      enqueueEnsemblePost(proposal.repo, {
        id: sourceId, number: issueNumber, title: proposal.title, body, html_url: String(issue.url || ""),
      }, {
        id: sourceId, body, html_url: String(issue.url || ""),
      });
      await reconcileDreamIssue(proposal.repo, issueNumber);
    } else {
      const ready = db.transitionDream(proposal.id, ["issued"], "ready", { error: null })!;
      if (config.dream.automatic) return dispatchDream(ready);
    }
    return Response.json({ proposal: db.getDream(proposal.id), issue });
  } catch (error) {
    const failed = db.transitionDream(proposal.id, ["approved", "issued"], "failed", { error: message(error) });
    return Response.json({ error: message(error), proposal: failed }, { status: 502 });
  }
}

async function reconcileDreamIssue(repo: string, issueNumber: number): Promise<void> {
  const proposal = db.findDreamByIssue(repo, issueNumber);
  if (!proposal || proposal.status !== "issued") return;
  const progress = db.ensembleProgress(repo, issueNumber, config.ensemble.personas.map((persona) => persona.id));
  if (!progress.complete) return;
  if (progress.failed.length) {
    db.transitionDream(proposal.id, ["issued"], "failed", {
      error: `Ensemble sidecars failed for: ${progress.failed.join(", ")}. Retry from the dashboard after correcting the identity or service.`,
    });
    return;
  }
  const ready = db.transitionDream(proposal.id, ["issued"], "ready", { error: null });
  if (ready && config.dream.automatic) {
    const response = await dispatchDream(ready);
    if (!response.ok) console.error(`[persephone-github] automatic dispatch failed for ${ready.id}: ${response.status}`);
  }
}

async function dispatchDream(proposal: DreamProposal): Promise<Response> {
  if (proposal.status !== "ready" || !proposal.issueNumber) {
    return Response.json({ error: `dream proposal is ${proposal.status}; ensemble deliberation must finish first` }, { status: 409 });
  }
  try {
    const triage = await triggerRoboOmp({ mode: "triage", issue: `${proposal.repo}#${proposal.issueNumber}` });
    if (!triage.ok) throw new Error(`native RoboOMP triage failed: ${triage.status} ${(await triage.text()).slice(0, 500)}`);
    const directive = await sendDreamDirective(proposal, proposal.issueNumber, proposal.issueBody);
    if (!directive.ok) throw new Error(`native RoboOMP directive failed: ${directive.status} ${(await directive.text()).slice(0, 500)}`);
    const dispatched = db.transitionDream(proposal.id, ["ready"], "dispatched", { error: null });
    return Response.json({
      proposal: dispatched,
      triage: await triage.json().catch(() => ({})),
      directive: await directive.json().catch(() => ({})),
    });
  } catch (error) {
    const ready = db.transitionDream(proposal.id, ["ready"], "ready", { error: message(error) });
    return Response.json({ error: message(error), proposal: ready }, { status: 502 });
  }
}

async function createDreamIssue(proposal: DreamProposal, body: string): Promise<Record<string, unknown>> {
  const key = requiredSecret(config.dream.issueProxyKeyEnv);
  const target = "/v1/issue";
  const payload = Buffer.from(JSON.stringify({ repo: proposal.repo, title: proposal.title, body, sourceKey: proposal.id }));
  const headers = signInternalRequest(key, "POST", target, payload);
  headers.set("Content-Type", "application/json");
  const response = await fetch(`${stripSlash(config.dream.issueProxyUrl)}${target}`, {
    method: "POST", headers, body: payload, signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(`Issue proxy failed: ${String(result.error || response.status)}`);
  if (normalizeLogin(result.login) !== mainBotLogin) throw new Error("Issue proxy identity did not match persephoneBotLogin");
  return result;
}

async function sendDreamDirective(proposal: DreamProposal, issueNumber: number, issueBody: string): Promise<Response> {
  const repoResponse = await forwardSigned("GET", `/gh/v1/repo?repo=${encodeURIComponent(proposal.repo)}`, new Uint8Array());
  if (!repoResponse.ok) return repoResponse;
  const repoInfo = await repoResponse.json() as Record<string, unknown>;
  const payload = {
    action: "created",
    comment: {
      id: Date.now(),
      body: `@${config.persephoneBotLogin} This issue completed Persephone's configured ensemble deliberation and was dispatched ${config.dream.automatic ? "by the explicitly enabled timer policy" : `by ${config.dream.directiveAuthor}`}. Implement the approved brief below, verify it against the repository, and submit the resulting branch through the normal publication gate.\n\n${proposal.implementationBrief}\n\nAfter opening the PR, post its link on this issue and mention @${config.dream.directiveAuthor} for review.`,
      user: { login: config.dream.directiveAuthor },
      author_association: "OWNER",
    },
    issue: {
      number: issueNumber,
      title: proposal.title,
      body: issueBody,
      state: "open",
      user: { login: config.persephoneBotLogin },
    },
    repository: {
      full_name: proposal.repo,
      default_branch: String(repoInfo.default_branch || "main"),
      clone_url: String(repoInfo.clone_url || `https://github.com/${proposal.repo}.git`),
      private: Boolean(repoInfo.private),
      owner: { login: proposal.repo.split("/")[0], type: "User" },
    },
    sender: { login: config.dream.directiveAuthor },
  };
  return sendSignedWebhook("issue_comment", `persephone-dream-directive-${proposal.id}`, payload);
}

async function sendSignedWebhook(event: string, delivery: string, payload: Record<string, unknown>): Promise<Response> {
  const body = Buffer.from(JSON.stringify(payload));
  const signature = createHmac("sha256", webhookSecret).update(body).digest("hex");
  return fetch(`${stripSlash(config.orchestratorUrl)}/webhook/github`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json", "X-GitHub-Event": event,
      "X-GitHub-Delivery": delivery, "X-Hub-Signature-256": `sha256=${signature}`,
    },
    body,
    signal: AbortSignal.timeout(30_000),
  });
}

function enqueueEnsemblePost(repo: string, issue: Record<string, unknown>, source: Record<string, unknown>): void {
  const issueNumber = Number(issue.number);
  const sourceCommentId = Number(source.id);
  if (!Number.isSafeInteger(issueNumber) || !Number.isSafeInteger(sourceCommentId)) return;
  for (const persona of config.ensemble.personas) {
    db.enqueueEnsemble({
      personaId: persona.id,
      repo,
      issueNumber,
      sourceCommentId,
      sourceBody: String(source.body || ""),
      issueTitle: String(issue.title || ""),
      issueBody: String(issue.body || ""),
      sourceUrl: String(source.html_url || issue.html_url || ""),
    });
  }
}

async function processEnsembleQueue(): Promise<void> {
  if (!config.ensemble.enabled || ensembleBusy) return;
  const job = db.claimEnsemble();
  if (!job) return;
  ensembleBusy = true;
  try {
    const persona = config.ensemble.personas.find((item) => item.id === job.personaId);
    if (!persona) throw new Error(`Unknown persona ${job.personaId}`);
    const prompt = ensemblePrompt(persona, job);
    const worker = await ensemblePool.acquire({
      key: `github-ensemble:${job.id}`,
      command: process.env.PERSEPHONE_ENSEMBLE_OMP_COMMAND || "omp",
      profile: config.ensemble.profile,
      cwd: config.ensemble.cwd,
      provider: config.ensemble.provider ?? null,
      model: config.ensemble.model ?? null,
      thinking: config.ensemble.thinking ?? null,
      extraArgs: ["--no-session", "--no-tools"],
      scrubEnv: workerSecretNames,
      onSession: () => undefined,
      onUiRequest: async () => ({ confirmed: false, cancelled: true, reason: "Ensemble workers are non-interactive" }),
    });
    try {
      const result = await worker.runPrompt(prompt);
      const decision = parseEnsembleDecision(result.text);
      if (decision.action === "skip") {
        db.finishEnsemble(job.id, "skipped", undefined, decision.reason);
      } else {
        const posted = await postPersonaComment(persona, job, decision.body);
        db.finishEnsemble(job.id, "commented", decision.body, `comment ${String(posted.id || "")} ${String(posted.url || "")}`.trim());
      }
    } finally {
      worker.release();
      await ensemblePool.drop(`github-ensemble:${job.id}`);
    }
  } catch (error) {
    db.finishEnsemble(job.id, "failed", undefined, message(error));
  } finally {
    ensembleBusy = false;
  }
    try {
      await reconcileDreamIssue(job.repo, job.issueNumber);
    } catch (error) {
      console.error(`[persephone-github] dream reconciliation failed for ${job.repo}#${job.issueNumber}: ${message(error)}`);
    }
}

function ensemblePrompt(persona: GitHubEnsemblePersona, job: EnsembleJob): string {
  if (!existsSync(persona.promptFile)) throw new Error(`Persona prompt missing: ${persona.promptFile}`);
  const role = readFileSync(persona.promptFile, "utf8").trim();
  return `${role}\n\nYou are one member of Persephone's GitHub ensemble. Evaluate the post below independently.\n\n` +
    `Hard contract:\n- You have no tools and no GitHub credentials.\n- Post exactly one genuinely useful technical observation, tradeoff, risk, correction, or precise question.\n- If you find no objection, ask the one concrete acceptance or compatibility question your persona would need answered; never substitute praise, paraphrase, filler, or roleplay-only banter.\n- Do not claim that you tested or inspected anything not present below.\n- Keep the comment under 1200 characters.\n- Return only JSON: {"action":"comment","body":"..."}. Use skip only when the supplied material is malformed or no defensible technical contribution is possible.\n\n` +
    `Repository: ${job.repo}\nThread: #${job.issueNumber} ${job.issueTitle}\nThread body:\n${job.issueBody.slice(0, 12_000)}\n\n` +
    `Persephone post (${job.sourceUrl}):\n${job.sourceBody.slice(0, 12_000)}`;
}

async function postPersonaComment(persona: GitHubEnsemblePersona, job: EnsembleJob, body: string): Promise<Record<string, unknown>> {
  const key = requiredSecret(persona.commentProxyKeyEnv);
  const payload = Buffer.from(JSON.stringify({
    repo: job.repo,
    number: job.issueNumber,
    body,
    sourceKey: `${persona.id}:${job.sourceCommentId}`,
  }));
  const target = "/v1/comment";
  const headers = signInternalRequest(key, "POST", target, payload);
  headers.set("Content-Type", "application/json");
  const response = await fetch(`${stripSlash(persona.commentProxyUrl)}${target}`, {
    method: "POST", headers, body: payload, signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(`Comment proxy ${persona.id} failed: ${String(result.error || response.status)}`);
  if (normalizeLogin(result.login) !== normalizeLogin(persona.botLogin)) throw new Error(`Comment proxy identity mismatch for ${persona.id}`);
  return result;
}

interface DiffSnapshot { baseSha: string; diffSha256: string; text: string; truncated: boolean }

function inspectWorkspace(workspaceKey: string, expectedHead: string): DiffSnapshot {
  const repoDir = path.join(config.workspaceRoot, workspaceKey, "repo");
  if (!existsSync(path.join(repoDir, ".git"))) throw new Error(`RoboOMP workspace not found: ${workspaceKey}`);
  const head = git(repoDir, ["rev-parse", "HEAD"]).trim();
  if (head !== expectedHead) throw new Error(`workspace HEAD drifted: expected ${expectedHead}, found ${head}`);
  const originHead = git(repoDir, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]).trim();
  if (!originHead.startsWith("refs/remotes/origin/")) throw new Error("workspace has no canonical origin/HEAD");
  const baseSha = git(repoDir, ["merge-base", head, originHead]).trim();
  const stat = git(repoDir, ["diff", "--stat", "--no-ext-diff", `${baseSha}...${head}`]);
  let diff = "";
  let truncated = false;
  try {
    diff = git(repoDir, ["diff", "--no-ext-diff", "--binary", `${baseSha}...${head}`], config.proposalMaxDiffBytes + 1);
    if (Buffer.byteLength(diff) > config.proposalMaxDiffBytes) {
      diff = diff.slice(0, config.proposalMaxDiffBytes);
      truncated = true;
    }
  } catch (error) {
    truncated = true;
    diff = `[Full diff exceeded the ${config.proposalMaxDiffBytes}-byte review cap. Exact approval remains bound to base/head SHAs.]\n`;
  }
  const text = `Base: ${baseSha}\nHead: ${head}\n\n${stat}\n${diff}${truncated ? "\n[diff display truncated]\n" : ""}`;
  return { baseSha, diffSha256: sha256(`${baseSha}\n${head}`), text, truncated };
}

function git(cwd: string, args: string[], maxBuffer = 8_000_000): string {
  const result = spawnSync("git", ["-c", `safe.directory=${cwd}`, ...args], { cwd, encoding: "utf8", maxBuffer });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `git ${args[0]} failed`).trim());
  return result.stdout;
}

async function retryIssue(repo: string, issueNumber: number): Promise<Record<string, unknown>> {
  if (!replayToken) return { attempted: false, reason: `${config.replayTokenEnv} is unset; retry from the RoboOMP dashboard` };
  const response = await triggerRoboOmp({ mode: "retry", issue: `${repo}#${issueNumber}` });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  return { attempted: true, ok: response.ok, status: response.status, body };
}

async function triggerRoboOmp(payload: Record<string, unknown>): Promise<Response> {
  if (!replayToken) return Response.json({ error: `${config.replayTokenEnv} is required for manual triggers` }, { status: 503 });
  return fetch(`${stripSlash(config.orchestratorUrl)}/api/trigger`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Robomp-Replay-Token": replayToken },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
}

async function forwardProxy(method: string, target: string, body: Uint8Array, sourceHeaders: Headers): Promise<Response> {
  const headers = new Headers();
  for (const name of ["content-type", "x-robomp-timestamp", "x-robomp-sig"]) {
    const value = sourceHeaders.get(name);
    if (value) headers.set(name, value);
  }
  return fetch(`${stripSlash(config.upstreamProxyUrl)}${target}`, {
    method,
    headers,
    ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.from(body) }),
    signal: AbortSignal.timeout(120_000),
  });
}

async function forwardSigned(method: string, target: string, body: Uint8Array): Promise<Response> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = roboOmpSignature(method, target, timestamp, body);
  return fetch(`${stripSlash(config.upstreamProxyUrl)}${target}`, {
    method,
    headers: {
      "X-Robomp-Timestamp": timestamp,
      "X-Robomp-Sig": signature,
      ...(body.length ? { "Content-Type": "application/json" } : {}),
    },
    ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.from(body) }),
    signal: AbortSignal.timeout(30_000),
  });
}

function verifyRoboOmpHmac(method: string, target: string, body: Uint8Array, headers: Headers): boolean {
  const timestamp = headers.get("x-robomp-timestamp") || "";
  const supplied = headers.get("x-robomp-sig") || "";
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds) || Math.abs(Math.floor(Date.now() / 1000) - seconds) > 30) return false;
  return safeEqual(roboOmpSignature(method, target, timestamp, body), supplied);
}

function roboOmpSignature(method: string, target: string, timestamp: string, body: Uint8Array): string {
  const canonical = `${method.toUpperCase()}\n${target}\n${timestamp}\n${sha256(body)}`;
  return createHmac("sha256", proxyHmacKey).update(canonical).digest("hex");
}

function verifyGitHub(body: Uint8Array, signature: string | null): boolean {
  if (!signature?.startsWith("sha256=")) return false;
  return safeEqual(createHmac("sha256", webhookSecret).update(body).digest("hex"), signature.slice(7));
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorized(request: Request): boolean {
  const supplied = request.headers.get("authorization") || "";
  return supplied.startsWith("Bearer ") && safeEqual(approvalToken, supplied.slice(7));
}

function githubError(kind: "git" | "github", status: number, detail: string): Response {
  return Response.json({ error: {
    kind,
    status,
    message: detail,
    cmd: kind === "git" ? ["git", "push"] : undefined,
    returncode: kind === "git" ? 75 : undefined,
    stdout: "",
    stderr: detail,
  } }, { status });
}

async function passthrough(response: Response): Promise<Response> {
  return new Response(await response.arrayBuffer(), { status: response.status, headers: copyHeaders(response.headers) });
}

function copyHeaders(headers: Headers): Headers {
  const result = new Headers({ "Cache-Control": "no-store" });
  const contentType = headers.get("content-type");
  if (contentType) result.set("Content-Type", contentType);
  return result;
}

async function cloneResponseJson(response: Response): Promise<Record<string, unknown>> {
  return response.clone().json() as Promise<Record<string, unknown>>;
}

function parseObject(bytes: Uint8Array): Record<string, unknown> {
  const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected JSON object");
  return value as Record<string, unknown>;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeLogin(value: unknown): string {
  return String(value || "").trim().replace(/^@/, "").replace(/\[bot\]$/i, "").toLowerCase();
}

function normalizeRepo(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function validWorkspaceKey(repo: string, key: string): boolean {
  return key.toLowerCase().startsWith(`${repo.replace("/", "__")}__`.toLowerCase()) && /^[a-z0-9_.-]+__[a-z0-9_.-]+__\d+$/i.test(key) && !key.includes("..");
}

function configuredDreamRepo(value: string): string | null {
  const wanted = normalizeRepo(value);
  return config.dream.repositories.find((repo) => normalizeRepo(repo) === wanted) ?? null;
}

function isChildPath(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function workspaceIssueNumber(key: string): number {
  const value = Number(key.slice(key.lastIndexOf("__") + 2));
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("workspace key has no issue number");
  return value;
}

function validIssueRef(value: string): boolean {
  return /^[^/\s]+\/[^#\s]+#\d+$/.test(value);
}

function requiredSecret(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function envPort(name: string, fallback: number): number {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name} must be a valid port`);
  return value;
}

function stripSlash(value: string): string { return value.replace(/\/+$/, ""); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

async function shutdown(): Promise<void> {
  clearInterval(ensembleTimer);
  clearInterval(dreamTimer);
  clearInterval(dreamReconcileTimer);
  server.stop(false);
  await ensemblePool.close();
  await dreamPool.close();
  db.close();
  process.exit(0);
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Persephone · RoboOMP approvals</title><style>
:root{color-scheme:dark;font:15px system-ui;background:#121116;color:#eee}body{max-width:1500px;margin:auto;padding:24px}button,input{font:inherit;background:#24212b;color:#eee;border:1px solid #51485f;border-radius:7px;padding:8px}button{cursor:pointer}.grid{display:grid;grid-template-columns:360px 1fr;gap:16px}.card{border:1px solid #403948;border-radius:10px;padding:14px;margin:8px 0;background:#1a181f}.pending,.issued{border-color:#a87f32}.approved,.ready,.dispatched,.published{border-color:#3e996a}.rejected,.conflicted,.failed{border-color:#a34d58}pre{white-space:pre-wrap;overflow:auto;max-height:70vh;background:#0c0b0e;padding:14px;border-radius:8px}.row{display:flex;gap:8px;flex-wrap:wrap}small{color:#aaa}@media(max-width:900px){.grid{grid-template-columns:1fr}}</style></head>
<body><h1>Persephone · RoboOMP</h1><p>Lifecycle: inspect a grounded proposal, publish its issue, let all three identities deliberate, then dispatch native RoboOMP. Implementation diffs remain exact and reviewable; nothing here merges a pull request.</p>
<div class="row"><input id="token" type="password" placeholder="approval token"><button onclick="saveToken()">Use token</button><button onclick="load()">Refresh</button></div>
<div class="card"><b>Manual native RoboOMP</b><div class="row"><input id="issue" placeholder="owner/repo#123"><button onclick="triage()">Triage issue</button><input id="repo" placeholder="owner/repo"><input id="pr" type="number" placeholder="PR"><button onclick="review()">Review PR diff</button></div><small>Both operations retain RoboOMP's repository allowlist, worktree isolation, durable queue, and OMP session behavior.</small></div>
<div class="card"><b>Read-only dream analysis</b><div class="row"><input id="dreamRepo" placeholder="configured owner/repo"><button onclick="runDream()">Analyze now</button></div><small>The analyzer may read the checkout and consult only the configured local Firecrawl/Camofox research services. Mode: ${config.dream.automatic ? "automatic issue, ensemble, dispatch, and exact-diff publication" : "human issue approval, human dispatch, and human exact-diff approval"}.</small><div id="dreams"></div></div>
<h2>Implementation diffs</h2>
<div class="grid"><div id="list"></div><div><div id="meta" class="card">Choose a proposal.</div><pre id="diff"></pre></div></div>
<script>
let token=sessionStorage.getItem('persephoneToken')||'';document.querySelector('#token').value=token;let proposals=[],dreams=[];
function saveToken(){token=document.querySelector('#token').value;sessionStorage.setItem('persephoneToken',token);load()}
async function api(path,options={}){options.headers={...(options.headers||{}),Authorization:'Bearer '+token,'Content-Type':'application/json'};const r=await fetch(path,options);const j=await r.json();if(!r.ok)throw new Error(j.error||JSON.stringify(j));return j}
function esc(v){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function dreamControls(d){if(d.status==='pending')return '<button onclick="actDream(\''+d.id+'\',\'approve\')">Publish issue for ensemble review</button><button onclick="actDream(\''+d.id+'\',\'reject\')">Reject proposal</button>';if(d.status==='issued')return '<small>Waiting for Opsec bro, longtimeuser4, and Ancient Guru.</small><button onclick="actDream(\''+d.id+'\',\'reject\')">Stop before dispatch</button>';if(d.status==='ready')return '<button onclick="actDream(\''+d.id+'\',\'dispatch\')">Dispatch native RoboOMP</button><button onclick="actDream(\''+d.id+'\',\'reject\')">Reject before dispatch</button>';if(d.status==='failed'&&d.issueNumber)return '<button onclick="actDream(\''+d.id+'\',\'approve\')">Retry failed ensemble identity</button>';if(d.status==='dispatched')return '<small>Native RoboOMP has been dispatched. Its exact implementation diff will appear below.</small>';return ''}
async function load(){try{[proposals,dreams]=await Promise.all([api('/api/proposals'),api('/api/dreams')]);document.querySelector('#list').innerHTML=proposals.map(p=>'<div class="card '+esc(p.status)+'" onclick="show(\''+p.id+'\')"><b>'+esc(p.repo)+'#'+p.issueNumber+'</b><br>'+esc(p.status)+' · '+p.id+'<br><small>'+esc(p.branch)+'<br>'+new Date(p.updatedAt).toLocaleString()+'</small></div>').join('')||'<div class="card">No implementation diffs.</div>';document.querySelector('#dreams').innerHTML=dreams.map(d=>'<div class="card '+esc(d.status)+'"><b>'+esc(d.repo)+' · '+esc(d.title)+'</b><br>'+esc(d.status)+' · '+d.id+(d.issueUrl?' · <a href="'+esc(d.issueUrl)+'" target="_blank" rel="noopener noreferrer">issue #'+d.issueNumber+'</a>':'')+'<br><small>base '+esc(d.baseSha)+' · '+new Date(d.updatedAt).toLocaleString()+'</small><p>'+esc(d.rationale)+'</p>'+(d.error?'<p>'+esc(d.error)+'</p>':'')+'<details><summary>Issue and implementation brief</summary><pre>'+esc(d.issueBody)+'\n\n--- implementation brief ---\n'+esc(d.implementationBrief)+'</pre></details><div class="row">'+dreamControls(d)+'</div></div>').join('')||'<p><small>No dream proposals.</small></p>'}catch(e){alert(e.message)}}
function show(id){const p=proposals.find(x=>x.id===id);document.querySelector('#meta').innerHTML='<b>'+esc(p.repo)+'#'+p.issueNumber+'</b> · '+esc(p.status)+'<br><small>base '+esc(p.baseSha)+'<br>head '+esc(p.headSha)+'</small><div class="row"><button onclick="act(\''+id+'\',\'approve\')">Approve exact diff</button><button onclick="act(\''+id+'\',\'reject\')">Reject</button></div>';document.querySelector('#diff').textContent=p.diffText}
async function act(id,action){try{await api('/api/proposals/'+id+'/'+action,{method:'POST'});await load();show(id)}catch(e){alert(e.message)}}
async function actDream(id,action){try{await api('/api/dreams/'+id+'/'+action,{method:'POST'});await load()}catch(e){alert(e.message)}}
async function runDream(){try{await api('/api/dreams/run',{method:'POST',body:JSON.stringify({repo:document.querySelector('#dreamRepo').value})});alert('Read-only analysis queued.');await load()}catch(e){alert(e.message)}}
async function triage(){try{alert(JSON.stringify(await api('/api/manual/triage',{method:'POST',body:JSON.stringify({issue:document.querySelector('#issue').value})}),null,2))}catch(e){alert(e.message)}}
async function review(){try{alert(JSON.stringify(await api('/api/manual/review',{method:'POST',body:JSON.stringify({repo:document.querySelector('#repo').value,prNumber:Number(document.querySelector('#pr').value)})}),null,2))}catch(e){alert(e.message)}}
load();
</script></body></html>`;
