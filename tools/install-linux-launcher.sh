#!/usr/bin/env bash
# Install a PeerHost launcher entry for the current Linux user (app menu + optional ~/Desktop shortcut).
# Usage: tools/install-linux-launcher.sh        Re-run any time; it only rewrites PeerHost's own files.
set -euo pipefail

project="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bin_dir="${XDG_BIN_HOME:-$HOME/.local/bin}"
apps_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
icon_dir="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/256x256/apps"
mkdir -p "$bin_dir" "$apps_dir" "$icon_dir"

# Prefer a version-manager Node (stable across shells) over whatever node happens to be first on PATH.
node_bin="${PEERHOST_NODE:-}"
for candidate in "$HOME/.local/share/mise/installs/node/latest/bin/node" "$(command -v node || true)"; do
  [ -z "$node_bin" ] && [ -x "$candidate" ] && "$candidate" -e "require('node:sqlite')" 2>/dev/null && node_bin="$candidate"
done
[ -n "$node_bin" ] || { echo "No Node with node:sqlite found; install Node 22.5+ or set PEERHOST_NODE." >&2; exit 1; }
[ -x "$project/node_modules/electron/dist/electron" ] || { echo "Electron is missing; run: npm ci --ignore-scripts && node node_modules/electron/install.js" >&2; exit 1; }

# Launcher: rebuild only when sources are newer than the build, then start the desktop app.
cat > "$bin_dir/peerhost" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "$project"
export PATH="$(dirname "$node_bin"):\$PATH"
if [ ! -f dist/apps/desktop/main.js ] || [ -n "\$(find src apps -newer dist/apps/desktop/main.js -print -quit)" ]; then
  node node_modules/typescript/bin/tsc -p tsconfig.json
fi
# Electron does not detect every Linux Secret Service (e.g. under Hyprland); PeerHost refuses plaintext keys.
exec node_modules/electron/dist/electron --password-store=gnome-libsecret dist/apps/desktop/main.js "\$@"
EOF
chmod 755 "$bin_dir/peerhost"

cp "$project/apps/desktop/icon-256.png" "$icon_dir/peerhost.png"

entry="$apps_dir/peerhost.desktop"
cat > "$entry" <<EOF
[Desktop Entry]
Type=Application
Name=PeerHost
GenericName=Minecraft Server Manager
Comment=Host, hand off and relay a Minecraft Java server between your PCs
Exec=$bin_dir/peerhost
Icon=peerhost
Terminal=false
Categories=Game;
Keywords=minecraft;server;mods;relay;
StartupNotify=true
StartupWMClass=PeerHost
EOF
chmod 644 "$entry"
command -v update-desktop-database >/dev/null && update-desktop-database "$apps_dir" >/dev/null 2>&1 || true
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t "${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor" 2>/dev/null || true

if [ -d "$HOME/Desktop" ]; then
  cp "$entry" "$HOME/Desktop/peerhost.desktop"
  chmod 755 "$HOME/Desktop/peerhost.desktop"
  command -v gio >/dev/null && gio set "$HOME/Desktop/peerhost.desktop" metadata::trusted true 2>/dev/null || true
fi
echo "LAUNCHER=$bin_dir/peerhost"
echo "DESKTOP_ENTRY=$entry"
