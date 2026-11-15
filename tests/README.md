# tests/

Automated tests. They never contact real servers: every request is answered by a made-up media world with
fictional titles and people.

```sh
npm ci
npm test              # node --test "tests/unit/*.test.js"
npm run coverage      # the same, with a coverage report in coverage/
```

Needs Node.js 22 or newer.

## mock/

| File | What it does |
|---|---|
| `world.js` | The fictional media world: shows, movies, artists and people, plus answers for every service the app calls (Sonarr, Radarr, Lidarr, Plex, TVmaze, Radarr's metadata service, iTunes, Apple Music, Deezer, Wikidata, Wikipedia, Wikimedia Commons and TMDb). It also records each request, so tests can check what was sent. |

## unit/

| File | Tests |
|---|---|
| `sandbox.js` | Not a test. Loads app scripts into a sandbox with a fake browser (requests, local storage, timers) wired to `mock/world.js`, and the test configuration with placeholder keys. |
| `api.test.js` | Sonarr, Radarr and Lidarr: settings, request errors, lookups, adding titles with the chosen quality profile, the download queue, library status, Downloads' extra rows and downloading single episodes or seasons (14 tests). |
| `feeds.test.js` | Category rows, genre and streaming-service rows, Similar rows, saving and restoring rows, genres and publishers (10 tests). |
| `people.test.js` | Actor search, cast lists, recast and revival labels, biographies, photo fallbacks, the photo strip's sources and filmographies (9 tests). |
| `plex-seasons.test.js` | Finding titles on Plex, what Play starts (resume points, On Deck, the next unwatched episode), history, Play In Plex, and the season and episode lists (7 tests). |
| `player-sounds.test.js` | Subtitle files (SRT, WebVTT, ASS) and remote sounds, including the on/off setting (2 tests). |

`app.js` and `nav.js` (screens and remote navigation) aren't covered by unit tests; they were checked by driving
the app in a headless browser. See "Testing" in [AGENTS.md](../AGENTS.md).
