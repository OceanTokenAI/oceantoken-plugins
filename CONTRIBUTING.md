# Contributing

## CI cost rules

This repository is public, so GitHub-hosted runners are free here, but the same rules apply as in every OceanToken repository so that a workflow copied to a private one does not run up a bill:

1. Every job has `timeout-minutes` (about twice its longest recent run). Without it a hung job runs for GitHub's 6-hour default.
2. Pull request runs keep only the newest commit: `concurrency` grouped by pull request, `cancel-in-progress` for pull requests only. Runs on `main` are never cancelled.
3. Trigger on the paths that matter (`paths` / `paths-ignore`); push runs on `main` only, because a pull request is already tested by its `pull_request` run.
4. No macOS or Windows runner unless the test needs that system, and then one combination, not a whole matrix row (a macOS minute is billed as 10 on private repositories).
5. Keep the matrix to the versions the CLI supports (`cli/package.json` `engines`).
6. Never weaken a test or a required check to save minutes; only remove duplicate, empty or hung runs.
