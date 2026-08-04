#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# ///
"""Install or update the official stable StablyAI Orca Debian package."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


RELEASE_API = "https://api.github.com/repos/stablyai/orca/releases/latest"
RELEASE_PREFIX = "/stablyai/orca/releases/download/"
PACKAGE_NAME = "orca-ide"
LAUNCHER = Path("/opt/Orca/orca-ide")
MAX_DEB_BYTES = 500 * 1024 * 1024


class OrcaDebError(RuntimeError):
    """Raised when the official Debian package cannot be handled safely."""


def _run(argv: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            argv,
            check=check,
            capture_output=True,
            text=True,
            timeout=900,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        rendered = " ".join(argv)
        raise OrcaDebError(f"command failed: {rendered}: {exc}") from exc


def _release() -> dict[str, Any]:
    request = urllib.request.Request(
        RELEASE_API,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "Persephone-Orca-Deb-Updater",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.loads(response.read(2 * 1024 * 1024).decode("utf-8"))
    except (OSError, ValueError) as exc:
        raise OrcaDebError(f"could not read the official Orca release: {exc}") from exc
    if not isinstance(payload, dict) or payload.get("prerelease"):
        raise OrcaDebError("GitHub did not return a stable Orca release")
    return payload


def _architecture() -> str:
    result = _run(["dpkg", "--print-architecture"])
    architecture = result.stdout.strip()
    if architecture not in {"amd64", "arm64"}:
        raise OrcaDebError(f"unsupported Debian architecture: {architecture or 'unknown'}")
    return architecture


def _asset(release: dict[str, Any], architecture: str) -> dict[str, Any]:
    version = str(release.get("tag_name") or "").removeprefix("v")
    if not version or any(character not in "0123456789." for character in version):
        raise OrcaDebError("the latest release has an invalid stable version")
    expected_name = f"orca-ide_{version}_{architecture}.deb"
    for candidate in release.get("assets") or []:
        if not isinstance(candidate, dict) or candidate.get("name") != expected_name:
            continue
        url = str(candidate.get("browser_download_url") or "")
        parsed = urllib.parse.urlparse(url)
        digest = str(candidate.get("digest") or "")
        try:
            size = int(candidate.get("size"))
        except (TypeError, ValueError) as exc:
            raise OrcaDebError("the release asset has an invalid size") from exc
        if (
            parsed.scheme != "https"
            or parsed.hostname != "github.com"
            or not parsed.path.startswith(RELEASE_PREFIX)
        ):
            raise OrcaDebError("the release asset is not an official GitHub download")
        if not 0 < size <= MAX_DEB_BYTES:
            raise OrcaDebError("the release asset is outside the allowed size range")
        if (
            candidate.get("state") != "uploaded"
            or not digest.startswith("sha256:")
            or len(digest) != 71
            or any(character not in "0123456789abcdef" for character in digest[7:])
        ):
            raise OrcaDebError("the release asset has no valid SHA-256 digest")
        return {
            "version": version,
            "name": expected_name,
            "url": url,
            "size": size,
            "digest": digest,
            "architecture": architecture,
        }
    raise OrcaDebError(f"the official release does not contain {expected_name}")


def _installed_version() -> str | None:
    result = _run(
        ["dpkg-query", "-W", "-f=${Status}\n${Version}", PACKAGE_NAME],
        check=False,
    )
    lines = result.stdout.strip().splitlines()
    if result.returncode or len(lines) < 2 or lines[0] != "install ok installed":
        return None
    return lines[-1].strip() or None


def _version_at_least(installed: str | None, latest: str) -> bool:
    if not installed:
        return False
    result = _run(
        ["dpkg", "--compare-versions", installed, "ge", latest],
        check=False,
    )
    return result.returncode == 0


def _download(asset: dict[str, Any], cache_root: Path) -> Path:
    cache_root = cache_root.expanduser().resolve()
    if cache_root.is_symlink():
        raise OrcaDebError(f"cache path must not be a symlink: {cache_root}")
    cache_root.mkdir(parents=True, exist_ok=True)
    destination = cache_root / str(asset["name"])
    expected_digest = str(asset["digest"])
    if destination.is_file() and _sha256(destination) == expected_digest:
        _verify_package(destination, asset)
        return destination

    request = urllib.request.Request(
        str(asset["url"]),
        headers={"User-Agent": "Persephone-Orca-Deb-Updater"},
    )
    with tempfile.NamedTemporaryFile(
        prefix=f".{destination.name}.", suffix=".part", dir=cache_root, delete=False
    ) as temporary:
        staged = Path(temporary.name)
        digest = hashlib.sha256()
        total = 0
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                while chunk := response.read(1024 * 1024):
                    total += len(chunk)
                    if total > MAX_DEB_BYTES:
                        raise OrcaDebError("the Debian package exceeded the size limit")
                    digest.update(chunk)
                    temporary.write(chunk)
        except Exception:
            staged.unlink(missing_ok=True)
            raise
    observed_digest = f"sha256:{digest.hexdigest()}"
    if total != int(asset["size"]) or observed_digest != expected_digest:
        staged.unlink(missing_ok=True)
        raise OrcaDebError("the downloaded Debian package failed size or digest verification")
    _verify_package(staged, asset)
    os.replace(staged, destination)
    return destination


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def _package_field(path: Path, field: str) -> str:
    result = _run(["dpkg-deb", "-f", str(path), field])
    return result.stdout.strip()


def _verify_package(path: Path, asset: dict[str, Any]) -> None:
    expected = {
        "Package": PACKAGE_NAME,
        "Version": str(asset["version"]),
        "Architecture": str(asset["architecture"]),
    }
    for field, value in expected.items():
        observed = _package_field(path, field)
        if observed != value:
            raise OrcaDebError(
                f"Debian metadata mismatch for {field}: expected {value}, found {observed}"
            )


def _private_launcher() -> list[str]:
    environment_file = Path.home() / ".config" / "environment.d" / "90-orca-privacy.conf"
    desktop_file = Path.home() / ".local" / "share" / "applications" / "orca-ide.desktop"
    environment_file.parent.mkdir(parents=True, exist_ok=True)
    desktop_file.parent.mkdir(parents=True, exist_ok=True)
    environment_file.write_text(
        "DO_NOT_TRACK=1\nORCA_TELEMETRY_DISABLED=1\n",
        encoding="utf-8",
    )
    desktop_file.write_text(
        """[Desktop Entry]
Name=Orca
Exec=env DO_NOT_TRACK=1 ORCA_TELEMETRY_DISABLED=1 /opt/Orca/orca-ide %U
Terminal=false
Type=Application
Icon=orca-ide
StartupWMClass=orca
Comment=Next-gen IDE for parallel agentic development
Categories=Development;Utility;
""",
        encoding="utf-8",
    )
    updater = shutil.which("update-desktop-database")
    if updater:
        _run([updater, str(desktop_file.parent)], check=False)
    return [str(environment_file), str(desktop_file)]


def _status() -> tuple[dict[str, Any], dict[str, Any]]:
    release = _release()
    asset = _asset(release, _architecture())
    installed = _installed_version()
    return asset, {
        "package": PACKAGE_NAME,
        "installed": installed,
        "latest": asset["version"],
        "current": _version_at_least(installed, str(asset["version"])),
        "launcher": str(LAUNCHER),
        "launcher_present": LAUNCHER.is_file(),
        "source": asset["url"],
        "sha256": asset["digest"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Manage the official stable StablyAI Orca .deb on Debian."
    )
    parser.add_argument("action", choices=("check", "download", "install", "privacy"))
    parser.add_argument(
        "--cache-dir",
        type=Path,
        default=Path.home() / ".cache" / "orca-ide" / "releases",
    )
    parser.add_argument(
        "--private",
        action="store_true",
        help="Also install an official-environment-variable telemetry opt-out launcher.",
    )
    parser.add_argument("--json", action="store_true")
    arguments = parser.parse_args()

    try:
        if arguments.action == "privacy":
            payload: dict[str, Any] = {"privacy_files": _private_launcher()}
        else:
            asset, payload = _status()
            if arguments.action in {"download", "install"}:
                package = _download(asset, arguments.cache_dir)
                payload["download"] = str(package)
                if arguments.action == "install" and not payload["current"]:
                    apt = ["apt-get", "install", "-y", str(package)]
                    if os.geteuid() != 0:
                        apt.insert(0, "sudo")
                    result = subprocess.run(apt, check=False)
                    if result.returncode:
                        raise OrcaDebError(
                            "apt did not install Orca; rerun this command in an interactive terminal"
                        )
                    installed = _installed_version()
                    if not _version_at_least(installed, str(asset["version"])):
                        raise OrcaDebError("apt completed but orca-ide is not at the requested version")
                    payload["installed"] = installed
                    payload["current"] = True
                elif arguments.action == "install":
                    payload["message"] = "orca-ide is already current; nothing to do"
            if arguments.private:
                payload["privacy_files"] = _private_launcher()
        if arguments.json:
            print(json.dumps(payload, indent=2, sort_keys=True))
        else:
            for key, value in payload.items():
                print(f"{key}: {value}")
    except OrcaDebError as exc:
        parser.exit(1, f"Orca Debian update failed: {exc}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
