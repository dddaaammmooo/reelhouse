# .github/

GitHub Actions workflows and Dependabot settings.

| File | When it runs | What it does |
|---|---|---|
| `workflows/ci.yml` | Every push to `main` and every pull request | Runs the unit tests with a coverage report, and `npm audit` for high-severity advisories. |
| `workflows/codeql.yml` | Pushes, pull requests and weekly | CodeQL security analysis of the JavaScript and of the workflows themselves. |
| `workflows/dependency-review.yml` | Pull requests | Blocks new dependencies with high-severity advisories. |
| `workflows/secret-scan.yml` | Pushes, pull requests and weekly | gitleaks over the whole history, looking for API keys and tokens. |
| `workflows/scorecard.yml` | Pushes to `main` and weekly | OpenSSF Scorecard; results appear under Security › Code scanning. |
| `workflows/release-please.yml` | Pushes to `main` | Keeps a release pull request up to date from conventional commit messages. Merging it tags the version, writes `CHANGELOG.md`, bumps the version in `package.json` and `config.xml`, and attaches a zip of the app files plus the signed TV package. |
| `workflows/tv-package.yml` | Called by the release workflow, or run by hand from the Actions tab | Signs `Reelhouse.wgt` with the owner's Samsung certificate (repository secrets) using [`tools/package-tv.sh`](../tools/README.md). Run by hand, the package is kept as a build artifact for 14 days. |
| `dependabot.yml` | Weekly | Opens pull requests for npm and GitHub Actions updates. |

Every action is pinned to a commit hash, with its version in a comment so Dependabot can update it.

Commit messages must be conventional (`feat:`, `fix:`, `ci:` …), or release-please leaves them out of releases.

The signing secrets are `TIZEN_AUTHOR_P12` and `TIZEN_DISTRIBUTOR_P12` (the `.p12` files, base64-encoded) and `TIZEN_AUTHOR_PASSWORD` / `TIZEN_DISTRIBUTOR_PASSWORD`.
