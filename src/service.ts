import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { repoRoot } from "./paths.ts";
import type { PersephoneConfig } from "./types.ts";

export function servicePath(): string {
  return path.join(os.homedir(), ".config", "systemd", "user", "persephone.service");
}

export function installService(config: PersephoneConfig, start: boolean): void {
  const bun = Bun.which("bun");
  if (!bun) throw new Error("Bun is required");
  const file = servicePath();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const cli = path.join(repoRoot(), "src", "cli.ts");
  const unit = `[Unit]
Description=Persephone OMP control plane
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${systemdEscape(config.omp.cwd)}
ExecStart=${systemdEscape(bun)} ${systemdEscape(cli)} serve
Environment=OTEL_SDK_DISABLED=true
Restart=on-failure
RestartSec=3
KillMode=mixed
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true
UMask=0077

[Install]
WantedBy=default.target
`;
  writeFileSync(file, unit, { mode: 0o600 });
  systemctl(["--user", "daemon-reload"]);
  systemctl(["--user", "enable", "persephone.service"]);
  if (start) systemctl(["--user", "restart", "persephone.service"]);
}

export function removeService(): void {
  systemctl(["--user", "disable", "--now", "persephone.service"], true);
  const file = servicePath();
  if (existsSync(file)) rmSync(file);
  systemctl(["--user", "daemon-reload"], true);
}

export function serviceAction(action: "start" | "stop" | "restart" | "status"): number {
  return systemctl(["--user", action, "persephone.service"], action === "status");
}

function systemctl(args: string[], allowFailure = false): number {
  const result = spawnSync("systemctl", args, { stdio: "inherit" });
  if (!allowFailure && result.status !== 0) throw new Error(`systemctl ${args.join(" ")} failed`);
  return result.status ?? 1;
}

function systemdEscape(value: string): string {
  if (/[\n\r]/.test(value)) throw new Error("Systemd path cannot contain a newline");
  return value.replace(/%/g, "%%").replace(/ /g, "\\x20");
}
