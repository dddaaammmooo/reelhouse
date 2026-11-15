# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub's **Report a vulnerability** button on the
[Security tab](https://github.com/dddaaammmooo/reelhouse/security/advisories/new), not in a public issue.
Expect a reply within a week.

## What's in scope

- The TV app (`index.html`, `css/`, `js/`) and how it handles Sonarr, Radarr, Lidarr and Plex credentials.
- The packaging script (`build-tv.ps1`) and the Docker test container (`Dockerfile`, `docker/`).

## How credentials are handled

- API keys and the Plex token live only in `.env` on the build PC (git-ignored) and inside the signed TV package.
  `js/config.js` in this repository never holds real values.
- The Settings screen shows keys masked (last 4 characters); they're never logged or shown in messages.
- Every push and pull request is scanned for leaked secrets (gitleaks), code issues (CodeQL) and vulnerable
  dependencies (npm audit, Dependency Review, Dependabot); OpenSSF Scorecard runs weekly.
