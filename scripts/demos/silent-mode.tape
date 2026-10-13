# Toggle silent mode while a real command is running, then restore its rows.
Output scripts/demos/out/silent-mode/
Source scripts/demos/common.tape
Hide
Type@0ms "cd $DEMO_DIR && clear && pi --approve --no-extensions -e ./extensions/compact-tools.ts -e builtin:codemode --no-mcp --no-skills --no-prompt-templates --no-context-files --theme ./themes/github-dark-pro.json --use-theme github-dark-pro --tools read,bash,edit,write,codemode --append-system-prompt $DEMO_PROMPTS/silent.md" Enter
Sleep 4s
Type@0ms "Test the greeting helper and change Hello to Welcome." Enter
# Skip prompt entry and model startup; capture only once the first tool row exists.
Wait+Screen@180s /read demo\/greet.ts/
Show
Wait+Screen@180s /Run sleep/
Wait+Screen@180s /Running command/
Sleep 500ms
# Instant command entry, then wait for completion to settle without cutting activity frames.
Type@0ms "/silent on"
Sleep 500ms
Enter
Sleep 200ms
Wait+Screen@180s /READY/
Sleep 1.5s
Type@0ms "/silent off"
Sleep 500ms
Enter
Sleep 200ms
Sleep 2s
