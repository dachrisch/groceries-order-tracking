# Release Automation History

This document tracks the evolution of the release process for the Groceries Order Tracking project.

## 2026-05-16: Transition to Automated Patch Releases

### Context
Previously, the project used `standard-version` for manual releases. While `release-please` was partially integrated, dependency updates from Renovate used the `chore` commit type and were automerged without triggering a new version bump or tag, requiring manual intervention to publish new versions.

### The Solution: "Zero-Touch" Releases
We implemented a fully automated pipeline where dependency updates trigger a cascading release process.

#### 1. Semantic Renovate Updates
- **Change**: Updated `renovate.json` to use `semanticCommitType: "fix"`.
- **Reason**: `release-please` ignores `chore` commits for versioning. By using `fix:`, every dependency update now signals a mandatory patch release.

#### 2. Release-Please with Elevated Permissions
- **Change**: Configured `release-please-action` to use a Personal Access Token (`RELEASE_PLEASE_TOKEN`) instead of the default `GITHUB_TOKEN`.
- **Reason**: Actions triggered by `GITHUB_TOKEN` cannot trigger other workflows. Using a PAT allows the creation of the Release PR to trigger the auto-merge workflow.

#### 3. Automated Release PR Merging
- **Change**: Created `.github/workflows/release-please-automerge.yaml`.
- **Technical Detail**: 
    - Uses `pull_request_target` to ensure the workflow runs from the `master` branch context (ensuring security and access to secrets).
    - Automatically executes `gh pr merge --auto --merge` when the `autorelease: pending` label is detected.
- **Result**: Once Renovate merges an update, a Release PR is opened and immediately merged by the bot, triggering the final tag and deployment.

### Summary of Workflow
`Renovate (fix: commit)` -> `Release-Please (Open PR)` -> `Automerge Workflow (Merge PR)` -> `Release-Please (Create Tag/Release)` -> `CI (Deploy)`

## 2026-05-10 (approx): Introduction of Release-Please
- Replaced manual `npm run release` (standard-version) with the `google-github-actions/release-please-action`.
- Shifted toward a "Release PR" model for managing the CHANGELOG.md and versioning.
