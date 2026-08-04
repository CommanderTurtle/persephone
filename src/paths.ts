import os from "node:os";
import path from "node:path";

export function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return path.resolve(value);
}

export function configRoot(): string {
  return expandHome(process.env.PERSEPHONE_CONFIG_HOME || "~/.config/persephone");
}

export function stateRoot(): string {
  return expandHome(process.env.PERSEPHONE_STATE_HOME || "~/.local/state/persephone");
}

export function ompHome(): string {
  return expandHome(process.env.OMP_HOME || "~/.omp");
}

export function ompAgentDir(profile = "default"): string {
  const normalized = profile.trim();
  return !normalized || normalized === "default"
    ? path.join(ompHome(), "agent")
    : path.join(ompHome(), "profiles", normalized, "agent");
}

export function repoRoot(): string {
  return path.resolve(import.meta.dir, "..");
}

export function databasePath(): string {
  return path.join(stateRoot(), "persephone.sqlite");
}
