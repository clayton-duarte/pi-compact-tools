#!/usr/bin/env bash
# Record real Pi sessions with VHS; all edits/configuration stay in a temporary workspace.
# Usage: scripts/record-demos.sh [overview claude-style codex-style compact-workflow silent-mode silent-history nested-calls]
# DEMO_SOURCE selects the extension checkout (default: this repository).
# DEMO_MODEL optionally selects a model; otherwise use your configured default.
# DEMO_THINKING defaults to off (the host clamps this if the selected model requires reasoning).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
source="${DEMO_SOURCE:-$root}"
agent="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
work="$(mktemp -d "${DEMO_TMPDIR:-/tmp}/pi-demo.XXXXXX")"
export DEMO_DIR="$work/project"
export PI_CODING_AGENT_DIR="$work/agent"
export PI_SKIP_VERSION_CHECK=1
export PI_OFFLINE=1
export PI_TELEMETRY=0
export PI_TRUE_COLOR=1
trap 'rm -rf "$work"' EXIT
for command in pi vhs ffmpeg rsync node; do command -v "$command" >/dev/null; done
mkdir -p "$DEMO_DIR" "$PI_CODING_AGENT_DIR/compact-tools-notices"
rsync -a --exclude .git --exclude node_modules --exclude assets --exclude scripts/demos/out "$source/" "$DEMO_DIR/"
if [ -d "$source/node_modules" ]; then
  ln -s "$source/node_modules" "$DEMO_DIR/node_modules"
else
  (cd "$DEMO_DIR" && npm ci --ignore-scripts --silent)
fi
# Keep authentication outside the repository and omit unrelated packages, MCP servers, and user prompts.
for file in auth.json models.json provider-keys.json; do
  [ ! -f "$agent/$file" ] || ln -s "$agent/$file" "$PI_CODING_AGENT_DIR/$file"
done
node --input-type=module - "$agent/settings.json" "$PI_CODING_AGENT_DIR/settings.json" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const settings = JSON.parse(readFileSync(process.argv[2], 'utf8'));
writeFileSync(process.argv[3], JSON.stringify({
  defaultProvider: settings.defaultProvider,
  defaultModel: process.env.DEMO_MODEL || settings.defaultModel,
  defaultThinkingLevel: process.env.DEMO_THINKING || 'off', quietStartup: true, hideThinkingBlock: true,
  outputPad: 0, codemode: { mode: 'on' },
}));
JS
version="$(node -p "JSON.parse(require('fs').readFileSync('$source/package.json')).version")"
touch "$PI_CODING_AGENT_DIR/compact-tools-notices/$version"
echo "Recording pi-compact-tools $version with $(pi --version); workspace: $work"
cd "$root"
mkdir -p scripts/demos/out
if [ "$#" -eq 0 ]; then
  set -- overview claude-style codex-style compact-workflow silent-mode silent-history nested-calls
fi
for name in "$@"; do
  case "$name" in
    claude-style) style=claude;;
    codex-style) style=codex;;
    overview|compact-workflow|silent-mode|silent-history|nested-calls) style=compact;;
    *) echo "Unknown demo: $name" >&2; exit 1;;
  esac
  rm -rf "$DEMO_DIR/demo" "scripts/demos/out/$name"
  cp -R scripts/demos/fixture "$DEMO_DIR/demo"
  mkdir -p "$DEMO_DIR/.pi"
  printf '{"style":"%s","mode":"normal","previewLines":5,"auto_compact":{"read":true,"write":true,"edit":false,"bash":true}}\n' "$style" > "$DEMO_DIR/.pi/compact-tools.json"
  cp scripts/demos/prompts/*.md "$work/"
  export DEMO_PROMPTS="$work"
  if [ "$name" = silent-history ]; then
    # Generate real saved history before recording, then reopen that exact file in the TUI.
    (cd "$DEMO_DIR" && pi --print --approve --no-extensions -e ./extensions/compact-tools.ts \
      --no-mcp --no-skills --no-prompt-templates --no-context-files \
      --tools read,bash,edit,write --session-id greeting-review \
      --session-dir "$PI_CODING_AGENT_DIR/sessions/history" \
      --name "Greeting review" --append-system-prompt "$DEMO_PROMPTS/history.md" \
      "Review the greeting helper and its configuration." \
      "Test the greeting and update its wording to Welcome.") > "$work/history-preparation.log" 2>&1
    export DEMO_HISTORY="$(find "$PI_CODING_AGENT_DIR/sessions/history" -name '*.jsonl' -print -quit)"
    cp "$DEMO_HISTORY" "$work/history-before.jsonl"
    node scripts/demos/verify-session.mjs "$PI_CODING_AGENT_DIR/sessions" "$name" "$version" > "scripts/demos/out/$name-prepared.json"
  fi
  vhs "scripts/demos/$name.tape"
  node scripts/demos/verify-session.mjs "$PI_CODING_AGENT_DIR/sessions" "$name" "$version" "$work/history-before.jsonl" > "scripts/demos/out/$name.json"
  # VHS's PNG layers bypass its legacy GIF encoder flags, incompatible with ffmpeg 8+.
  ffmpeg -v error -y -framerate 24 -i "scripts/demos/out/$name/frame-text-%05d.png" \
    -framerate 24 -i "scripts/demos/out/$name/frame-cursor-%05d.png" \
    -filter_complex "[0][1]overlay,pad=iw+60:ih+42:(ow-iw)/2:(oh-ih)/2:color=0x101216,fps=12,split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=none" \
    "assets/$name.gif"
  echo "assets/$name.gif: $(du -h "assets/$name.gif" | cut -f1)"
  # Keep the first tool scene and a settled frame, without thousands of intermediate PNGs.
  frames=(scripts/demos/out/"$name"/frame-text-*.png)
  cp "${frames[0]}" "scripts/demos/out/$name-start.png"
  cp "${frames[${#frames[@]}-1]}" "scripts/demos/out/$name.png"
  rm -rf "scripts/demos/out/$name"
done
