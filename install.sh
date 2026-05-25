#!/usr/bin/env bash
# install.sh — install sm, sm-daemon, and sm-mcp to /usr/local/bin
# Usage:  sudo ./install.sh
# Re-running is safe (idempotent).

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${SM_BIN_DIR:-/usr/local/bin}"
BINS=(sm sm-daemon sm-mcp)
SOURCES=(bin/sm.ts bin/sm-daemon.ts bin/sm-mcp.ts)

if [[ $EUID -ne 0 && "${SM_SKIP_ROOT_CHECK:-0}" != "1" ]]; then
  echo "error: this script must be run as root (use: sudo ./install.sh)" >&2
  exit 1
fi

if ! command -v npx &>/dev/null; then
  echo "error: npx not found — install Node 20+ and try again" >&2
  exit 1
fi

if [[ ! -d "${REPO_DIR}/node_modules" ]]; then
  echo "error: node_modules not found — run 'pnpm install' first" >&2
  exit 1
fi

for i in "${!BINS[@]}"; do
  name="${BINS[$i]}"
  src="${REPO_DIR}/${SOURCES[$i]}"
  dest="${BIN_DIR}/${name}"

  chmod +x "${src}"

  if [[ -L "${dest}" ]]; then
    echo "removing old symlink: ${dest}"
    rm "${dest}"
  elif [[ -e "${dest}" ]]; then
    echo "warning: ${dest} exists and is not a symlink — backing up to ${dest}.bak"
    mv "${dest}" "${dest}.bak"
  fi

  ln -s "${src}" "${dest}"
  echo "installed: ${dest} -> ${src}"
done

echo ""
echo "Done. 'sm', 'sm-daemon', and 'sm-mcp' are now on your PATH."
echo "Start the daemon with:  sm-daemon start"
