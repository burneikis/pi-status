# pi-status

Minimal status bar for [pi](https://github.com/badlogic/pi-mono). Replaces the default footer with just the essentials:

```
$0.229  2.7%/1.0M sn:22% wk:50% ⟳4h09m                   claude-opus-4-6 • medium
```

Shows **cost**, **context usage** (color-coded), **plan usage** (color-coded), **model**, and **thinking level**.

## Config

Optional `~/.pi/agent/pi-status.json` picks which plan usage items to show, in order. Read at session start, so `/reload` applies changes.

```json
{
  "items": ["session", "session_reset", "weekly", "weekly_reset"],
  "labels": { "weekly_scoped": "fw" }
}
```

| item | example | |
|---|---|---|
| `session` | `5h:3%` | 5-hour session limit |
| `weekly` | `7d:2%` | weekly limit, all models |
| `weekly_scoped` | `ws:0%` | weekly model-scoped limit |
| `session_reset` | `↺4h9m` | time until session resets |
| `weekly_reset` | `↺3d2h` | time until weekly resets |
| `reset` | `↺4h9m` | soonest of the two resets |
| `extra` | `$12.34/$50.00` | extra usage credits, when enabled |

Default: `["session", "weekly", "reset"]`. `labels` overrides the `session`, `weekly` and `weekly_scoped` prefixes. The usage colour follows the highest percent among the shown items.

## Install

```bash
pi install git:github.com/burneikis/pi-status
```

Or try it without installing:

```bash
pi -e git:github.com/burneikis/pi-status
```

## Uninstall

```bash
pi remove git:github.com/burneikis/pi-status
```
