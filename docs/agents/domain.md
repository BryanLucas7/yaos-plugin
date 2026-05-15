# Domain Docs

This is a single-context repo for the custom YAOS Obsidian sync plugin.

## Before exploring, read these

- `CONTEXT.md` at the repo root, if present.
- `docs/adr/`, if present, for decisions touching the area being changed.
- `AGENTS.md` at the repo root for agent setup and skill routing.

If `CONTEXT.md` or `docs/adr/` do not exist yet, proceed silently. The producer skill `/grill-with-docs` can create or update them lazily when domain language or architectural decisions are resolved.

## Domain vocabulary

Use the repo's established vocabulary when naming issues, tests, hypotheses, and implementation artifacts. For the current YAOS profile-sync work, important terms include:

- `sync normal`: existing YAOS markdown and attachment sync.
- `Profile Mirror`: separate channel for Obsidian profile files.
- `profile lock`: remote generation lock for atomic profile publishing.
- `plugin lock`: shared plugin code/version state.
- `plugin behavior`: profile-specific plugin configuration.
- `bootstrap local`: BRAT and YAOS installed outside the managed profile package.

If a concept is missing from `CONTEXT.md`, note it for `/grill-with-docs` instead of inventing competing terminology.

## ADRs

If an implementation choice contradicts an ADR, surface the contradiction explicitly before changing direction.

