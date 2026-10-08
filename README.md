# claude-cli

Terminal mods for [Claude Code](https://code.claude.com), packaged as a plugin marketplace.

## orange-hud

An orange heads-up display for the Claude Code terminal.

- **Side pane** (docked right in the fullscreen layout): Claude Code version, model, effort, the session's title, context and rate-limit gauges, cost, prompts and session time, working directory, git branch with changes and upstream drift, current kube context, and every subagent with its status, tools and timing. Click a subagent to read its conversation in the pane; `← HUD` goes back. The agent whose transcript Claude Code has in view is marked `▶`.
- **Turn folding**: the intermediate text and tool calls of each turn collapse into one line under your prompt until the final answer or a question. Click the line to expand it, or run `/thoughts` to expand or fold every turn.
- **Restyled transcript**: your prompts as grey cards, and replies with orange headings, bullets and numbering, code in highlighted cards, and dimmed quotes.

### Install

At the prompt of a Claude Code terminal session:

```
/plugin install orange-hud --marketplace diegopc99/claude-cli
```

Answer `y` to add the marketplace, then pick the user scope. The mod is active right away.

### Commands

| Command | What it does |
|---|---|
| `/hud` | Opens the side pane when it is not showing |
| `/thoughts` | Expands or folds the work of every turn |

### Requirements and limits

- Built and tested on Claude Code 2.1.292. It uses the function-hooks plugin API, which is early access and may change between releases.
- The side pane docks in the fullscreen layout from 110 columns (144 when it opens on its own); elsewhere the HUD shows above the prompt.
- Colours are tuned for the dark theme. UI labels are in Spanish.
- It does not remove a configured `statusLine`; that keeps drawing under the prompt.
- The agent viewer is drawn by the mod beside the main transcript: plugins cannot switch Claude Code's own transcript view, which only the tasks list does.
- The side pane stays open: its × is drawn by Claude Code and cannot be hidden, so the mod ignores it.
- Every 5 seconds it runs `git --no-optional-locks -c core.fsmonitor=false status` and `kubectl config current-context` in the session's directory. Both are optional: without git or kubectl those rows are simply not shown.
- No network access. Text from outside the session (kube contexts, branch names, agent descriptions) is stripped of control characters before it is drawn.

### Uninstall

```
/plugin uninstall orange-hud@claude-cli
/plugin marketplace remove claude-cli
```

### Develop

```
claude plugin validate orange-hud
claude plugin test orange-hud
```
