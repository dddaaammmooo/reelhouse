# js/

The whole app, as plain browser scripts with no build step or framework. Each file defines one global, and
`index.html` loads them in this order, because later files use the earlier globals:

`webapis.js` (on the TV only) → `config.js` → `sounds.js` → `nav.js` → `api.js` → `feeds.js` → `people.js` →
`seasons.js` → `plex.js` → `player.js` → `app.js`

Everything must run on the 2019 TV's Chromium 63. See the hard constraints in [AGENTS.md](../AGENTS.md):
no `?.` or `??`, no flex `gap`, and animate only `transform` and `opacity`.

| File | Global | What it does |
|---|---|---|
| `config.js` | `MEDIALOADER_DEFAULTS`, `MEDIALOADER_PLEX`, `MEDIALOADER_TMDB` | Server addresses and keys. The repository copy only holds placeholders; `build-tv.ps1` and the Docker container write the real one from `.env`. |
| `sounds.js` | `Sounds` | Remote key clicks and the start-up chime, synthesised with Web Audio (no sound files). |
| `nav.js` | `Nav` | The D-pad focus engine: which element is highlighted, moving between rows and pop-ups, smooth scrolling with transforms, and text-field editing. |
| `api.js` | `Api` | Sonarr, Radarr and Lidarr: lookups, adding and searching, the download queue, library status, quality profiles and saved settings. |
| `feeds.js` | `Feeds` | The public category rows (TVmaze, Radarr's metadata service, iTunes, Apple Music, Deezer), Similar rows, genres and publishers, and the saved copy of each screen's rows. |
| `people.js` | `People` | Cast lists, actor search, biographies, filmographies and the photo strip (Wikidata, Wikipedia, Wikimedia Commons, TVmaze, optionally TMDb). |
| `plex.js` | `Plex` | Finding titles on the Plex server, Play In Plex (handing playback to the Plex app), artwork, history and theme music. |
| `seasons.js` | `Seasons` | A show's seasons and episodes, merged from TVmaze, Sonarr and Plex. |
| `player.js` | `Player` | The built-in video player: Samsung's AVPlay on the TV, HTML5 video in browsers; subtitles, audio tracks, quality, intro and credits skipping, Up Next and progress reporting to Plex. |
| `app.js` | (none) | Everything else: screens, rows, the banner, the details and other pop-ups, Downloads, Settings, polling and start-up. |

Tests for these files are in [`tests/`](../tests/README.md).
