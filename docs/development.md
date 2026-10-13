# Development

## Setup and checks

```bash
npm ci
npm run check
pi -e .
```

Development dependencies pin Pi 1.2.0; the peer minimum is Pi 0.85.1. CI checks Pi 0.85.1, 0.99.1, 1.0.0, 1.0.2, 1.1.0, and 1.2.0 on Node 22.19.0 and 24.

`npm run check` runs TypeScript, rendering tests, resource validation, and packaging checks. Rendering and resource tests run separately so packaging subprocesses do not disturb animation tests. Schema validation and deterministic test clocks are development-only dependencies.

Renders are pinned in `tests/golden/`. After an intentional rendering change, run `UPDATE_GOLDEN=1 npm test` and review the diff. Style parity is checked against real Claude Code and Codex CLI references in `tests/fixtures/`.

For an informational before/after performance comparison:

```bash
npx tsx tests/benchmark.ts /path/to/clean-baseline
```

Use the same host dependencies in both directories; benchmarks are not timing-sensitive test assertions.

## UI-only integration and compatibility

The extension does not register or activate agent tools, add model-facing messages, schemas, or prompt text, or change shell prefixes and image resizing.

- Pi 1.0.2+: the public renderer API also styles HTML exports.
- Older hosts: terminal-only compatibility rendering; HTML exports keep native rows.
- Pi 1.1+: final durations use recorded `durationMs`, including restored sessions, and rows follow `outputPad` (0 or 1).
- Older hosts retain event-based timing and original margins.
- Native codemode summaries are verified on Pi 1.2+. They use host-provided nested-call events and saved records. They retain only names and statuses—not arguments, results, or edit diff totals. Reload, resume, and `/tree` restore counts and outcomes. Hosts without those records keep normal previews.

Renderer-bearing overrides of built-in names, such as `read` and `bash`, follow `custom_tools` and its exclusions. Custom rendering intentionally takes precedence over earlier fallback resolvers using `next() ?? mine`; exclude a tool or disable `custom_tools` to preserve its fallback renderer.

## Record README GIFs

Requires `pi`, `vhs`, `ffmpeg`, `rsync`, `node`, `zsh`, and configured model credentials.

```bash
scripts/record-demos.sh                 # all seven demos
scripts/record-demos.sh nested-calls    # one demo
DEMO_MODEL=gpt-5.5 scripts/record-demos.sh  # with OpenAI Codex configured
DEMO_SOURCE=/path/to/checkout scripts/record-demos.sh
```

The recorder creates a temporary project and isolated settings, reuses credentials without committing them, and leaves your working files and saved style preferences untouched.

- Prompt entry and initial model startup are hidden; GIFs begin with tool rows.
- Tool activity is captured in real time at 12 fps in the final GIFs, without cuts between calls or playback acceleration.
- Thinking defaults to `off`, clamped to the selected model's supported levels. Override with `DEMO_THINKING`; `DEMO_MODEL` otherwise defaults to your configured model.
- Independent calls share an assistant response, avoiding unnecessary model round trips while respecting test-before-edit and write-before-read dependencies.
- The live silent-mode demo keeps a two-second command delay so it can toggle during real tool execution.
- The history demo creates and reopens a real saved session with 18 tool calls and two exchanges, then checks that display toggles leave the saved messages unchanged.
- Fixtures and prompts live in `scripts/demos/`. Ignored `scripts/demos/out/` contains review frames and verification reports with the actual model, thinking level, and call batches.

The published npm package excludes development scripts, tests, these developer docs, and local recording output. README GIFs are hosted in the repository's `assets/` directory.

## Release

Add an entry for the new version in `release-notes.json` (`[]` for no in-app notice), bump both package manifests, and run `npm run check`.

Push the matching `vX.Y.Z` tag after the commit reaches `main`. The [release workflow](../.github/workflows/release.yml) validates the version, runs checks, publishes to npm with provenance through Trusted Publishing, then creates the GitHub release. No local npm token is needed.
