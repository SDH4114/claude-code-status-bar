# claude-code-status-bar

A light status bar for Claude Code. It sits on the line under the prompt, next to `⏵⏵ auto mode on`, in the same color:


![](image.png)

```
⏵⏵ auto mode on (shift+tab to cycle)  │  Sonnet 5.5 │ high │ ctx 14k/200k 7% │ 5h 4% ↻1h0m │ 7d 13% ↻3d4h
```

| Field | Meaning |
| --- | --- |
| `Sonnet 5.5` | current model (updates after `/model`) |
| `high` | reasoning effort of the last request |
| `ctx 14k/200k 7%` | context tokens used / window size, percent used |
| `5h 4% ↻1h0m` | 5-hour usage limit and time until it resets |
| `7d 13% ↻3d4h` | weekly usage limit and time until it resets |

Limits show on a Claude subscription only, after the first model response.

## Install

In Claude Code:

```
/plugin marketplace add SDH4114/claude-code-status-bar
/plugin install status-bar@cc-status-bar
```

Then run `/reload-plugins` or restart Claude Code.

Or from a shell:

```sh
claude plugin marketplace add SDH4114/claude-code-status-bar
claude plugin install status-bar@cc-status-bar
```

## Update

```
/plugin marketplace update cc-status-bar
```

## Uninstall

```
/plugin uninstall status-bar@cc-status-bar
```

## Develop

```sh
claude plugin validate .
claude plugin test .
```

## License

MIT
