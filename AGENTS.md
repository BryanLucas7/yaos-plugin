# YAOS Plugin — Agent Notes

This repo is a fork of `kavinsood/yaos` maintained by `BryanLucas7`. It distributes a custom build via BRAT (`BryanLucas7/yaos-plugin`).

The active line of work is **Profile Mirror Lite Clean** — a separate channel that syncs the Obsidian profile (plugins, configs, themes, snippets, layout) across devices through a remote profile lock backed by a Cloudflare Durable Object. See the original plan at `C:\Users\Bryan\Obsidian\Anotações\00-Geral\Plano YAOS Profile Mirror Limpo.md`.

Rule of thumb when judging design choices, in order:

1. Performance.
2. Simplicity.
3. Anti-bloat (no flight recorder, no QA framework, no diagnostics window, no backup ZIP, no telemetry).

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `BryanLucas7/yaos-plugin`. Use the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (`CONTEXT.md` + `docs/adr/` at the repo root). See `docs/agents/domain.md`.
