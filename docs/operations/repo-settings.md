# GitHub repository settings

Settings that live in GitHub rather than in the repository. Check them when
setting up a fork or a new organisation.

## Branch protection for `main`

Settings → Rules → Rulesets (or Branches → Branch protection rules):

- Require status checks to pass before merging:
  - `CI / Lint, typecheck, test, licences`
  - `Commits / DCO sign-off and commit messages`
  - `Security / CodeQL`
  - `Security / Vulnerable dependencies (OSV-Scanner)`
- Require branches to be up to date before merging.
- Block force pushes and deletion of `main`.
- While there is a single maintainer working directly on `main`
  (see `CLAUDE.md`), direct pushes are allowed; the same checks run on every
  push and must be kept green. Require pull requests once there are more
  contributors.

## Security

Settings → Code security:

- **Secret scanning** and **push protection**: on.
- **Private vulnerability reporting**: on (referenced from `SECURITY.md`).
- **Dependabot alerts**: on (Renovate handles update PRs; see `renovate.json`).
- **Code scanning**: results from the `Security` workflow (CodeQL).

## Actions

Settings → Actions → General:

- Allow only actions pinned to a full commit SHA (all workflows pin by SHA;
  Renovate keeps the pins up to date).
- Default workflow permissions: **read repository contents**. Workflows ask for
  more per job when needed.

## Apps

- **Renovate** (GitHub app): enabled for this repository; it reads
  `renovate.json`. Its commits are signed off via `commitBody` so the DCO check
  passes.
