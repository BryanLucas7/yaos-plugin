# Profile Mirror Lite Clean — Publish Strategy

How the `feat/profile-mirror-lite-clean` branch becomes the official line for `BryanLucas7/yaos-plugin` without dragging the bloated `origin/main` history (1.6.7 diagnostics, 1.6.8 mobile attachment kill switch, QA harness, flight recorder, profile package sync attempt 1) back in.

## Decisions

- The clean branch is forked from `b86556f` ("Cleaner Readme") — the tip of the kavinsood/yaos upstream merge. Everything authored after that point in the fork is treated as bloat and intentionally not carried.
- `origin/main` is **not** modified during implementation. It stays intact as a recoverable record of the abandoned line of work in case anything from the 1.6.7 diagnostics codepath needs to be referenced later.
- No `git merge`, `git rebase` or wide `git cherry-pick` from `origin/main` into the clean branch. The closed-file conflict fix from `dad707d` is **reimplemented from the plan**, not cherry-picked, so it lands without flight-recorder dependencies.
- The clean branch is published to GitHub as `feat/profile-mirror-lite-clean` and validated by 1–2 BRAT releases cut from it.
- After validation, the branch is promoted to `main` only with explicit user approval. The promotion uses `git push --force-with-lease origin feat/profile-mirror-lite-clean:main` (or equivalent), never `--force`. Until that approval, `main` keeps pointing at its current HEAD.

## What is intentionally not done

- No automatic substitution of `origin/main`.
- No deletion of remote commits.
- No merge of `origin/main` into the clean branch.
- No rebase of the clean branch onto `origin/main`.
- No cherry-pick of the 1.6.7/1.6.8 commits or any diagnostics/QA/flight recorder commits.
- No edits to the Cloudflare Worker outside the Profile Mirror routes added by the plan.

## Open follow-ups (tracked in the plan)

- Etapa 11 RED/GREEN 4.1 and 4.2 reimplements the closed-file three-way conflict fix without resurrecting `flight recorder` / `traceStore` plumbing.
- Promotion to `main` (Etapa 1.1 final step) is gated on user approval after live validation.
