# pi-better-auto-compact

<div align="center">

[![pi extension](https://img.shields.io/badge/pi-extension-9333EA)](https://www.npmjs.com/package/pi-better-auto-compact)
[![npm](https://img.shields.io/npm/v/pi-better-auto-compact?logo=npm)](https://www.npmjs.com/package/pi-better-auto-compact)
[![tests](https://img.shields.io/github/actions/workflow/status/fishcat37/pi-better-auto-compact/ci.yml?branch=main&label=tests)](https://github.com/fishcat37/pi-better-auto-compact/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/fishcat37/pi-better-auto-compact)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TS-TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![tested with](https://img.shields.io/badge/tested_with-Node.js-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

**English** | [简体中文](./README.zh-CN.md)

</div>

An auto-compact extension for the pi coding agent: on top of pi's built-in "remaining tokens" threshold, it adds compaction triggers based on the **context percentage** or the number of **used tokens**. The lowest of all thresholds (including the built-in one) wins.

- GitHub: https://github.com/fishcat37/pi-better-auto-compact
- npm: https://www.npmjs.com/package/pi-better-auto-compact

## What is this

pi's built-in auto-compact supports only one criterion: compact when the remaining context tokens run low (controlled by `compaction.reserveTokens` in `settings.json`, default 16384 — the window minus the reserve). It cannot express more intuitive needs like "compact at 90% usage" or "compact at 240k used tokens".

This extension adds two more thresholds that take effect together with the built-in one — the **lowest** fires first:

| Threshold | Meaning |
|-----------|---------|
| pi built-in `compaction.reserveTokens` | when remaining tokens drop below (window − reserve) |
| `percentThreshold` | when used context reaches a percentage of the model's context window |
| `usedTokensThreshold` | when used context exceeds a fixed token count (e.g. `240000` = 240k) |

Example: for a 1M-token model, configure `percentThreshold: 90` (900k) and `usedTokensThreshold: 240000` (240k); together with the built-in remaining threshold (983.6k), compaction first triggers at **240k** used. If the built-in threshold is the lowest, pi's native auto-compact fires as usual.

The extension never changes pi's native auto-compact behavior; it only takes over when an extension threshold is lower. See [Behavior](#behavior).

## Installation

Install with pi's built-in package manager:

```bash
# Global install, applies to sessions in all projects
pi install npm:pi-better-auto-compact

# Current project only
pi install -l npm:pi-better-auto-compact
```

Or install from the GitHub source:

```bash
pi install git:github.com/fishcat37/pi-better-auto-compact
```

Restart pi after installing. After changing the config, run `/reload` in a live session.

## Configuration

Thresholds must be configured explicitly; **if both fields are omitted, the extension does nothing** (pi's built-in auto-compact is unaffected).

Config files are JSON; the project config shallow-merges over the global one:

| Location | Path |
|----------|------|
| Global   | `~/.pi/agent/better-auto-compact.json` |
| Project  | `<project>/.pi/better-auto-compact.json` |

```json
{
  "enabled": true,
  "percentThreshold": 90,
  "usedTokensThreshold": 240000
}
```

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | boolean (default `true`) | Master switch. When `false`, the extension does nothing and pi's built-in auto-compact is unaffected |
| `percentThreshold` | number, (0, 100] | Percentage threshold; optional |
| `percentEnabled` | boolean (default `true`) | Switch for the percentage threshold. When `false`, it does not participate in the comparison (the value stays in the config) |
| `usedTokensThreshold` | positive integer | Used-tokens threshold (token count); optional |
| `usedTokensEnabled` | boolean (default `true`) | Switch for the used-tokens threshold. When `false`, it does not participate in the comparison (the value stays in the config) |

Also:

- Invalid fields are ignored and reported in `/compact-thresholds`.
- pi's built-in remaining threshold stays under pi's own control (`settings.json`: `compaction.reserveTokens`, `compaction.enabled`); this extension reads it and compares it together with the extension thresholds.

## Commands

- `/compact-thresholds`: show the current model's context window, each threshold's converted value, the lowest one and who fires it (pi built-in / this extension), current usage, thresholds disabled by their switches, and config issues.
- `/compact-toggle`: toggle the two extension thresholds, or set their values directly. With no arguments it opens an interactive menu for toggling, effective immediately, with consecutive toggling supported (Esc to exit); it also accepts the argument form `/compact-toggle percent|used on|off|<value>`:
  - `/compact-toggle percent 90` sets the percentage threshold to 90%; `/compact-toggle used 240000` sets the used-tokens threshold to 240000.
  - Writes the config file and reloads the in-memory config — **effective immediately in the current session**, no `/reload` needed, and persists across restarts.
  - Values and toggle flags are written to the config file that provides the threshold value (project config wins); when neither file has a value yet, setting a value writes the project config (creating the directory if missing) and clears the toggle flag (back to the default on).
  - Invalid arguments (e.g. `percent 150`, `used 110.5`), broken JSON, or toggling a threshold that has no value yet is reported without changing any file.

## Behavior

- **Check timing is identical to pi native**: checked once after an agent run fully ends and once before a new message is sent; never mid-loop (between tool turns). Runs aborted by the user skip the check, and the before-send checkpoint acts as a safety net; retrying after a failed compact triggers immediately.
- **Takes over only when needed**: only when a configured extension threshold is strictly lower than the built-in threshold, and usage has not yet passed the built-in threshold, does the extension call `ctx.compact()`; once past the built-in threshold, pi native (the full threshold/overflow mechanics) takes over.
- **Compaction itself uses pi's native path**: the same cut-point computation and default summarizer as native auto-compact, no custom instructions injected, and the compaction record in the session is identical. The only difference: pi's API marks `ctx.compact()` as manually triggered, so the in-progress status bar shows "Compacting context..." (native auto-compact shows "Auto-compacting..."); the result is unaffected.
- **resume behaves like native**: on session load it only reads the config, no compaction; resuming into an over-limit session waits for the before-send checkpoint.
- **Trigger notice**: on trigger it prints one line about which threshold fired (information native lacks under lowest-wins semantics); silent in headless mode.

## Development

Dependencies are managed with pnpm:

```bash
pnpm install      # install devDependencies (typescript, @types/node, pi types)
pnpm check        # tsc --noEmit type check
pnpm test         # node --test, unit + integration tests
```

The extension needs no build step: pi loads the TypeScript source directly through its built-in jiti loader and resolves `@earendil-works/pi-coding-agent` imports to pi itself, so no node_modules is needed at runtime (dependencies are only for local type checking and tests). Tests isolate the real user config through a temporary `$HOME` and need no network or API key.

## License

MIT
