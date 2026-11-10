# claude-code-status-bar

A light status bar for Claude Code. It sits on the line under the prompt, next to `⏵⏵ auto mode on`, in the same color. Subagents and teammates get a line of their own (see [Per-agent line](#per-agent-line)):


![](bar.png)

```
⏵⏵ auto mode on (shift+tab to cycle)  │  Sonnet 5.5 │ high │ ctx 14k/200k 7% │ $0.12 / $1.84 │ 4% ↻1h0m │ 13% ↻3d4h │ main
```

| Field | Meaning |
| --- | --- |
| `Sonnet 5.5` | current model (updates after `/model`) |
| `high` | reasoning effort of the last request |
| `ctx 14k/200k 7%` | context tokens used / window size, percent used |
| `$0.12 / $1.84` | cost of the last answer / whole session, as `/cost` counts it (API list price; on a subscription it is the API equivalent, not a bill) |
| `4% ↻1h0m` | 5-hour usage limit and time until it resets |
| `13% ↻3d4h` | weekly usage limit and time until it resets (always after the 5-hour one) |
| `main` | current git branch of the working directory; a short commit like `(a1b2c3d)` on a detached HEAD; hidden outside a repository or when `git` is not on `PATH` |

Limits show on a Claude subscription only, after the first model response.

### Per-agent line

Each subagent and teammate has its own line. When you open an agent's transcript from the tasks list, the footer switches to that agent within a second and shows its own model, effort, context, cost and branch. Two agents running side by side, one on Haiku and one on Sonnet:

![](agent-haiku.png)

![](agent-sonnet.png)

```
Sonnet longer test … │ Sonnet 5.5 │ medium │ ctx 74k │ ≈$0.23 / $0.23 │ 19% ↻1h34m │ 21% ↻4d23h │ main
```

| Field | Meaning |
| --- | --- |
| `Sonnet longer test …` | the agent's name (its `name`, else the task description), cut at 20 characters |
| `Sonnet 5.5` / `medium` | the model and effort of the agent's last request |
| `ctx 74k` | the agent's own context; `/window` and percent are added when it runs on the session's model |
| `≈$0.23 / $0.23` | estimated cost of the agent's last turn / all its turns |
| `19% ↻1h34m`, `21% ↻4d23h` | the account's limits, the same for every agent |
| `main` | the branch of the agent's own directory (a worktree agent shows its worktree's branch) |

`≈` marks an estimate: Claude Code does not give plugins a cost per agent, so it is counted from the agent's tokens at API list price (cache writes at the 5-minute rate, fast mode not counted) and can differ from `/cost`. A model missing from the price table shows no cost.

Back on the main conversation the line shows the session again; the session cost there includes its agents.

Model and effort changes from `/model` or `/effort` show within a second, without waiting for the next response. A branch switch shows within about 5 seconds.

Works on macOS, Linux and Windows; the branch needs `git` on `PATH`. On a narrow terminal the line is cut at the right edge instead of wrapping.

## Install

In Claude Code:

```
/plugin marketplace add SDH4114/claude-code-status-bar
/plugin install cc-status-bar@amikolabs.com
```

Then run `/reload-plugins` or restart Claude Code.

Or from a shell:

```sh
claude plugin marketplace add SDH4114/claude-code-status-bar
claude plugin install cc-status-bar@amikolabs.com
```

## Update

```
/plugin marketplace update amikolabs.com
```

## Uninstall

```
/plugin uninstall cc-status-bar@amikolabs.com
```

## Develop

```sh
claude plugin validate .
claude plugin test .
```

## License

MIT
