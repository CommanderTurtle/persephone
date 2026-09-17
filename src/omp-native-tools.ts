import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type OmpNativeToolStatus = "integrated" | "unchanged" | "missing" | "failed";

export interface OmpNativeToolResult {
  name: string;
  status: OmpNativeToolStatus;
  detail: string;
}

export interface OmpNativeToolCheck {
  check: string;
  ok: boolean;
  detail: string;
}

interface BunLanguageServerPackage {
  name: string;
  version: string;
  binaries: string[];
}

export const BUN_LANGUAGE_SERVER_PACKAGES: readonly BunLanguageServerPackage[] = [
  { name: "typescript-language-server", version: "6.0.0", binaries: ["typescript-language-server"] },
  { name: "typescript", version: "5.9.3", binaries: ["tsc"] },
  { name: "pyright", version: "1.1.414", binaries: ["pyright-langserver"] },
  { name: "bash-language-server", version: "5.7.1", binaries: ["bash-language-server"] },
  { name: "yaml-language-server", version: "1.24.0", binaries: ["yaml-language-server"] },
  {
    name: "vscode-langservers-extracted",
    version: "4.10.0",
    binaries: [
      "vscode-css-language-server",
      "vscode-eslint-language-server",
      "vscode-html-language-server",
      "vscode-json-language-server",
    ],
  },
] as const;

export const FSAC_VERSION = "0.84.0";

/**
 * Restore the small, practical user-space LSP set after OMP/Bun upgrades.
 * OMP itself remains pristine: it discovers these binaries through PATH and
 * reads the reconciled FsAutoComplete declaration from native profile config.
 */
export function ensureOmpNativeTools(): OmpNativeToolResult[] {
  return [ensureBunLanguageServers(), ensureFsAutoComplete()];
}

/** Read-only counterpart used by `persephone doctor`. */
export function inspectOmpNativeTools(): OmpNativeToolCheck[] {
  const checks: OmpNativeToolCheck[] = [];
  const installed = readGlobalBunDependencies();
  for (const entry of BUN_LANGUAGE_SERVER_PACKAGES) {
    const actual = installed[entry.name];
    checks.push({
      check: `omp-lsp:package:${entry.name}`,
      ok: actual === entry.version,
      detail: actual === entry.version ? entry.version : `installed ${actual || "missing"}; expected ${entry.version}`,
    });
    for (const binary of entry.binaries) {
      const resolved = Bun.which(binary);
      checks.push({
        check: `omp-lsp:binary:${binary}`,
        ok: Boolean(resolved),
        detail: resolved || "not found on PATH",
      });
    }
  }

  const fsac = installedDotnetToolVersion("fsautocomplete", dotnetToolPath());
  checks.push({
    check: "omp-lsp:package:fsautocomplete",
    ok: fsac.version === FSAC_VERSION,
    detail: fsac.error || (fsac.version === FSAC_VERSION
      ? FSAC_VERSION
      : `installed ${fsac.version || "missing"}; expected ${FSAC_VERSION}`),
  });
  const fsacBinary = Bun.which("fsautocomplete");
  checks.push({
    check: "omp-lsp:binary:fsautocomplete",
    ok: Boolean(fsacBinary),
    detail: fsacBinary || "not found on PATH",
  });
  return checks;
}

function ensureBunLanguageServers(): OmpNativeToolResult {
  const bun = Bun.which("bun");
  if (!bun) return { name: "omp-lsp:bun", status: "missing", detail: "bun was not found on PATH" };

  const installed = readGlobalBunDependencies();
  const drifted = BUN_LANGUAGE_SERVER_PACKAGES.filter((entry) => installed[entry.name] !== entry.version);
  const missingBefore = BUN_LANGUAGE_SERVER_PACKAGES.flatMap((entry) => entry.binaries)
    .filter((binary) => !Bun.which(binary));
  let changed = false;
  let installedNames: string[] = [];
  if (drifted.length > 0 || missingBefore.length > 0) {
    // A missing link can belong to a package whose version is already exact.
    // Reinstall the complete set in that case so Bun recreates every global bin.
    const requested = missingBefore.length > 0 ? [...BUN_LANGUAGE_SERVER_PACKAGES] : drifted;
    const specs = requested.map((entry) => `${entry.name}@${entry.version}`);
    const command = spawnSync(bun, ["install", "--global", "--exact", ...specs], {
      encoding: "utf8",
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
      env: childEnvironment(),
    });
    if (command.status !== 0) {
      return { name: "omp-lsp:bun", status: "failed", detail: cleanOutput(command) };
    }
    installedNames = requested.map((entry) => entry.name);
    changed = true;
  }

  const missing = BUN_LANGUAGE_SERVER_PACKAGES.flatMap((entry) => entry.binaries)
    .filter((binary) => !Bun.which(binary));
  if (missing.length > 0) {
    return {
      name: "omp-lsp:bun",
      status: "failed",
      detail: `Bun packages installed, but these executables are absent from PATH: ${missing.join(", ")}`,
    };
  }
  return {
    name: "omp-lsp:bun",
    status: changed ? "integrated" : "unchanged",
    detail: changed
      ? `Installed exact Bun language-server packages: ${installedNames.join(", ")}`
      : "Exact Bun language-server packages and executables are present",
  };
}

function ensureFsAutoComplete(): OmpNativeToolResult {
  const dotnet = Bun.which("dotnet");
  if (!dotnet) {
    return { name: "omp-lsp:fsautocomplete", status: "missing", detail: "dotnet was not found on PATH" };
  }
  const toolPath = dotnetToolPath();
  mkdirSync(toolPath, { recursive: true, mode: 0o700 });
  const installed = installedDotnetToolVersion("fsautocomplete", toolPath);
  if (installed.error) {
    return { name: "omp-lsp:fsautocomplete", status: "failed", detail: installed.error };
  }
  let changed = false;
  if (installed.version !== FSAC_VERSION) {
    const action = installed.version ? "update" : "install";
    const args = ["tool", action, "fsautocomplete", "--tool-path", toolPath, "--version", FSAC_VERSION];
    if (action === "update") args.push("--allow-downgrade");
    const command = spawnSync(dotnet, args, {
      encoding: "utf8",
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
      env: childEnvironment(),
    });
    if (command.status !== 0) {
      return { name: "omp-lsp:fsautocomplete", status: "failed", detail: cleanOutput(command) };
    }
    changed = true;
  }
  const binary = Bun.which("fsautocomplete");
  if (!binary) {
    return {
      name: "omp-lsp:fsautocomplete",
      status: "failed",
      detail: `${path.join(toolPath, "fsautocomplete")} was installed but is absent from PATH`,
    };
  }
  return {
    name: "omp-lsp:fsautocomplete",
    status: changed ? "integrated" : "unchanged",
    detail: `${binary} (${FSAC_VERSION})`,
  };
}

function globalBunPackageFile(): string {
  const root = process.env.BUN_INSTALL?.trim() || path.join(os.homedir(), ".bun");
  return path.join(root, "install", "global", "package.json");
}

function readGlobalBunDependencies(): Record<string, string> {
  const file = globalBunPackageFile();
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { dependencies?: unknown };
    if (!isRecord(parsed.dependencies)) return {};
    return Object.fromEntries(
      Object.entries(parsed.dependencies).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

function dotnetToolPath(): string {
  return path.join(os.homedir(), ".local", "bin");
}

function installedDotnetToolVersion(
  packageName: string,
  toolPath: string,
): { version: string | null; error?: string } {
  const dotnet = Bun.which("dotnet");
  if (!dotnet) return { version: null, error: "dotnet was not found on PATH" };
  const command = spawnSync(dotnet, ["tool", "list", "--tool-path", toolPath], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    env: childEnvironment(),
  });
  if (command.status !== 0) return { version: null, error: cleanOutput(command) };
  for (const line of String(command.stdout || "").split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields[0]?.toLowerCase() === packageName.toLowerCase()) return { version: fields[1] || null };
  }
  return { version: null };
}

function childEnvironment(): NodeJS.ProcessEnv {
  const bunRoot = process.env.BUN_INSTALL?.trim() || path.join(os.homedir(), ".bun");
  return {
    ...process.env,
    BUN_INSTALL: bunRoot,
    BUN_INSTALL_GLOBAL_DIR: path.join(bunRoot, "install", "global"),
    BUN_INSTALL_BIN: path.join(bunRoot, "bin"),
    OTEL_SDK_DISABLED: "true",
    DO_NOT_TRACK: "1",
  };
}

function cleanOutput(result: ReturnType<typeof spawnSync>): string {
  return result.error?.message || `${result.stdout || ""}\n${result.stderr || ""}`.trim()
    || `exit ${result.status ?? "unknown"}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
