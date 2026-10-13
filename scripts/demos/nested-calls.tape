# Real nested calls: read 3, bash 1, edit 3 successes and 2 intentional failures.
Output scripts/demos/out/nested-calls/
Source scripts/demos/common.tape
Set Height 546
Hide
Type@0ms "cd $DEMO_DIR && clear && pi --approve --no-extensions -e ./extensions/compact-tools.ts -e builtin:codemode --no-mcp --no-skills --no-prompt-templates --no-context-files --theme ./themes/github-dark-pro.json --use-theme github-dark-pro --tools read,bash,edit,write,codemode --append-system-prompt $DEMO_PROMPTS/nested.md" Enter
Sleep 4s
Type@0ms "Run the codemode demo, including the two intentional failed edits." Enter
# Skip prompt entry and model startup; capture only once the first tool row exists.
Wait+Screen@180s /codemode.*await/
Show
Wait+Screen@180s /READY/
Sleep 2s
Type@0ms "/compact-tools claude project"
# Let completion settle; typing is instantaneous and animation keeps recording.
Sleep 500ms
Enter
Sleep 2s
Type@0ms "/compact-tools codex project"
# Let completion settle; typing is instantaneous and animation keeps recording.
Sleep 500ms
Enter
Sleep 2s
Ctrl+O
Sleep 1.5s
Ctrl+O
Sleep 1.5s
