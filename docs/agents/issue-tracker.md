# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues in `BryanLucas7/yaos-plugin`. Use the `gh` CLI for issue operations.

## Conventions

- Create an issue: `gh issue create --title "..." --body "..."`
- Read an issue: `gh issue view <number> --comments`
- List issues: `gh issue list --state open --json number,title,body,labels,comments`
- Comment on an issue: `gh issue comment <number> --body "..."`
- Apply a label: `gh issue edit <number> --add-label "..."`
- Remove a label: `gh issue edit <number> --remove-label "..."`
- Close an issue: `gh issue close <number> --comment "..."`

Run `gh` commands from the repo root so the CLI infers `BryanLucas7/yaos-plugin` from `git remote -v`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue in `BryanLucas7/yaos-plugin`.

## When a skill says "fetch the relevant ticket"

Run:

```bash
gh issue view <number> --comments
```

