# A genuine saved session: two exchanges and eighteen completed tool calls.
# No model request is made during this recording; resume, browse, then hide/show history.
Output scripts/demos/out/silent-history/
Source scripts/demos/common.tape
Hide
Type@0ms "cd $DEMO_DIR && clear && pi --approve --no-extensions -e ./extensions/compact-tools.ts -e builtin:codemode --no-mcp --no-skills --no-prompt-templates --no-context-files --theme ./themes/github-dark-pro.json --use-theme github-dark-pro --tools read,bash,edit,write,codemode --session $DEMO_HISTORY" Enter
Wait+Screen@30s /Greeting now uses Welcome|greeting now uses Welcome/
Show
Sleep 2s
# Show how far the restored tool transcript extends into earlier work.
PageUp
Sleep 2s
PageDown
Sleep 1.5s
Type@0ms "/silent on"
# Let completion settle; typing is instantaneous and animation keeps recording.
Sleep 500ms
Enter
Wait+Screen@30s /The helper greets by name/
Sleep 3s
Type@0ms "/silent off"
# Let completion settle; typing is instantaneous and animation keeps recording.
Sleep 500ms
Enter
Wait+Screen@30s /Greeting review complete|Run printf/
Sleep 2s
