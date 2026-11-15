# docker/

Files for the local test server: an nginx container that serves the app at http://localhost:8080. The
[`Dockerfile`](../Dockerfile) and [`docker-compose.yml`](../docker-compose.yml) in the project root build and run
it; see "Run it locally in a browser" in the [README](../README.md).

| File | What it does |
|---|---|
| `nginx.conf` | Serves the app with caching off, so edits show on refresh. Also proxies three public feeds that block browser requests (CORS): `/feeds/radarr/` (Radarr's metadata service), `/feeds/apple/` (Apple Music charts) and `/feeds/deezer/` (Deezer). |
| `10-medialoader-config.sh` | Runs when the container starts. Writes `/js/config.js` from your `.env` (server addresses, API keys, Plex and TMDb tokens), so the repository's `js/config.js` is never changed. |

After changing either file, rebuild with `docker compose up -d --build`. After changing `.env`, `docker compose up -d` is enough.
