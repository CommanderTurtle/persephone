#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureConfig, loadConfig } from "./config.ts";
import { validateCron } from "./cron.ts";
import { PersephoneDaemon } from "./daemon.ts";
import { PersephoneDatabase } from "./database.ts";
import { doctor } from "./doctor.ts";
import { integrate, restoreIntegrations } from "./integrate.ts";
import { repoRoot, stateRoot } from "./paths.ts";
import { installService, removeService, serviceAction, servicePath } from "./service.ts";

const [command = "help", ...args] = process.argv.slice(2);

try {
  switch (command) {
    case "init":
      await initialize(args.includes("--install-service"), args.includes("--start"));
      break;
    case "integrate":
      printIntegrations(integrate(loadConfig()));
      break;
    case "serve":
      await new PersephoneDaemon(loadConfig()).run();
      break;
    case "doctor":
      await runDoctor(args.includes("--integration-only"));
      break;
    case "status":
      await showStatus();
      break;
    case "start":
    case "stop":
    case "restart":
      process.exitCode = serviceAction(command);
      break;
    case "install-service":
      installService(loadConfig(), args.includes("--start"));
      console.log(`Installed ${servicePath()}`);
      break;
    case "uninstall":
      await uninstall();
      break;
    case "update":
      await update();
      break;
    case "schedule":
      schedule(args);
      break;
    case "route":
      route(args);
      break;
    case "git-agent":
      runGitAgent(args);
      break;
    case "zed":
      launchZed(args[0]);
      break;
    case "link-cli":
      linkCli();
      break;
    case "config":
      console.log((await import("./config.ts")).configPath());
      break;
    default:
      help();
      if (command !== "help" && command !== "--help" && command !== "-h") process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function initialize(withService: boolean, start: boolean): Promise<void> {
  linkCli();
  const { created } = ensureConfig();
  console.log(created ? "Created Persephone config and secret template." : "Persephone config already exists.");
  const config = loadConfig();
  printIntegrations(integrate(config));
  if (withService) installService(config, start);
  console.log("Persephone is initialized. Run `persephone doctor` for the read-only audit.");
}

async function runDoctor(integrationOnly = false): Promise<void> {
  const results = await doctor(loadConfig(), !integrationOnly);
  for (const result of results) console.log(`${result.ok ? "ok  " : "FAIL"}  ${result.check.padEnd(26)} ${result.detail}`);
  if (results.some((result) => !result.ok)) process.exitCode = 1;
}

async function showStatus(): Promise<void> {
  const config = loadConfig();
  const host = config.listen.host === "0.0.0.0" || config.listen.host === "::" ? "127.0.0.1" : config.listen.host;
  try {
    const token = process.env[config.listen.tokenEnv]?.trim();
    const headers = new Headers();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch(`http://${host}:${config.listen.port}/v1/status`, {
      headers,
      signal: AbortSignal.timeout(3000),
    });
    console.log(JSON.stringify(await response.json(), null, 2));
    if (!response.ok) process.exitCode = 1;
  } catch {
    console.log("Persephone daemon is not reachable.");
    process.exitCode = 1;
  }
}

function schedule(args: string[]): void {
  const [action = "list", ...rest] = args;
  const db = new PersephoneDatabase();
  try {
    if (action === "list") {
      console.log(JSON.stringify(db.listSchedules(), null, 2));
      return;
    }
    if (action === "remove") {
      if (!rest[0]) throw new Error("Usage: persephone schedule remove NAME");
      console.log(db.removeSchedule(rest[0]) ? `Removed ${rest[0]}` : `No schedule named ${rest[0]}`);
      return;
    }
    if (action !== "add" || rest.length < 3) {
      throw new Error('Usage: persephone schedule add NAME "CRON" "PROMPT" [--to CHANNEL:PEER] [--cwd PATH] [--profile NAME]');
    }
    const [name, cron, prompt, ...options] = rest as [string, string, string, ...string[]];
    validateCron(cron);
    const config = loadConfig();
    const destination = option(options, "--to");
    const split = destination?.indexOf(":") ?? -1;
    const record = db.putSchedule({
      name,
      cron,
      prompt,
      cwd: option(options, "--cwd") || config.omp.cwd,
      profile: option(options, "--profile") || config.omp.profile,
      channel: split > 0 ? destination!.slice(0, split) : null,
      peerId: split > 0 ? destination!.slice(split + 1) : null,
      enabled: true,
    });
    console.log(JSON.stringify(record, null, 2));
  } finally {
    db.close();
  }
}

function route(args: string[]): void {
  const [action = "list"] = args;
  if (action !== "list") throw new Error("Usage: persephone route list");
  const db = new PersephoneDatabase();
  try {
    console.log(JSON.stringify(db.listRoutes(), null, 2));
  } finally {
    db.close();
  }
}

async function update(): Promise<void> {
  const root = repoRoot();
  if (!existsSync(path.join(root, ".git"))) throw new Error("Persephone update requires a Git clone");
  const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  if (dirty.status !== 0 || dirty.stdout.trim()) throw new Error("Persephone working tree is not clean; update was not attempted");
  run("git", ["pull", "--ff-only"], root);
  run(Bun.which("bun") || "bun", ["install", "--frozen-lockfile"], root);
  printIntegrations(integrate(loadConfig()));
  const active = spawnSync("systemctl", ["--user", "is-active", "--quiet", "persephone.service"]);
  if (active.status === 0) serviceAction("restart");
}

async function uninstall(): Promise<void> {
  removeService();
  const restored = restoreIntegrations();
  const omp = Bun.which(loadConfig().omp.command);
  if (omp) {
    spawnSync(omp, ["plugin", "uninstall", "@commanderturtle/persephone"], {
      stdio: "inherit",
      env: { ...process.env, OTEL_SDK_DISABLED: "true" },
    });
  }
  const removedCli = unlinkCli();
  console.log(`Persephone service and plugin link were removed. Restored ${restored.length} integration value(s).`);
  if (removedCli) console.log(`Removed ${removedCli}.`);
  console.log("Config and SQLite state were preserved.");
}

function linkCli(): void {
  const target = path.join(repoRoot(), "src", "cli.ts");
  const directory = path.resolve(process.env.PERSEPHONE_BIN_DIR || path.join(os.homedir(), ".local", "bin"));
  const link = path.join(directory, "persephone");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(target, 0o755);
  if (existsSync(link) || isSymlink(link)) {
    if (!isSymlink(link) || path.resolve(path.dirname(link), readlinkSync(link)) !== target) {
      throw new Error(`Refusing to replace existing command: ${link}`);
    }
  } else {
    symlinkSync(target, link);
  }
  mkdirSync(stateRoot(), { recursive: true, mode: 0o700 });
  writeFileSync(cliLinkRecord(), `${link}\n`, { mode: 0o600 });
  console.log(`Linked ${link}`);
  const searchPath = (process.env.PATH || "").split(path.delimiter).map((entry) => path.resolve(entry));
  if (!searchPath.includes(directory)) console.log(`Add ${directory} to PATH to use the persephone command.`);
}

function unlinkCli(): string | null {
  const record = cliLinkRecord();
  if (!existsSync(record)) return null;
  const link = readFileSync(record, "utf8").trim();
  const target = path.join(repoRoot(), "src", "cli.ts");
  let removed: string | null = null;
  if (link && isSymlink(link) && path.resolve(path.dirname(link), readlinkSync(link)) === target) {
    rmSync(link);
    removed = link;
  }
  rmSync(record, { force: true });
  return removed;
}

function cliLinkRecord(): string {
  return path.join(stateRoot(), "cli-link");
}

function isSymlink(file: string): boolean {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

function launchZed(directory?: string): void {
  const zed = Bun.which("zed");
  if (!zed) throw new Error("Zed was not found on PATH");
  const cwd = directory ? path.resolve(directory) : process.cwd();
  const child = spawnSync(zed, [cwd], { stdio: "inherit" });
  if (child.status !== 0) throw new Error("Zed failed to launch");
  console.log("Use OMP's native `omp acp` agent entry in Zed; Persephone does not replace the ACP bridge.");
}

function runGitAgent(args: string[]): void {
  const script = path.join(repoRoot(), "scripts", "robomp.sh");
  if (!existsSync(script)) throw new Error(`Native RoboOMP lifecycle script is missing: ${script}`);
  chmodSync(script, 0o755);
  const child = spawnSync(script, args, {
    cwd: repoRoot(),
    stdio: "inherit",
    env: { ...process.env, OTEL_SDK_DISABLED: "true", DO_NOT_TRACK: "1" },
  });
  if (child.error) throw child.error;
  if (child.status !== 0) process.exitCode = child.status ?? 1;
}

function printIntegrations(results: ReturnType<typeof integrate>): void {
  for (const result of results) console.log(`${result.status.padEnd(10)} ${result.name.padEnd(22)} ${result.detail}`);
  if (results.some((result) => result.status === "failed")) process.exitCode = 1;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}

function help(): void {
  console.log(`Persephone — sovereign OMP control plane

  persephone init [--install-service] [--start]
  persephone integrate
  persephone serve
  persephone doctor | status
  persephone install-service [--start]
  persephone start | stop | restart
  persephone schedule list
  persephone schedule add NAME "CRON" "PROMPT" [--to CHANNEL:PEER]
  persephone schedule remove NAME
  persephone route list
  persephone git-agent help
  persephone zed [DIRECTORY]
  persephone update | uninstall
`);
}
