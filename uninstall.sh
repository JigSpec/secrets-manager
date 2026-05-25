#!/usr/bin/env bash
# uninstall.sh — remove sm and sm-daemon from /usr/local/bin
# Usage:  sudo ./uninstall.sh

set -euo pipefail

BIN_DIR="${SM_BIN_DIR:-/usr/local/bin}"
BINS=(sm sm-daemon)

if [[ $EUID -ne 0 && "${SM_SKIP_ROOT_CHECK:-0}" != "1" ]]; then
  echo "error: this script must be run as root (use: sudo ./uninstall.sh)" >&2
  exit 1
fi

for name in "${BINS[@]}"; do
  dest="${BIN_DIR}/${name}"
  if [[ -L "${dest}" ]]; then
    rm "${dest}"
    echo "removed: ${dest}"
  elif [[ -e "${dest}" ]]; then
    echo "warning: ${dest} is not a symlink — skipping (remove manually if needed)"
  else
    echo "not found (already removed): ${dest}"
  fi
done

echo ""
echo "Done. 'sm' and 'sm-daemon' have been removed from ${BIN_DIR}."
