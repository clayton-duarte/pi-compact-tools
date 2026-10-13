# Actual search, read, test, write, and edit calls; then expand/collapse.
Output scripts/demos/out/compact-workflow/
Source scripts/demos/common.tape
Hide
Type@0ms "cd $DEMO_DIR && clear && pi --approve --no-extensions -e ./extensions/compact-tools.ts -e builtin:codemode --no-mcp --no-skills --no-prompt-templates --no-context-files --theme ./themes/github-dark-pro.json --use-theme github-dark-pro --tools read,bash,edit,write,codemode --append-system-prompt $DEMO_PROMPTS/workflow.md" Enter
Sleep 4s
Type@0ms "Inspect the greeting helper, test it, and change Hello to Welcome." Enter
# Skip prompt entry and model startup; capture only once the first tool row exists.
Wait+Screen@180s /bash/
Show
Wait+Screen@180s /READY/
Sleep 2s
Ctrl+O
Sleep 2s
Ctrl+O
Sleep 1.5s
