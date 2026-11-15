# AGENTS.md: Reelhouse (formerly MediaLoader)

Handover notes for an agent picking up this project. Read this first, then `README.md` (user-facing setup and install).

## What it is

A **Samsung Tizen TV web app** (HTML/CSS/vanilla JS, no build step, no framework) that puts **Sonarr (TV), Radarr (Movies) and Lidarr (Music)** behind one remote-controlled, Netflix-style UI:

- Browse category rows of new and popular titles, or search; OK opens a details pop-up; **Download** adds the title to the right *arr app and starts a search.
- **Similar** pages (recommendations / shared cast / related artists), **Cast** pages and an **Actors** search screen with each actor's movies and shows.
- **Downloads**: the combined queue of all three apps, with cancel / blocklist.
- **Settings**: server addresses and API keys.

Target device: the TV reports itself (via `sdb devices`) as **a 2019 Samsung Q60R: Tizen 5.0 → Chromium 63**, at `<tv-ip>`. Earlier notes said Q60A (2021, Chromium 76), which was wrong. Code must work on **Chromium 63**: 1920×1080 viewport, D-pad remote (no number pad). The user is in Australia, so charts use region `au`.

Servers on the user's LAN (one media server for all three, e.g. `http://media-server` / its IP; TVs often can't resolve `.local` names, so use IPs in `.env`):

| App | Port | API |
|---|---|---|
| Sonarr | 8989 | `/api/v3` |
| Radarr | 7878 | `/api/v3` |
| Lidarr | 8686 | `/api/v1` |

All three send permissive CORS headers. Auth is the `X-Api-Key` header.

Verified on 15 Nov 2026 with the real keys:

| App | Version | Root folder | Quality profile MediaLoader adds with |
|---|---|---|---|
| Sonarr | 4.0.20 | `/media/tv` | **HD-1080p** (id 4) |
| Radarr | 6.4.4 | `/media/movies` | **Low Quality 1080** (id 8) |
| Lidarr | 3.1.6 | `/media/music` | **root folder default = Lossless** (id 2) |

The user chose these profiles. They're set **by name** via `qualityProfile` in `MEDIALOADER_DEFAULTS` (or `SONARR_/RADARR_/LIDARR_QUALITY_PROFILE` in `.env`, which `build-tv.ps1` and the Docker config script both read). An empty name means the app's first profile, or for Lidarr the root folder default. The real lookup responses were checked: they contain ratings (Radarr: imdb, tmdb, metacritic, rottenTomatoes, trakt), `tvMazeId`, poster `remoteUrl`, and Lidarr root-folder defaults.

**`.env` on the PC holds the real API keys.** Never copy it to the NAS or commit it.

---

## Running it locally

There's no compile step: the app is static files. Pick one of the three options.

### A. Docker (recommended for development)

Needs Docker Desktop. From the project folder:

```sh
cp .env.example .env          # then fill in SONARR_API_KEY, RADARR_API_KEY, LIDARR_API_KEY (and URLs if needed)
docker compose up -d --build
```

Open **http://localhost:8080**. In the browser:

| Key | Acts as |
|---|---|
| Arrow keys | Remote D-pad |
| Enter | OK |
| Esc (or Backspace outside a text field) | Back |

- **Live editing:** `index.html`, `icon.png`, `css/` and `js/` are bind-mounted read-only. Edit a file and refresh; no rebuild needed. Everything is served with `Cache-Control: no-store`.
- **When you need `--build`:** after changing `docker/nginx.conf`, `docker/10-medialoader-config.sh` or the `Dockerfile`.
- **After changing `.env`:** run `docker compose up -d`. `/js/config.js` is generated from `.env` at container start (`docker/10-medialoader-config.sh` writes `/etc/medialoader/config.js`, and nginx aliases `/js/config.js` to it). The repo's `js/config.js` is never modified.
- **Feed proxies:** nginx proxies the CORS-less public feeds:
  - `/feeds/radarr/` → `https://api.radarr.video`
  - `/feeds/apple/` → `https://rss.marketingtools.apple.com`
  - `/feeds/deezer/` → `https://api.deezer.com`

  The resolver is Docker's DNS only (`127.0.0.11`); adding `1.1.1.1` previously caused 30-second hangs. Timeouts: connect 5 s, read 15 s.
- **Testing on the TV without installing:** open `http://<PC-IP>:8080` in the TV's Internet app. Windows Firewall must allow inbound TCP 8080.
- **No API keys yet?** The UI still loads. Each media screen redirects to Settings with a toast, and the category feeds still work.

### B. Any static web server (no Docker)

```sh
npx http-server . -p 8080 -c-1        # or: python -m http.server 8080
```

API keys then come from `js/config.js` (or the in-app Settings screen, saved in localStorage). Without the nginx proxies, the **Radarr list, Apple Music and Deezer feeds fail** in a desktop browser because of CORS. The Movies/Music category rows and Similar pages will be partly empty; TVmaze and iTunes chart rows still work.

### C. On the TV: install tools, sign, upload

App ID `MdLoader01.MediaLoader` (package id `MdLoader01`, defined in `config.xml`). The TV only installs `.wgt` packages signed with a **Samsung** certificate whose distributor part lists the TV's **DUID**. That requires a free Samsung account, signed in once when the certificate is created. A plain Tizen certificate is rejected. The no-account alternative is option A's "test on the TV" (open the Docker URL in the TV's Internet app); there's no installed app that way.

#### C1. Required software (one-time, on the Windows PC)

| Software | Where / how | Notes |
|---|---|---|
| **Tizen Studio 6.1** (IDE installer) | `https://download.tizen.org/sdk/Installer/tizen-studio_6.1/web-ide_Tizen_Studio_6.1_windows-64.exe` (≈630 MB, Authenticode-signed by Samsung Electronics) | **Already installed on the user's PC** at `C:\tizen-studio`, silently, with `installer.exe --accept-license C:\tizen-studio`. Bundles its own JDK. Use the IDE installer, not `web-cli`: the Samsung certificate is created in the GUI Certificate Manager. |
| **TV Extensions-10.0** | Tizen Studio **Package Manager** (`C:\tizen-studio\package-manager\package-manager.exe`) › *Extension SDK* | Samsung only offers the latest; it still builds apps for this Tizen 6.0 TV (`required_version` 3.0). Package Manager **needs Windows admin rights**, so the CLI fails without elevation and the user must run it. |
| **Samsung Certificate Extension** | Same Package Manager tab (sometimes under *Extras*) | Adds the Samsung option to Certificate Manager. |
| Docker Desktop | docker.com | Only for local testing (option A). |
| Node.js + `puppeteer-core` | optional | Only for automated UI checks (see *Testing*). |

Key tool paths: `C:\tizen-studio\tools\ide\bin\tizen.bat` (CLI) and `C:\tizen-studio\tools\sdb.exe` (device bridge).

#### C2. Prepare the TV (one-time, with the remote)

1. **Apps** → type **1 2 3 4 5** (Smart Remote: press the `123` button for the number pad).
2. Turn **Developer mode** **On** and set **Host PC IP** to the PC's IPv4 address (from `ipconfig`).
3. **Hold Power** until the logo appears (a cold restart; a short press doesn't apply it).
4. Note the TV IP: *Settings › General › Network › Network Status › IP Settings*.

Firmware updates can switch Developer Mode off; repeat this step if installs start failing.

#### C3. Connect and create the signing certificate (one-time)

```powershell
C:\tizen-studio\tools\sdb.exe connect <tv-ip>      # TV listens on port 26101
C:\tizen-studio\tools\sdb.exe devices              # expect "<tv-ip>:26101  device  <model>"
```

Allow `sdb.exe` through Windows Firewall (private networks) if prompted. Then, with the TV still connected:

1. Tizen Studio › **Tools › Certificate Manager** › **+**.
2. Choose **Samsung**, device type **TV**, profile name **`MediaLoader`** (`build-tv.ps1` defaults to this; override with `-CertProfile`).
3. Create a new **author** certificate (Samsung account sign-in in the browser).
4. Create the **distributor** certificate (privilege: Public). **Check the TV's DUID is in the device list**; it's auto-filled while the TV is connected. A missing DUID means installs fail with a signature or certificate error.

Certificates live under `C:\tizen-studio-data\keystore\` and the profile list in `C:\tizen-studio-data\profile\profiles.xml`. Back them up: losing them means re-signing with a new certificate and reinstalling.

#### C4. Sign, upload and launch (every release)

Put the server addresses (use `http://<media-server-ip>:<port>`, since the TV may not resolve `.local`) and API keys in `.env`, then:

```powershell
.\build-tv.ps1 -TvIp <tv-ip>        # stage → bake .env into config.js → sign → sdb connect → install → launch
.\build-tv.ps1 -NoInstall           # only produce .buildResult\Reelhouse.wgt
```

What the script does, and the equivalent manual commands if you need to debug a step:

```powershell
# 1. Stage only app files (config.xml, index.html, icon.png, css\, js\) into .buildResult\
#    and overwrite .buildResult\js\config.js with values from .env (source js\config.js stays key-free).
# 2. Sign + package (produces .buildResult\Reelhouse.wgt):
C:\tizen-studio\tools\ide\bin\tizen.bat package -t wgt -s MediaLoader -- .buildResult
# 3. Upload + install:
C:\tizen-studio\tools\sdb.exe connect <tv-ip>
C:\tizen-studio\tools\ide\bin\tizen.bat install -n Reelhouse.wgt -s <tv-ip>:26101 -- .buildResult
# 4. Launch:
C:\tizen-studio\tools\ide\bin\tizen.bat run -p MdLoader01.MediaLoader -s <tv-ip>:26101
# Remove from the TV if ever needed:
C:\tizen-studio\tools\ide\bin\tizen.bat uninstall -p MdLoader01.MediaLoader -s <tv-ip>:26101
```

Re-installing over an existing install keeps the app's localStorage (settings, cached rows). Bump `version` in `config.xml` for real releases. The app then appears at the end of the TV's **Apps** list.

**Script status:** working. On 15 Nov 2026 `.\build-tv.ps1 -TvIp <tv-ip>` signed with the `MediaLoader` profile (certificates in `%USERPROFILE%\SamsungCertificate\MediaLoader\`), installed and launched the app on the TV. `.env` exists with IP-based URLs. The real API keys are now in `.env`, and the installed build includes them and the chosen quality profiles. If PowerShell blocks the script, run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once.

| Failure | Cause / fix |
|---|---|
| `sdb connect` times out | Host PC IP in Developer Mode ≠ this PC, TV not cold-restarted, or firewall blocking `sdb.exe` |
| "Tizen CLI not found" | Pass `-TizenHome <install dir>` |
| `tizen package` fails | Certificate profile name mismatch: pass `-CertProfile <name>` |
| Install: signature / certificate error | TV DUID missing from the distributor certificate. Reconnect the TV and recreate the distributor certificate. |
| App shows "Can't reach Sonarr" | `.local` hostname: use IPs in `.env` and rebuild |

**CORS on the TV:** the app calls all public feeds directly on the TV. Tizen widgets with `<access origin="*">` are normally exempt from CORS. **This hasn't been confirmed on the user's TV yet.** If the Movies/Music category rows or Similar pages are empty on the TV, add a proxy on the media server and point the feed URLs at it.

---

## File map

| File | Role |
|---|---|
| `config.xml` | Tizen widget manifest: app id, `tv-samsung` profile, internet privilege, `access origin="*"`, `required_version` 3.0 |
| `index.html` | All markup. One `#app` with `#rail` (side menu) + `#stage` holding screens `#screen-search` and `#screen-settings`, toast. Includes two modals inside `#screen-search`: `#dl-sheet` (download details) and `#info-sheet` (title details). |
| `css/style.css` | All styles. Tokens in `:root` (spacing scale `--top/--s-xs…--s-xl`, colours). Layout constants are documented in comments. |
| `js/config.js` | `MEDIALOADER_DEFAULTS` (URLs + API keys per kind). Optional `MEDIALOADER_REGION` (default `au`). Replaced at Docker start / in the TV build. |
| `js/nav.js` | `Nav`: D-pad focus engine, smooth transform-based scrolling, text-input editing, key handling |
| `js/api.js` | `Api`: *arr client, settings persistence, add/search/lookup/queue/cancel, queue normalisation |
| `js/plex.js` | `Plex`: Play In Plex (find title on the Plex server, open the Plex app, start playback) |
| `js/player.js` | `Player`: built-in video player (AVPlay / HTML5) for Plex movies and episodes |
| `js/sounds.js` | `Sounds`: remote key clicks (Web Audio) and their on/off setting |
| `js/people.js` | `People`: cast lists, actor search, biography, filmography (see *Cast and actors* below) |
| `js/feeds.js` | `Feeds`: public category rows + "similar" rows, descriptor ↔ item hydration, localStorage cache |
| `js/app.js` | Everything else: screens, rendering, hero, modals, downloads, settings, polling, wiring |
| `docker/*`, `Dockerfile`, `docker-compose.yml`, `.env.example` | Local test container (see above) |

| `build-tv.ps1` | TV packaging/install script (PowerShell 5.1) |
| `README.md` | User docs |

Script load order matters (globals): `webapis.js (TV only) → config.js → sounds.js → nav.js → api.js → feeds.js → people.js → plex.js → player.js → app.js`.

---

## Hard constraints (don't break these)

1. **Chromium 63** (2019 TV; also run fine on newer). `focus({preventScroll})` is ignored there, so `Nav.focus` resets `scrollTop/scrollLeft` on ancestors after focusing. Keep that. No `catch {}` without a binding, no `Array.flat`, no `Object.fromEntries`. No flex `gap`; use margins, or grid `gap`/`grid-row-gap`, which *are* fine. Also avoid:
   - `inset`, `aspect-ratio`;
   - optional chaining `?.` and nullish coalescing `??`;
   - `Array.prototype.at`, `replaceAll`.

   ES2017 (arrow functions, const/let, template literals, Promise) is fine. `-webkit-line-clamp` and `-webkit-mask-image` are used and fine.
2. **Remote-only input.** Everything must be reachable with arrows / OK / Back. Every focusable element has class `focusable`. Test navigation, not just looks.
3. **Animate only `transform`/`opacity`.** Scrolling is done with `translate3d` on `.v-inner` / `.row-track` (never `scrollTop`), except the info modal's description body, which uses `scrollTop`.
4. **Never show API keys.** Settings masks them (`••••••••••••` + last 4). Editing starts empty, and an empty field keeps the old key. Keys must never be logged or put in toasts.
5. **Two presses for destructive or important actions.** Download = OK (opens details) + Download. Cancel / Find another release / Reset = second OK to confirm ("OK again to confirm", 5 s timeout). Modals open focused on a safe button (Close or Download, never Cancel).
6. **Text rules from the user:**
   - no "OK Download"-style key hints;
   - no "Loading…" text for rows;
   - capitalised placeholder `Search TV Shows` (no ellipsis);
   - descenders must not clip (line-height ≥ 1.2 with clamp).

---

## How the UI works

### Screens and modes

There are only two real screens: **`search`** (the browsing layout) and **`settings`**. The browsing screen is reused in modes, chosen in `app.js`:

| Mode | Header | Rows |
|---|---|---|
| Category (default) for `state.kind` ∈ `tv` / `movie` / `music` | Search box | `s.feed` (category rows) or, while a search term exists, one "Results for …" row |
| Similar (`state.search[kind].similar` set) | Title "Shows similar to X" (`.titled` class) | `s.similar.rows`. Back calls `exitSimilar()` |
| Downloads (`state.dlMode = true`) | Title "Downloads" + summary | `downloadRows()` grouped: Needs attention / Downloading / Importing / Waiting |

Other mode details:
- `applyMode()` toggles `#screen-search.titled` and fills `#page-title-text` / `#page-title-sub`.
- `show(name, kind, navKey)` switches screens (slide/fade transition) and highlights the rail item. `navKey` is used for Downloads.
- The **start screen is TV Shows** (`START_KIND = 'tv'`).
- The old Home and dedicated Downloads screens were removed.

### Layout of the browsing screen (1920×1080)

- **Hero** (`.hero`, 0–600 px): backdrop crossfade (`#hero-bg-a/b`), title (64 px, 2-line clamp), meta + status pill, 3-line overview, **More info** button (`#hero-more`). Text is bottom-anchored. `setHero(h)` fills it; `heroFor(card)` builds it from a card (dispatches to `heroForQueue` for download cards).
- **Rows area** (`#results-area.v-scroll.snap`, 600–1080 px): `.row` = heading (40) + 36 + poster 170×255 + 36 = 367 px. The focused row **snaps to the top** of the area, and the next heading peeks below.
- The search box and More info keep showing the **last highlighted poster** (`state.heroCard`, `previewCard()`, `heroForSearchBox()`).

### Navigation (`nav.js`)

- **Candidates:** visible `.focusable` in the rail and the active screen. If a `.sheet.open` modal exists in the active screen, **only** its contents (focus trap).
- **Rules, in order:**
  1. explicit `data-nav-up/down/left/right="#selector"` overrides (e.g. search box ↓ More info, last settings row ↓ Save);
  2. rail ↑/↓ siblings, → back to the page;
  3. inside `.row-track`, ←/→ walk siblings;
  4. between rows, ↑/↓ go to the adjacent `.row` **by DOM order** (not geometry, because rows animate). In a `.snap` area, ↓ on the last row **wraps to the first**;
  5. `.v-list` ↑/↓ siblings;
  6. otherwise geometric nearest-in-direction, with ← falling through to the rail.

  Entering a carousel restores its remembered card (`data-last`).
- **Unhandled moves** call `opts.onUnhandled(dir)`; the info modal uses this for ↑/↓ text scrolling.
- **Text inputs:** they are highlighted first. OK starts editing (opens the IME); Enter / IME Done (65376) submits; Back / IME Cancel (65385) stops; ↑/↓ leave the field; ← at caret 0 leaves.
- **Keys:** 37–40 arrows, 13 OK, 10009 Back (Esc/Backspace on desktop).
- **Back flow (`app.js` `back()`):** close a modal → leave a Similar / Cast / actor page (they stack; one level per Back) → open the rail on the current item → (from the rail) go to TV Shows → exit the app (`tizen.application.getCurrentApplication().exit()`).

### Data: *arr (`api.js`)

- **Settings:** `localStorage['medialoader.settings']`, merged over `MEDIALOADER_DEFAULTS`.
- **`SERVICES[kind]`** defines for each app:
  - lookup and add endpoints;
  - `loadContext()`: first root folder + first quality profile; Sonarr language profile if the endpoint exists (v3); Lidarr metadata profile and root-folder defaults; cached;
  - `buildAdd()`: monitored; search on add; Sonarr seasons > 0 monitored; Lidarr `addOptions.monitor` defaults to `all` (`latest` when added from chart rows);
  - `searchCommand()` for titles already in the library (`SeriesSearch` / `MoviesSearch` / `ArtistSearch`).
- **Lookups:** `lookupMovie(tmdbId)`, `lookupMovieByTitle(title, year)`, `lookupSeries(tvdbId)` (term `tvdb:ID`), `lookupSeriesByTitle`, `lookupArtist(name)` (normalised exact match, else first).
- **`queues()`:** fetches all three queues (`includeSeries/Episode`, `includeMovie`, `includeArtist/Album`) and normalises each record. One unreachable app doesn't hide the others.
  - States: `failed`, `attention`, `downloading`, `importing`, `queued`.
  - Fields: label, progress, ETA, sizes, overview, release, quality, client, indexer, outputPath…
- **`removeQueue(kind, id, blocklist)`:** `DELETE /queue/{id}?removeFromClient=true&blocklist=…&skipRedownload=…`.
- **In library** = lookup item has `id > 0`.

### Data: public feeds (`feeds.js`)

All sources are free and need no keys.

| Kind | Rows | Sources |
|---|---|---|
| tv | New series this week, Returning this week, Premiering soon, Top TV seasons to buy | TVmaze `/schedule/web` + `/schedule?country=US` (past 7 days, plus 5 future days web-only; ep 1 premieres with a TVDB id, English, no news/sport/talk); iTunes `toptvseasons` |
| movie | In cinemas & new releases, Coming soon to cinemas, Top movies to rent or buy, Popular right now, up to 5 genre rows | Radarr metadata `/v1/list/tmdb/trending` + `/popular`; iTunes `topmovies` |
| music | Popular new albums, Most played right now, genre rows | Apple Music RSS v2 `most-played/100/albums` (12 s timeout) → **falls back** to iTunes `topalbums` |

How the feed data flows:
- **Plain data first:** loaders return **descriptors** (plain JSON: `key, src, ref, year?, tvmaze?, add?, genres, view{title, meta[], poster, backdrop, overview}`).
- **Saved and restored:** these are saved to `localStorage['medialoader.feed.<kind>']` (`{v: STORE_VERSION=4, at, rows}`). `hydrate()` turns them into items with `resolve()` (*arr lookup by `src`) and an optional `loadBackdrop()` (TVmaze images).
- **One object per title:** the same `key` maps to one shared object across rows, so a status change shows everywhere.
- **Cache behaviour (`app.js` `loadFeed`):**
  - saved rows render instantly;
  - if older than 30 min (`FEED_FRESH`), they refresh in the background;
  - fresh rows replace the screen only if the user hasn't started browsing, otherwise they go to `s.pendingFeed`;
  - at start-up all three kinds preload, and `warmImages()` prefetches the first posters.
- **Bump `STORE_VERSION`** whenever the descriptor shape changes.

**Similar pages:** `Feeds.similar(kind, real, item, pool)`.

| Kind | Source |
|---|---|
| Movies | `api.radarr.video/v1/movie/{tmdbId}` → `Recommendations` → `POST /v1/movie/bulk` |
| TV | TVmaze `/shows/{id}/cast` (top 4) → `/people/{id}/castcredits?embed=show` → "Starring X" rows. There's no free TV recommendation API; TMDb or Trakt would need a key. |
| Music | Deezer `/search/artist` → `/artist/{id}/related` (+ second degree) |

Plus up to 2 "More <genre>" rows built from the already-loaded pool.

### Status, polling, downloads

- **Polling:** `refreshQueue()` runs every **15 s**, or **4 s** in Downloads mode (`schedulePoll`). It updates the rail badge, poster status pills (`statusFor`: queue state > `_searching` > In library) and the Downloads rows.
- **Downloads rows** rebuild only when the set or grouping of keys changes (`dlSignature`). Otherwise cards update in place, so focus never jumps. Cards use short labels (`cardStatus`, e.g. "Attention").
- **Download details modal** (`openDetails(key, returnTo)` / `renderDetails` / `onCancelOk`). Focus starts on **Close**.

### Title details modal (`#info-sheet`)

- **`openInfo(card, returnTo)`** shows the view data immediately, then `lookupOf(item)` → `detailsOf(kind, real)` for ratings (IMDb/TMDb/RT/Metacritic for movies), dates, runtime, genres, certification, network/studio.
- **Buttons:** Download (or "Search for missing" / "Search again" / "▶ Play In Plex"), ▶ Trailer, Cast (not music), Similar, Close.
- **Long overviews** scroll with ↑/↓ (`scrollInfo`, fade masks, hint).

---

## Testing approach used so far

There are no committed tests. Development used **puppeteer-core driving Microsoft Edge headless** (`C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`) against `http://localhost:8080`, with **request interception** that fakes the *arr servers. Any request to a `.local` name / `<media-server-ip>` gets canned JSON for:
- lookups;
- `rootfolder` / `qualityprofile` / `metadataprofile`;
- `system/status`;
- queues with all states;
- POST and DELETE recorded.

Public feeds were hit live. Set keys first with `localStorage.setItem('medialoader.settings', …)` and reload.

What the tests checked:
- **Behaviour:** the focus path for each flow (`document.querySelector('.focused')`), with screenshots read back for visual review.
- **Layout:** pixel gaps measured with `getBoundingClientRect`.
- **Animation:** `getComputedStyle(...).transform` sampled mid-animation.

That harness lived in a temporary folder and is **not** in this repo. Recreate it if you need regression tests (worth adding as `tools/smoke/` with `puppeteer-core`).

**Not yet verified against the real servers** (no API keys were available during development):
- the add payloads;
- `detailsOf` fields;
- similar-page lookups via real Radarr/Lidarr;
- queue field names on the user's versions;
- TV-side CORS behaviour.

Verify these first once keys are in `.env`.

---

## Features added 15 Nov 2026 (after the first TV install)

- **On disk → Play.**
  - `openInfo` calls `Api.libraryStatus(kind, id)` for titles already in the library:
    - Radarr `/movie/{id}`: `hasFile` + `movieFile.quality`;
    - Sonarr `/series/{id}`: `statistics.episodeFileCount/episodeCount`;
    - Lidarr `/artist/{id}`: `statistics.trackFileCount/trackCount`.
  - If files exist, the Download button becomes **▶ Play** (`#in-download.play`), the eyebrow shows "On disk · …", and posters show an **On disk** pill (`item._disk`).
  - Play calls `playInPlex()`, which **opens the Plex app** (`kIciSQlYEM.plex`, override with `MEDIALOADER_PLEX_APP`). `config.xml` has the `application.launch` privilege for this.
- **Play In Plex: working (`js/plex.js`).** The user confirmed playback on the TV.
  - **Server:** the Plex server at `http://<plex-server-ip>:32400`, machineIdentifier `<plex-server-id>`. The TV's Plex app is the player "TV 2019".
  - **Flow:**
    1. `/hubs/search?includeGuids=1`, matched by `tmdb://` / `tvdb://` / `imdb://`. TV shows use On Deck, else the first unwatched episode; music uses the artist.
    2. `tizen.application.launch('kIciSQlYEM.plex')`.
    3. Find the player in `/clients`.
    4. `POST /playQueues` **with `X-Plex-Client-Identifier` set to the player's id**. A queue owned by anyone else gives "error loading items into the play queue" on the TV.
    5. `playMedia` with `X-Plex-Target-Client-Identifier`, `protocol=https` and the server's **local plex.direct address** from plex.tv resources (plain http was refused).
  - **Token:** needs the **Plex Home admin / server owner** token (most viewing on the TV is under that account). A non-owner Home user's token failed because the TV's profile couldn't read queues it created. It's in `.env` as `PLEX_TOKEN` and baked by `build-tv.ps1`; it's never in the source or on the NAS.
  - **Sending "play":** the server's `/status/sessions` (now playing) is the source of truth.
    - Only one `playMedia` request is in flight at a time. A new one is sent only after a refusal or no answer *and* a check that nothing is playing; the whole attempt gives up after 75 s.
    - A second delivered `playMedia` restarts the movie. An early version resent on timeouts, and the movie restarted every few seconds.
    - Cold starts (Plex not open) can take 10–30 s before the app accepts commands. With a fixed wait, it was left at the Plex home screen.
    - **Readiness:** `waitForPlayer()` polls the server's `GET /resources` every 0.5 s.
      - While the Plex app is closed or loading it returns `{"MediaContainer":{"size":0}}`; once the app is at its menu it lists the player.
      - Measured cold start on the TV: ready at 11.6 s → play accepted at 11.7 s → playing at 16.9 s (the gap is Plex buffering).
      - Before this, a fixed wait left the user on Plex's menu for 5–10 s.
    - Warm start: accepted at 2.8 s, playing at 4.3 s.
  - **Background running:** `config.xml` has `background-support="enable"` so the app keeps running after Plex comes to the front.
  - **Profiles:** if the TV's Plex app is switched to another Home profile (other Home users), queues made with the owner token may fail again. Not handled yet; it would need per-user tokens via plex.tv `/home/users/{id}/switch`.
- **Loading screen** (`#splash`, `runSplash()` in app.js): the Reelhouse wordmark with a progress bar beneath it (the cat GIF was removed at the user's request), shown until the first screen's rows exist and their first ~10 posters plus the banner backdrop have loaded, for at least 0.8 s and at most 12 s.
- **TVmaze rate limit:** about 20 requests per 10 s. All TVmaze calls go through `tvmaze()`, which retries HTTP 429 with backoff. The TV rows use 7 days of streaming schedules, 3 days of US broadcast and 3 future days. Cards use `image.medium`, and TMDb posters use `w342`.
- **"In Library" ribbons:** feed items carry `src/ref/year`. `checkLibrary()` checks 4 at a time:
  - Radarr `/movie?tmdbId=` (Radarr's `lookup/tmdb` does **not** return the library id; `Api.lookupMovie` now checks the library first);
  - Sonarr `/series?tvdbId=`;
  - Lidarr `/artist` (fetched once);
  - title lookups for iTunes chart items.

  Results are cached for 6 h in `localStorage['medialoader.library']`. The ribbon replaces the "In library" / "On disk" pill on cards.
- **Requests / "Not found yet".**
  - Every Download is recorded in `localStorage['medialoader.requests']` (`trackRequest`).
  - `checkRequests()` runs every 60 s and when Downloads opens:
    - in queue → handled by the queue;
    - files on disk → removed, with a "ready to watch" toast;
    - otherwise after 3 minutes → state `notfound`.
  - Downloads shows rows "Not found yet" / "Searching". Their details sheet relabels the buttons to **Remove from list** (confirm) and **Search again** (no confirm; resends the search command).
  - Requests expire after 14 days. The rail badge counts the queue plus not-found items.
- **Download quality setting.**
  - Each Settings card has a **Download quality** selector (`#<kind>-quality`) above the API key. It opens `#qp-sheet`, a focus-trapped list of the app's real profiles (`Api.qualityProfiles`).
  - The value is the profile **name**, saved with the settings. `''` means the app default.
  - Defaults come from `.env` / `config.js` (Sonarr HD-1080p, Radarr Low Quality 1080, Lidarr root-folder default).

- **Downloads: Pending + Recently downloaded** (`Api.wanted()`, `Api.recent()`, `refreshExtras()`). Fetched when Downloads opens, then every 2 minutes while it's open.
  - **Pending** = monitored, released and missing:
    - Sonarr `/wanted/missing`, sorted by air date and grouped per show ("79 episodes missing");
    - Radarr `/wanted/missing`, keeping `isAvailable` only and sorted client-side by `added` (Radarr ignores `sortKey=movies.added`);
    - Lidarr `/wanted/missing`.

    Titles already in the queue or in MediaLoader's requests are excluded.
  - **Recently downloaded** = imports in the last 14 days:
    - `/history` with `eventType=3` (Sonarr/Radarr, `downloadFolderImported`) or `8` (Lidarr);
    - TV grouped per show.
  - These cards carry `item` (the library resource). OK / More info opens the **title details modal** (`openInfo` with `card._kind`), so it shows Play In Plex / Search for missing, not the download sheet. The Similar button is hidden in Downloads mode.

## Cast and actors (added 15 Nov 2026, `js/people.js`)

- **Kinds:** the Actors screen is the browse screen with `state.kind = 'people'` (rail item `data-kind="people"`). It has no *arr app; its default rows come from `People.recent()` via `loadActors()`: one row per recently released movie (Radarr TMDb trending + popular, which already include `Credits.Cast`; released = cinema or digital date has passed) or new TV series (TVmaze `/schedule/web` premieres of the past 7 days, top 8 by weight, cast from `/shows/{id}/cast`), newest release first, max 20 rows, cast with photos only (max 15). Saved for 12 h in the people store (`home` key); `kindLabel()` gives "Actors". Rows on people pages mix movies and shows, so **every item may carry `.kind`** (`movie` / `tv` / `people`); use `kindOf(item)` instead of `state.kind` for per-item work (views, status, library checks, details, download). `Feeds.hydrate` keeps `d.kind`.
- **Page stack:** `state.search[kind].similar` is now a stack of pages (`{title, rows, from, person?, prev}`), pushed by `pushPage()` (Similar, Cast, an actor's works) and popped by `exitSimilar()` on Back, refocusing the card that opened it.
- **Cast button** (`#in-cast`, hidden for music and in Downloads): `People.cast(kind, real, item)`:
  - movies: `api.radarr.video/v1/movie/{tmdbId}` → `Credits.Cast` (TMDb person id + headshot; `w342` on cards, `h632` full size);
  - TV: TVmaze `/shows/{id}/cast` (looks up the TVmaze id by TVDB id if needed).
  Shown as a "Cast of <title>" page with rows Starring (10) / Also starring. Person cards are feed-style items with `_person` and a name/role label (`.pname`).
- **Person pop-up** (`#ps-sheet`, listed before `#info-sheet` so it gets the focus trap): full-size photo left, biography, then "Movies" / "TV shows" facts (first 12 titles with years) and **Movies & TV shows (N)**, which opens the person page. Up/Down scroll the biography (`scrollInfo` handles both sheets).
- **OK on a person card:** on the Actors search results it goes straight to their page; anywhere else (cast lists, the "About" card on their own page) it opens the pop-up.
- **Data:**
  - `People.details(item)`: Wikidata entity (by TMDb person id P4985 via SPARQL, else name search), then the Wikipedia REST summary for the biography/photo. Labels fall back to Wikidata's `mul` label (some people have no `en` label). Cached on the card.
  - `People.works(item)`: SPARQL `?w wdt:P161 wd:<person>` with P4947 (TMDb movie id), P4835 (TVDB id) and P577 (date). Up to 60 movies (newest first) via Radarr metadata `POST /v1/movie/bulk`; up to 20 shows via TVmaze `/lookup/shows?thetvdb=`. Rows hydrate with `src: 'tmdb'` / `'tvdb'`, so details, Download, In Library and Play In Plex all work.
  - `People.search(name)`: `wbsearchentities` (20) → `wbgetentities`, kept to people with a TMDb person id or an acting occupation. Photos from Commons `Special:FilePath`.
  - Timing: the cast page is instant; a biography takes ~1–3 s (SPARQL), the filmography ~3–8 s. The banner loads a person's biography after resting on them for 0.5 s.
- All sources are free, keyless and send CORS `*`.

## Sounds, search keyboard, voice, people cache (15 Nov 2026)

- **Remote sounds** (`js/sounds.js`, loaded before `nav.js`): Web Audio synthesised clicks, so there are no audio files. `move` (arrows; throttled to one per 35 ms), `select` (OK / IME Done) and `back` (Back / Esc / IME Cancel). `nav.js` calls `opts.sound(name)`. They're on by default; Settings has a **Remote sounds** card with an On/Off switch (`#sound-toggle`) that saves straight away to `localStorage['medialoader.sounds']`. Down from the last API key → switch → Save.
- **Search keyboard** (`#kb` in the hero, `buildKeyboard` / `typeKey` / `openKeyboard` / `closeKeyboard` in app.js): an alphabetical 6×6 grid (a–z, 1–0) plus Space / Delete / Clear, styled after Plex's TV keyboard, replacing the Samsung keyboard for **search only** (Settings fields still use the TV keyboard).
  - `#search-input` is `readonly`. `nav.js` asks `opts.onEdit(input)` before starting native editing.
  - While it's open, `#screen-search.typing` hides the hero text and results update live. Leaving it (Down into the results, or the rail) closes it, and Back closes it to the search box.
  - Reopening focuses the last key pressed. On desktop, typing on a real keyboard (and Backspace) types into it.
- **Voice (experimental, not Bixby):** `setupVoice()` registers `tizen.voicecontrol` FOREGROUND commands (screen names, downloads, settings, search, back). Any other recognised text is searched on the current screen. `config.xml` now has the `mediacapture`, `recorder` and `voicecontrol` privileges.
  - Probed on the TV: `webkitSpeechRecognition` exists but ends immediately ("language-not-supported" for en-AU), and `getUserMedia` fails with `TrackStartError` because the Q60R has no microphone that apps can open.
  - `tizen.voicecontrol` works (client language en_GB; method names are `setCommandList`/`addResultListener`, not `setCommands`).
  - **Not yet confirmed** that the remote's mic button delivers speech to it rather than Bixby. Results are logged to `window.vcLog`; check it over remote debugging.
- **People cache:** `js/people.js` saves searches (7 days), Wikidata person lookups (30 days), biographies (30 days), filmographies (7 days, overviews trimmed to 300 characters) and cast lists (7 days) in `localStorage['medialoader.people']`, up to 300 entries with the oldest dropped first.
  - Wikimedia calls run **one at a time**, send `Api-User-Agent: MediaLoader/1.0 (Tizen TV media browser)` (CORS allows that header) and retry HTTP 429 after `Retry-After`.
  - Actor live search waits for 3+ letters and a 1.2 s pause.
- **Remote debugging on the TV** (very useful for checking real behaviour):
  ```powershell
  C:\tizen-studio\tools\sdb.exe -s <tv-ip>:26101 shell 0 debug MdLoader01.MediaLoader   # prints "port: NNNNN"
  C:\tizen-studio\tools\sdb.exe -s <tv-ip>:26101 forward tcp:9333 tcp:NNNNN
  ```
  Then `http://127.0.0.1:9333/json` lists the page; send `Runtime.evaluate` over its `webSocketDebuggerUrl` (the scratch helper was a 15-line node `ws` script), or open the `devtoolsFrontendUrl` in Chrome.

## Built-in video player (`js/player.js`, added 15 Nov 2026; NOT yet tested on the TV)

- **Entry:** in the details pop-up, titles on disk show **▶ Play** (movies and TV), which opens `Player.open(kind, real, title)`, plus **Open in Plex** (the old Plex-app hand-off). Music still uses ▶ Play In Plex. The title is found with `Plex.findItem` + `Plex.target` (TV: On Deck / first unwatched episode), then `/library/metadata/{id}?includeMarkers=1`.
- **Engines:** AVPlay (`webapis.avplay`, the `<object id="av-player" type="application/avplayer">` in `#pl`) on the TV, and HTML5 `<video>` in browsers. On the TV, video is drawn under the page, so `html.playing` makes the page transparent and hides `#app`. `index.html` loads `$WEBAPIS/webapis/webapis.js` (it 404s harmlessly in browsers).
- **Direct play vs transcode** (`decide()`): direct play when the TV supports the container, video codec and audio codec (`TV_DIRECT` list), with no picture subtitles and Original quality. Otherwise it uses Plex's universal transcoder (`start.m3u8`, `directStream=1` at Original so only what's needed is converted; `subtitles=burn` for PGS/VobSub). If direct play errors, it automatically retries via the transcoder at the same position. HLS from the transcoder starts its clock at the offset: `S.base` + engine time = position in the title (`now()`).
- **Subtitles** are always drawn by us (`#pl-subs`, sizes Small/Normal/Large):
  - external files (`stream.key`, e.g. `/library/streams/{id}` → SRT) are fetched and parsed (SRT/VTT/ASS);
  - text tracks inside the file use AVPlay `setSelectTrack('TEXT')` + `setSilentSubtitle(true)` + `onsubtitlechange`;
  - picture subtitles are burned in by Plex.
- **Audio:** AVPlay `setSelectTrack('AUDIO')` for direct play (Plex streams sorted by `index`, mapped to AVPlay tracks in order), otherwise a restart at the current position. Choices are saved on the part (`PUT /library/parts/{id}?audioStreamID&subtitleStreamID&allParts=1`), as Plex apps do.
- **Plex parity features:**
  - resume prompt (viewOffset > 30 s);
  - Skip Intro / Skip Credits (markers);
  - Up Next for episodes, at the credits marker or 30 s before the end, with a 10 s countdown (next episode from `/allLeaves`; auto-play can be turned off in the menu);
  - scrub thumbnails from the BIF index (`/library/parts/{id}/indexes/sd`; header count at byte 12, entries from byte 64 as (seconds, offset));
  - `/:/timeline` every 10 s and on play/pause/stop, using the position in the title, so watched state and resume points sync;
  - the transcode session is stopped on exit; the screen saver is off while playing.
- **Quality menu:** Original / 20 / 12 / 8 / 4 / 2 Mbps. Preferences live in `localStorage['medialoader.player']`. The menu also shows how it's playing (direct or converted, and why).
- **Keys** (the player captures keys itself while open; `stopImmediatePropagation`):
  - controls hidden: OK = pause and show controls, or skip intro/credits when that button shows; ←/→ scrub (accelerates while held); ↑/↓ show controls; Back = stop;
  - controls showing: ↑ scrub bar, ←/→ buttons, Back hides them;
  - media keys are registered via `tizen.tvinputdevice` (privilege `tv.inputdevice` added).
- **Testing:** `window.MEDIALOADER_TEST_ENGINE` (a fake engine factory) lets the UI be driven in a desktop browser against real Plex metadata. Block `/:/timeline`, `/transcode/universal` and PUTs to <plex-server-ip> in tests.
- **Verified with real Plex data (fake engine):** resume prompt, controls, BIF thumbnails, menu, SRT subtitles in sync, Skip Intro, Up Next.
- **Still to verify on the TV:** AVPlay direct play (MP4/HEVC/AAC 5.1 and MKV/HEVC/Opus files), transcode playback, track switching, 4K/HDR, media keys.

## UI review pass (15 Nov 2026)

Two independent reviewers (visual design, and navigation/flow) went over screenshots of every screen. Fixed:

- **Details buttons:** one line, with icons inline (`.sheet-actions .btn` nowrap/inline-flex). "Open in Plex" was renamed "Plex app".
- **Downloads:** focus moves to the first card once rows arrive (`hero-browse` is counted in `hadFocus`). The Pending row is now "Not downloaded yet", with no chip on those cards, and the summary says "N not downloaded yet".
- **Pages and Back:**
  - stacked pages show context instead of the "Press Back to return" key hint (`page.sub`: "30 people", "N rows of suggestions", "N movies · N TV shows");
  - Back from a Cast/Similar page reopens the details pop-up with the Cast/Similar button focused (`page.reopen` / `page.button`), and Back from an actor's page reopens their pop-up;
  - Cast / Similar / Movies & TV shows ignore repeated OKs while loading (`info.busy`, `item._worksBusy`), and Similar errors now distinguish network failures from no results;
  - Back on search results clears the search first.
- **Actor cards:** `.pwrap` column with the photo on top (fixed 148 px so names line up along a row), then the name (21 px) and role (18 px, `#c4c4cf`). Each wraps to 2 lines (`-webkit-line-clamp`) instead of being cut off, all inside the same 170×255 card.
- **Smaller fixes:**
  - music ratings are hidden under 5 votes, and the "Type" fact is gone;
  - plain-English player info line;
  - Settings scroll fade and 24 px status text;
  - bigger keyboard labels;
  - 10 px player bar;
  - softer portrait fade;
  - a consistent 28 px gap above More info.
- **Deliberately kept:** Down on the last row wraps to the first (the user asked for it), and Back with player controls hidden stops playback (as in Plex/Netflix).

## Side menu hidden by default (15 Nov 2026)

The rail no longer shows a 112 px icon strip. It sits off-screen (`translate3d(-100%)`, `opacity 0`) and slides in at full width (`--rail-open-w` 340 px) while `#stage` slides right by the same amount (`translate3d`, slightly dimmed), so the page is pushed aside rather than covered, when `#app.rail-open` is set: Left from the first card of a row, Left at the start of other controls, or Back. `--rail-w` is now `0px`, so every layout calculation that used it gives the screens the full 1920 px, with content starting at `--pad-x` (80 px). Navigation code is unchanged; nav.js still treats the rail items as candidates while hidden.

## Name (15 Nov 2026)

The app is called **Reelhouse** everywhere the user sees it: the config.xml name (TV app list), the page title, the loading screen and messages. Plex sees it as X-Plex-Product/Device-Name Reelhouse. **Deliberately unchanged:** the Tizen app id `MdLoader01.MediaLoader` and package `MdLoader01`, the certificate profile `MediaLoader`, the `medialoader.*` localStorage keys and the file/folder names. Changing the app id would install a second app and lose the saved settings and caches.

## Actors start page (updated 15 Nov 2026)

`People.recent()` now returns mixed rows rather than one row per title. It takes the **top 5 billed leads** of each recent movie or series, removes duplicates (TMDb id or name; a person appears under their newest title), and interleaves them across titles (every title's #1 lead, then every #2...). The rows are "In new releases this week" (< 7 days) / "In last week's releases" / "In recent releases". Cards show the title under the name (`_person.known`), and the banner says "as <character> in <title>". `loadActors()` runs at start-up straight after `goStart()` (and warms the first photos), so Actors is ready when the loading screen closes.

## TV seasons, season screen, Plex app setting, row reset (15 Nov 2026)

- **Seasons in the TV details pop-up** (`#in-seasons` between the description and the buttons; `loadSeasons` / `seasonStatus` / `scrollSeasons` in app.js; `js/seasons.js` `Seasons.forShow`):
  - one card per season, with a status such as "All 22 on disk", "4 of 10 on disk", "22 episodes" or "Starts 3 Dec";
  - season list and summaries come from TVmaze `/shows/{id}/seasons`, and counts from Sonarr `/series/{id}` season statistics;
  - art is Plex's season poster, else Sonarr's (TheTVDB), else TVmaze's, else the show poster;
  - the row slides with a transform; Up from the buttons enters it, and Up from the seasons scrolls the description.
- **Season screen** (`#ss-sheet`, a full-screen `.sheet.season` before `#ps-sheet` in the DOM; `openSeason` / `renderEpisodes` / `episodeOk` / `downloadSeason` / `closeSeason`):
  - layout: season poster plus **Play E<n>** / **Download season** on the left; title, meta, summary and the episode list (`.ep` rows in a `.v-list`, slid with a transform) on the right;
  - episodes merge TVmaze (titles, thumbnails, air dates, runtimes, summaries), Sonarr (`hasFile`) and Plex (`ratingKey`, watched, resume point) by episode number;
  - OK on an episode plays it (`Player.openKey`) when Plex has it. Otherwise it downloads that episode after a second OK ("OK again to download this episode", 5 s), or explains that it hasn't aired / isn't in Plex yet;
  - Download season also needs a second OK and searches only for missing episodes when part of the season is already there;
  - after the player closes, the list reloads to update watched marks; Back returns to the season card in the details pop-up.
- **Sonarr** (`Api.downloadEpisodes(real, season, numbers|null)`):
  - a show not in Sonarr is added with nothing monitored, then the app waits for its episode list;
  - the chosen episodes are monitored (`PUT /episode/monitor`), plus the season itself (`PUT /series/{id}`) for a whole season;
  - then `SeasonSearch` / `EpisodeSearch` runs.
- **Settings › Preferences:** Remote sounds and **Plex app button** (`localStorage['medialoader.ui'].plexApp`, **off by default**). The "Plex app" hand-off button in title details only shows when it's on.
- **Rows reset when you leave them:** `Nav.focus` scrolls the row you were on back to its first item (`data-last=0`) when focus moves to another row or the banner. Opening the side menu or a pop-up keeps your place.

## Full-text page instead of scrolling pop-ups (15 Nov 2026)

The "▲ ▼ to read more" hint and Up/Down scrolling inside the details and person pop-ups are gone.

- **Shortened text:** the description (`#in-overview`) is clamped to 4 lines, or 3 when the seasons row shows (`.has-seasons`). The biography (`#ps-bio`) is clamped to 9.
- **Selecting it:** when the description or anything below it is cut off, `updateInfoScroll` makes it `.focusable`, so Up reaches it with a white ring. OK opens `#tx-sheet` (`openInfoText` / `openPersonText` → `openText`).
- **The full-text page:** a 1200 px sheet above the pop-up (z-index 44, with a spread shadow dimming everything behind). It holds the ratings, the full description and every fact, and Up/Down scroll it (`onUnhandled` → `scrollInfo` on `#tx-body`). Back or Close (`closeText`) returns to the pop-up with the description highlighted.

## App icon (15 Nov 2026)

`icon.png` is 512×423 (Samsung's TV app-icon size): just the centred "Reelhouse" wordmark (the house mark was removed at the user's request; `mark()` is still in the script, unused) (Segoe UI Light + Bold, as on the loading screen) on the dark-navy gradient. It's generated by `tools/make-icon.py` (Python + Pillow, Windows fonts), so edit and re-run that rather than hand-editing the PNG. The TV's launcher decides the final tile shape; Plex's extra-wide tile comes from the Samsung store, which sideloaded apps can't use.

## Start-up: Downloads preloaded, poster loading, chime (15 Nov 2026)

- **Downloads preload:** `init` calls `refreshExtras(true)` and `checkRequests(true)`. While booting, `refreshExtras` also runs `warmDownloads()`, which loads the first 12 posters of the first 3 Downloads rows. The loading screen waits for that and the first queue poll (`state.extrasDone && state.queueLoaded`), up to 10 s from start. `openDownloads` only refetches when the data is over 2 minutes old.
- **Posters load per card on every screen:** `loadRowArt` shows a row's first 12 (`ROW_FIRST`) when the row comes near the screen, and `loadAhead` shows up to 8 cards ahead of the focused one (`showPoster` sets each once). Download cards use the same path (`card._poster`). Before this, Downloads loaded all ~60 full-size TheTVDB/TMDb posters on opening.
- **Start-up chime and fade:** `#app.intro` keeps `#stage` transparent (and slightly scaled) behind the loading screen. When the loading screen closes, `intro` is removed (1 s opacity fade) while the splash fades out over 0.9 s, and `Sounds.play('intro')` plays a rising C-major arpeggio, about 2 s long, synthesised. It's silent when Remote sounds is off.

## Side menu heading (15 Nov 2026)

The side menu starts with the "Reelhouse" wordmark (`.rail-logo`, 44 px, "Reel" light + "house" bold blue, as on the loading screen and icon), level with the search box, above the menu items. It isn't focusable.

## Settings order (15 Nov 2026)

The Preferences card (Remote sounds, Plex app button) is now the **first** card (`form.insertBefore`), and Settings opens on Remote sounds. Down from the switches goes to Sonarr (address / quality), Down from each server address goes to that app's API key, and Down from the last key goes to Save.

## Trailers in the main player; steady actor banner (15 Nov 2026)

- **Trailers** play in the main player (`Player.openUrl(url, title, 'Trailer')`, a session with `S.direct`). They get the same controls and keys (pause, ±10/30, Left/Right scrubbing, Back hides then stops) and skip the Plex-only parts: no progress reporting, resume, Up Next or audio/subtitle menu (the menu button is hidden). Only Plex's trailer extras are offered. YouTube refused to play inside the app, so the YouTube embed, the old `#tr-sheet` trailer player and the YouTube-app fallback were removed. `findTrailer` shows the Trailer button only after `probeVideo` loads the trailer's metadata in a hidden `<video>` (10 s limit).
- **Actor banner:** the banner text is anchored to the bottom, and a person's biography loads a moment after the banner shows, which used to push the name up. `setHero` adds `.person` to `#hero-info` for people, which reserves 3 lines (122 px) for the biography and keeps the role on one line, so the name doesn't move.

## Details pop-up: facts hidden, remembered Up/Down (15 Nov 2026)

- **Facts:** `#in-facts` (first aired, runtime, genres…) is hidden in the details pop-up. It's still filled in, and the full-text page shows it. The description is selectable whenever there are facts (`updateInfoScroll`), so they're always one OK away.
- **Up/Down:** `updateInfoNav()` sets `data-nav-*` overrides from `infoNav` (the last button and last season focused; reset on each `openInfo`). Buttons Up go to the last season, or else the description. Seasons Up go to the description and Down to the last button. Description Down goes to the last season, or else the last button. The first and last season cards point Left/Right at themselves so the row stops at its ends. Season cards have ids `in-season-<n>`.

## Responsiveness during start-up (15 Nov 2026; measured on the TV)

Measured over remote debugging with `Page.addScriptToEvaluateOnNewDocument` (a long-task observer, key-to-frame latency, and wrappers that log XHR loads, JSON.parse/stringify, localStorage writes, DOM additions and image loads), a CPU profile, and simulated Up/Down every 0.7 s for 25 s. Full `Tracing` crashed the TV's debug connection, so don't use it.

- **Main cause: banner backgrounds at original size.** TVmaze, TMDb and TheTVDB originals are often 4K, and decoding and scaling one blocked the main thread for up to 2 s. `heroImage(url)` now caps them at 1280 px: TMDb `/original/` becomes `/w1280/`, and anything else goes through the Plex photo transcoder (`/photo/:/transcode?width=1280&height=720&url=…`, about 0.1 s on the server). It's used by `setBackdrop`, `warmImages`, the loading screen's preload and the season screen.
- **Building screens:** `renderRows` builds the first 4 rows (`FIRST_ROWS`) at once and the rest 3 at a time, pausing while keys are pressed (`lastKeyAt`). Building all of Movies at once (28 rows, 618 cards) took 453 ms. Only the first 3 rows get the card entry animation. `renderRows(true)` builds everything at once (used when leaving a Similar/Cast page, so the card to return to exists).
- **No surprise rebuilds:** fresh feed rows never replace the screen you're on (`pendingFeed`); they apply the next time the screen opens, or straight away if it had no rows.
- **Background work:** `whenIdle(fn)` waits until the remote has been quiet for 0.7 s. `afterBoot` loads the other screens' feeds one at a time through it, and `pumpLibrary` and `warmImages` wait for quiet too.
- **Result:** total blocked time in the first 25 s went from ~5.9 s to 0.9 s, the worst freeze from ~2 s to 0.18 s (while the loading screen is still up), with nothing after the loading screen closes; key-to-frame latency is 64–81 ms for the first presses, then about 18–36 ms.

## Player subtitles fixed (15 Nov 2026; debugged on the TV with an MKV that has 41 SRT tracks inside the file)

- **Cause:** `setSilentSubtitle(true)` also stops AVPlay firing `onsubtitlechange`, so no lines ever arrived. For text subtitles inside the file the player now selects the track and sets `setSilentSubtitle(false)`. AVPlay doesn't draw subtitles in web apps, so they aren't shown twice. Silent stays on when subtitles are off or come from a separate file.
- **Line format:** AVPlay sends lines like `"Here we go.\r<br>Here we go"`, plus a blank line with duration 0 to clear. `\r` is stripped, `<br>` becomes a line break, other tags are removed (except i/b/u), and the blank line clears the display.
- **Only usable subtitles are listed** (`subUsable`). AVPlay exposed only the first 30 of the file's 41 text tracks (`S.textTracks` is read after loading), so the rest are hidden, and a remembered choice that can't be shown is dropped. Separate files and picture subtitles always show (picture ones are burned in by Plex). When Plex is converting the video, subtitles inside the file are now burned in too (`subtitles=burn`), because the converted stream doesn't carry them.
- **Plex can't serve subtitles inside the file** (`/library/streams/{id}` returns 501 for them), so AVPlay is the only source for direct play.
- **Menu scrolling:** `.pl-menu-list` is `position: relative` so item offsets are measured within the list (they used to include the panel heading, which hid the top item). Moving up keeps each section heading in view, and the first section scrolls fully to the top.

## Subtitle timing (15 Nov 2026)

The player menu has a **Subtitle timing** section while subtitles are on. It's a single adjustable item (`timing`/`adjust` in `menuItems`): Left/Right change it by 0.1 s, from 10 s earlier to 10 s later (holding repeats), and OK resets to In sync. The label reads like "◀ 0.3 s later ▶" (`setSubOffset`, `S.subOffset` ms, positive = later). In the menu, Left only closes the menu when the highlighted item isn't adjustable. It lasts for the playback session, including restarts and track changes.

- **Separate subtitle files:** cues are matched at `now() - offset`.
- **Subtitles inside the file (AVPlay):** `webapis.avplay.setSubtitlePosition(ms)`. Verified on the TV: +3000 showed lines 3 s later and −3000 3 s earlier.
- **TVs without `setSubtitlePosition`:** 'later' falls back to delaying each line, and 'earlier' isn't offered.

## Recently played, In library first, resume episodes (15 Nov 2026)

- **Recently played** is the first row on TV Shows / Movies / Music when there's anything in it (`rowsOf` adds `{title:'Recently played', recent:true}`).
  - Kept by Reelhouse in `localStorage['medialoader.recent']`: up to 20 feed-style descriptors per kind, with `at`.
  - `rememberPlayed(kind, item)` adds a title once playback actually starts (`playHere`, episode and season Play, and a successful Play In Plex).
  - `loadRecent()` at start-up shows the saved rows, then merges Plex's history (`Plex.recentlyPlayed`: each library's `/all?sort=lastViewedAt:desc&viewCount>>=1&includeGuids=1`, skipping home and music videos and the "Various" artist; images via `Plex.photo`).
  - `showRecent` only redraws the screen when you're on its first poster, so nothing moves under you.
- **In library first** (Preferences, on by default, `ui.libraryFirst`): `renderRows` puts titles you have before the rest in each category row (not search results, Similar pages or Recently played). It's a stable sort using `inLibrary` or any earlier library check in `libCache`, ignoring its 6-hour age. Rows aren't re-sorted while you look at them.
- **TV Play button:** once a show is known to be on disk, `Plex.target` picks the episode: Plex's On Deck, else the unfinished one, else the one after the last watched (in order), else the first. The button says "▶ Resume S2 · E4" or "▶ Play S2 · E5" and `Player.openKey(ratingKey, resume)` plays exactly that, continuing from the resume point without asking when it says Resume. No label jump: while the episode is being found the button gets `.label-wait` (its text hidden), so the label appears once. `findTarget` keeps the result on the show (`item._target`) for the session, cleared after playing. `heroFor` looks it up ahead of time after resting 0.6 s on a show you have.

## Similar to recently played; theme music (15 Nov 2026)

- **Similar to recently played:** the second row on TV Shows / Movies / Music when Recently played has anything (`loadSimilarToRecent`).
  - Built from `Feeds.similar` for the 3 most recent titles: Radarr recommendations, TVmaze shared lead actors, Deezer related artists.
  - Uses each title's first row, interleaved and de-duplicated, without anything already in Recently played; up to 20 cards.
  - Saved in `recentStore['similar_<kind>']` with the signature of the 3 titles and a 12 h lifetime. It's rebuilt only while the remote is idle (`whenIdle`) when that signature changes.
- **Theme music** (Preferences › Theme music, on by default, `ui.themeMusic`):
  - When title details open, the Plex item's `theme` (an MP3 at `/library/metadata/{id}/theme/{ts}`, included in `/hubs/search` results; TV shows usually have them, films often don't) plays through a hidden `Audio()`.
  - It fades in to 0.45 volume over 1.5 s and keeps playing on the season screen and full-text page while the details stay open.
  - It fades out in 0.7 s on `closeInfo` and stops in 0.15 s when the player starts (`Player.onStart`), when the app is hidden, or when the switch is turned off.
  - Verified on the TV.
- **Preferences card:** now 2 × 2 (Remote sounds | Plex app button / In library first | Theme music), with explicit `data-nav` up/down between the switches and into Sonarr.

## Recast cast labels, artwork fallbacks, background artwork, description stays put (15 Nov 2026)

- **Recast / revival cast** (`annotateRecasts` in people.js): TVmaze merges revival casts into the show (a long-running sitcom with a one-off revival lists both the original and the revival actors for each role). When several actors share a character and one is in Plex's cast for the show (`Role` on `/library/metadata/{id}`, the main cast), the others get `note`: "<year> special" (one episode after a gap of 8+ years in TVmaze's episode dates), "<year> revival" (several), or "recast" (no gap). They're listed after the main cast in their own Cast-page row ("In the 2016 special") and labelled on cards, the banner and the person pop-up.
- **Artwork fallbacks** (`findArt`): a feed card with no poster (TVmaze has none for some shows, e.g. Flickers) gets the Sonarr / Radarr / Lidarr lookup's image (TheTVDB / TMDb), else Plex's `thumb`. It's looked up 2 at a time while the remote is quiet, and cards and banner update in place.
- **No poster anywhere:** some new shows only have a wide background (The Well, 2026: TVmaze has only a background, TheTVDB only fanart). `findArt` then uses that background (lookup fanart, the feed backdrop, or TVmaze `loadBackdrop`), resized and cropped by Plex to 342×513, as the card image, with the title in a `.wide-title` strip (`item._wideArt`, kept when rows are redrawn).
- **Background artwork preloading** (`preloadAllArt` / `pumpPreload`): after start-up and after each feed refresh, every row's posters plus each row's first 3 banner images (current screen first, then the others) download one at a time. It pauses while a key was pressed in the last 1.5 s or the player is open; each request is capped at 8 s. Measured: 228 images fetched while idle, 1 while pressing keys.
- **Description Left/Right:** `#in-overview` and `#ps-bio` point Left/Right at themselves, so they no longer jump to a season or button.

## Scrolling long names (15 Nov 2026)

`startMarquee(box)` / `stopMarquee()` (called from `onFocus`): when a highlighted season name (`.season-card b`) or episode title (`.ep-text h3`) is cut off, its text is wrapped in a span and scrolled with the Web Animations API. It moves sideways only (transform), about 45 px/s, pausing 1.2 s at each end and going back and forth. Moving away restores the plain text and its "…". 

## Actor photo and biography fallbacks (15 Nov 2026)

- **Photos** (`People.photo`, saved 30 days as `ph2:<name>`, including "none found"): the cast list's own image (TMDb / TVmaze), then TVmaze's people search (exact name, else near-miss), then the Wikipedia article's image, then Wikidata's Commons portrait. Person cards without a photo go through `findArt` (2 at a time, while the remote is quiet) and update in place.
- **Biographies** (`biography`, saved as `b4:<title>`): the article Wikidata links to (trusted), else the name as a title (must look like a performer: `ACTING_WORDS` in the description or opening), else a Wikipedia search for "<name> actor". Exact matches are trusted; a near-miss spelling must be about a performer. If nothing matches, it searches once more using Wikipedia's spelling suggestion. Last resort: Wikidata's short description.
- **Near-miss names** (`closeName`): same first name and at most 2 letters different. Needed because cast lists misspell names (TVmaze's Flickers cast has "Philip Madog" for Philip Madoc; the photo comes from TVmaze's correctly spelt Philip Madoc, and the biography from Wikipedia via its "philip madoc" suggestion). Some people have nothing anywhere (Fraser Gains in Flickers): their card keeps the person icon.

## Downloading banner, no 'to buy' rows, picture picker, streaming service rows (15 Nov 2026)

- **Downloading banner:** updateCard adds .dl (a blue corner banner reading Downloading) while a title is searching, queued, downloading or importing, and in-lib (In Library) otherwise.
- **No 'to buy' rows:** the iTunes TV chart now only feeds genre rows (the 'Top TV seasons to buy' row is gone), and the movie chart row is 'Top movies on iTunes'. STORE_VERSION is 8.
- **Picture picker:** #in-art, a picture-icon button left of Cast, appears when TVmaze has 2+ posters (Feeds.images). #art-sheet lists them; OK saves the choice to localStorage['medialoader.art'] (key: the feed key or tvdb:<id>), used by chosenArt for cards and the details poster.
- **Streaming service rows (TV):** groupRows groups this week's airing shows by TVmaze webChannel (Apple TV, Disney+, Hulu, Paramount+, BBC iPlayer…), needs 4+ shows, keeps the 6 busiest, and places them after Popular this week. Movies have no free per-service data, and studios are too thin in the trending/popular lists (no studio has more than 3 films), so there are no movie rows of this kind.

## Genre / Publisher screens; automatic intro and credits skipping (15 Nov 2026)

- **Genre / Publisher buttons:** `#hero-genre` / `#hero-pub` sit right of More info on TV Shows / Movies / Music (category rows only, not on stacked pages, search results or Downloads; `updateBrowseButtons` from `setHero`).
  - OK opens `#gp-sheet` (`openBrowse(type)`): a 4-column grid of tiles (name, title count, three posters) for every genre or publisher among the screen's feed titles, biggest first, slid with a transform (`scrollBrowse`).
  - Genres use the genre-row names (`Feeds.genreName`: TMDb/TVmaze names → "Sci-Fi & Fantasy" etc.). Publishers with 1 title are dropped when there are 8+ with 2 or more.
  - OK on a tile (`chooseBrowse`) pushes a page with only that group's titles, keeping the screen's own rows ("More <name>" for the group's own genre row). Back returns to the grid on that tile, Back again to the button.
- **Publisher data (`pub` on descriptors, STORE_VERSION 9):** TV = TVmaze web channel, else network; movies = Radarr metadata `Studio`; iTunes movies and albums = `rightsHolder(rights.label)`, which tidies copyright lines ("An Atlantic Records Release, ℗ 2026 …" → "Atlantic Records", major studios by name). iTunes TV seasons get no publisher (their copyright lines are the studio, not the channel). Apple Music's chart has no label, so music labels come only from iTunes charts.
- **Intros and credits (player):** skipped automatically by default (`prefs.skipIntro` / `prefs.skipCredits`; menu › Skipping).
  - After an intro is skipped, a **Play intro** button shows for 8 s (OK jumps back and plays it).
  - At a movie's credits (or a last episode's), **Play credits · 5** counts down, then playback ends as watched (`finished()`); OK keeps playing.
  - Each marker is skipped once per session (`S.autoSkipped`), so going back plays it, with a manual "Skip Intro" button.
  - Episodes with a next episode still get Up Next at the credits.
  - With automatic skipping off, it's the old "Skip Intro" / "Skip Credits".
  - The button sits bottom right (80 px in), lifted above the controls while they show.

## Actor banner: photo filmstrip (15 Nov 2026)

When a person is in the banner (Actors screen, Cast pages, an actor's page), their main photo shows first, as before. If more photos are found, a slow filmstrip of them fades in across the **whole banner width** and drifts right to left (`personStrip` / `showStrip` in app.js, `#hero-strip`). The strip sits above `.hero-scrim` and has its own lighter scrim (`.hero-strip::after`), so the photos show right across while the text stays readable.

- **Photos** (`People.gallery(item)`, saved 30 days as `g4:<qid>`, up to 10 candidates, the main photo first), most varied first:
  0. with the optional `TMDB_TOKEN` (`MEDIALOADER_TMDB.token`, from `.env` via build-tv.ps1 / the Docker config script): TMDb's photo gallery (`/3/person/{id}/images`, bearer token, best rated first, at most 5 up front). It's rich for well-known actors (Ranbir Kapoor: 17) and often only the main photo for others;
  1. every Wikidata portrait (P18; `fromEntity` keeps them all as `images`, plus the Commons category P373 as `category`);
  2. **TVmaze character images**: a photo of them in each role (`/people/{id}/castcredits?embed=character`). This is the best source for TV actors, who often have one photo or none on Wikimedia (Alberta Watson: none on Commons, three roles on TVmaze);
  3. pictures in their Wikipedia article (`/page/media-list`, including screenshots that aren't on Commons), at the largest size offered;
  4. files in their Commons category that look like a portrait of them alone: JPEG, not landscape, their surname in the file name, and none of "signature", "poster", "with", "and"...;
  5. TVmaze's own photo, last, because it's often the TMDb main photo again.

  Commons files are used by their direct `upload.wikimedia.org` thumbnail address (`imageinfo` `thumburl`). The `Special:FilePath` redirect has no CORS header, so pictures loaded through it couldn't be compared. Duplicate URLs are matched by file name (`fileKey`).
- **Copies of the same picture** (`loadPhotos` in app.js): the same photo often comes from TMDb, TVmaze and Commons under different names (Don Francks's 1966 portrait came three times). Images are loaded with `crossOrigin='anonymous'` (TMDb, TVmaze and Wikimedia all send `Access-Control-Allow-Origin: *`; a host that doesn't gets a plain load and isn't checked). `photoPrint` makes a 64-bit difference hash of the part the tile shows, and pictures within 10 bits of one already kept are dropped. The strip keeps at most 6 and needs 2 different photos.
- **Drawing:** each photo is cropped to a 480×600 tile (top-aligned), with its left 160 px fading in over the previous one (`destination-in` gradient). The tiles are drawn once into one canvas, repeated so the strip loops seamlessly every `n × 320` px.
- **Animation:** the canvas is moved with a WAAPI `translate3d` animation at 22 px/s, transform only and no masks (masked animating layers flicker on the TV). The scrim above fades its left edge into the page. It starts with a later copy of the main photo centred where the portrait sits, so the change is seamless.
- **Speed when flicking through a cast:**
  - `People.focus(name)` gives the highlighted person a second Wikimedia request lane, so their lookups don't wait behind the other cast members' background photo and biography lookups (`wiki(url, timeout, who)`, `pumpWiki`).
  - The gallery needs only the Wikidata entry, not the biography (`resolve`).
  - `byTmdb` finds the Wikidata entry with the search index (`haswbstatement:P4985=<id>`, ~0.4 s) instead of SPARQL (several seconds; still the fallback).
  - The people either side are prefetched once a strip is found (`prefetchNeighbours`).
  - Measured on a real Cast page: the first strip shows 4.6 s after the page opens (it was ~10 s), the next people's after 1.3–3 s.
  - Every Wikimedia request costs a CORS preflight because of `Api-User-Agent`, which Wikimedia asks browser apps to send.
- **Lifecycle:** nothing is fetched until you've rested on a person for 0.2 s; then all the photos show at once as soon as they've loaded (no hold on the main photo, no pause before moving), and the strip is drawn only while the remote is quiet (`whenIdle`). Moving away fades it out and frees the canvas (`width = 0`), which matters on the TV's limited memory: about 3000–5000 × 600 px.
- `People` requests to commons.wikimedia.org send `Api-User-Agent` too (allowed by CORS, verified live).

## Player speed, theme loop, picture picker, fixes (15 Nov 2026)

- **Playback speed** (player menu › Playback speed: Normal, 1.25×, 1.5×, 1.75×, 2×; the menu button is now "Options"):
  - engines have `rate(r)` returning whether it took: HTML5 sets `playbackRate` (pitch kept); AVPlay calls `setSpeed` and re-applies it after a pause or seek;
  - a refused speed falls back to Normal with "This TV can't play at 2×" in the menu;
  - `S.speed` is kept across restarts in the same session (quality / audio / subtitle changes).
  - **Not yet tried on the TV.** Samsung documents `setSpeed` mainly for trick play; some models may refuse 1.25/1.5/1.75 or mute the sound above 1×.
- **Theme music loops:** on `ended` it restarts and eases over 2 s to 10% less of its starting level (`THEME_STEP`): 90%, 80%… and stops after the tenth loop. Checked in a browser: 0.225 → 0.203 → 0.18 … 0.022 → stopped.
- **Picture picker "Original":** the first card is the title's own poster (often TheTVDB via Sonarr or the feed, not TVmaze); choosing it deletes the saved choice. `chooseArt` no longer overwrites `item.view.poster`; `chosenArt` applies the choice where pictures are drawn.
- **No YouTube category:** `channelOf` / `webChannel` in feeds.js ignore TVmaze's "YouTube" web channel, so there's no YouTube streaming row or Publisher tile (`STORE_VERSION` 10).
- **"Watched … ago"** in Recently played is worked out when the row is shown, from the latest play (`at`). It used to be saved with Plex's history entry and went stale, and Plex only updates `lastViewedAt` when you finish something.
- **Focus no longer enters closed pop-ups:** they're hidden with `visibility` and keep their layout, so `Nav` candidates now skip anything inside `.sheet:not(.open)`. Up from a Cast page's first row used to land on the closed details pop-up's description, with nothing visible highlighted.
- **Banner photo strip:** all photos show at once as soon as they're loaded (no hold on the main photo). `.hero-bg.portrait` is now the same 480×600 box as a strip tile, so the main photo no longer jumps in size when the strip appears.

## GitHub: CI, security scanning, releases (15 Nov 2026)

Workflows in `.github/workflows/` (repo `dddaaammmooo/reelhouse`):

| Workflow | When | What |
|---|---|---|
| `ci.yml` | push to main, PRs | `npm ci`, unit tests with c8 coverage (artifact), `npm audit --audit-level=high` |
| `codeql.yml` | push, PRs, weekly | CodeQL `security-extended` for JavaScript and for the workflows themselves |
| `dependency-review.yml` | PRs | Blocks new dependencies with high-severity advisories |
| `secret-scan.yml` | push, PRs, weekly | gitleaks over the full history (API keys, Plex tokens) |
| `scorecard.yml` | push, weekly | OpenSSF Scorecard, results in code scanning |
| `tv-package.yml` | called by release-please; or by hand | Installs the Tizen Studio 6.1 CLI (installer pinned by SHA-256), signs `Reelhouse.wgt` with the owner's Samsung certificate from secrets (`tools/package-tv.sh`) and attaches it to the release (by hand: a 14-day build artifact). No keys or tokens in the package. |
| `release-please.yml` | push to main | Release PR from conventional commits; merging it tags `vX.Y.Z`, writes `CHANGELOG.md`, bumps `package.json` and `config.xml`'s `version` (xml updater, `release-please-config.json`), and attaches an unsigned zip of the app files |

- Dependabot (`.github/dependabot.yml`) updates npm and Actions weekly.
- **Commit messages must be conventional** (`feat:`, `fix:`, `feat!:` …) or release-please ignores them. The first public commit is tagged `v1.1.0` to match `.release-please-manifest.json`.
- **Signed releases:** secrets `TIZEN_AUTHOR_P12` / `TIZEN_DISTRIBUTOR_P12` (base64 of the files in `%USERPROFILE%\SamsungCertificate\MediaLoader\`) and `TIZEN_AUTHOR_PASSWORD` / `TIZEN_DISTRIBUTOR_PASSWORD`.
  - The passwords must be entered by the owner: Tizen Studio keeps them encrypted in `.pwd` files that can't be read back.
  - **How the CLI reads profile passwords** (found by disassembling the CLI's own `lib-ncli` jars):
    - an attribute ending in `.pwd` is looked up in the desktop keyring (`LinuxCrypt`, through the bundled `secret-tool`), which a runner doesn't have;
    - anything else is decrypted with `CipherUtil`, a fixed-key DES over base64. A plain password only works by luck: `citestpass` "decrypted" to itself, while an 8-character letters-and-digits one throws `IllegalBlockSizeException`, so the CLI stops to ask, and that crashes with no terminal (`ConsolePrompter` NPE).
  - So `package-tv.sh` writes `profiles.xml` with each password encrypted by the CLI's own `CipherUtil` (`tools/TizenPassword.java`, run with a JDK 17 from `setup-java`; the CLI bundles Java 8). Tizen's log4j prints to stdout, so the value comes on a `TIZENPW:` line.
  - Further checks:
    - each password must open its `.p12` (openssl) first;
    - a trailing line ending from pasting is dropped;
    - the `.wgt` must exist, because the CLI can fail and still exit 0;
    - its `author-signature.xml` certificate must match the author `.p12` (SHA-256 fingerprint; only match/no-match is printed). Without a usable profile the CLI quietly signs with something else.
  - Tested in Ubuntu 24.04 with throwaway certificates: 8 alphanumeric characters, 10 letters, symbols (`&<"\`), and a wrong password.
  - The package only installs on the DUIDs in the distributor certificate and carries no API keys (release files are public); `build-tv.ps1` is still the way to install with `.env` baked in.
  - Verified in an Ubuntu 24.04 container with a throwaway certificate.
- Local check before pushing: `docker run --rm -v "<repo>:/repo" zricethezav/gitleaks:latest dir /repo` (with `MSYS_NO_PATHCONV=1` in Git Bash). Only `.env` and `.buildResult/` should be flagged, and both are git-ignored. Delete any report file afterwards, because it contains the secrets.
- `SECURITY.md` points reporters to private advisories.

## Known leftovers / cleanup candidates

- `app.js`: `syncList()` is now unused; `state.armed` / `armTimer` and `disarm()` (a no-op) remain from the old poster-confirm overlay.
- `css/style.css`: old `.dl-item`/`.dl-*` list styles, `.confirm` / `.card.armed` overlay styles and `.empty` are unused since Downloads moved to cards.
- `index.html` no longer has `screen-home` / `screen-downloads`; any CSS referring to them can go.

Remove carefully. Grep first; several class names (`.status`, `.pill`, `.dl-bar`) are still used by the modals and cards.

## Conventions

- Keep comments short and explain *why*. Spacing uses the `--s-*` / `--top` tokens. Keep layout maths in CSS comments up to date.
- User-facing copy: plain, direct, no key hints, no "Loading…" placeholders.
- After any visible change, render all screens (TV/Movies/Music/Similar/Downloads/Settings, details modals) and walk the remote path: Up/Down between search ↔ More info ↔ rows, row wrap, Back flow, modal focus traps.
