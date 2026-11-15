# Reelhouse

A Samsung Tizen TV web app that brings Sonarr (TV), Radarr (Movies) and Lidarr (Music) together behind one
remote-friendly interface: browse or search, press **OK** on a poster for its details, then **Download**.

## Screens

The app opens on **TV Shows** with the first poster highlighted. The side menu (press **Left**) has TV Shows, Movies, Music, Actors, Downloads and Settings.

- **TV Shows / Movies / Music:** a large preview at the top shows the backdrop, details and status of the highlighted title. Category rows sit underneath; all three screens' rows load in the background at start-up. The focused row snaps to the top of the row area, and the next row's heading shows below it. Down on the last row wraps back to the first. The search box sits above the preview; results appear as you type and replace the rows, and clearing the search brings the rows back.
- **Title details:** OK on a poster opens a centred pop-up with the poster on the left. It shows the full description, ratings (IMDb, TMDb, Rotten Tomatoes, Metacritic for movies), release dates, runtime, genres, certification and studio or network, loaded from Sonarr, Radarr or Lidarr. **Download** starts the download. **Cast** (movies and TV) opens the cast as portrait photos; OK on a person shows their full-size photo, biography and the movies and shows they're in, and **Movies & TV shows** opens those as poster rows. **Similar** (left of Close) opens a page in the same rows layout, titled "Shows similar to <title>":
  - Movies: TMDb recommendations (via Radarr's public metadata service).
  - TV: other shows starring the main cast (TVmaze).
  - Music: related artists, and the artists those are related to (Deezer).
  - All three: "More <genre>" rows from titles already loaded. Back returns to where you were.
- **Actors:** opens on the cast of the newest movies and TV series (one row per title, newest release first), as portrait photos. Search for any actor by name (Wikidata). OK on a result opens a page with their photo and biography first, then rows of every movie and TV show they're in; each opens the normal details pop-up, so you can download or play from there. Pages opened from other pages (Similar, Cast, an actor) stack up, and Back returns through them one at a time.
- **Downloads** uses the same layout: a banner for the highlighted download (status, progress, time left, description), then rows of poster cards grouped as *Needs attention · Downloading · Importing · Waiting*. It refreshes every 4 seconds while open, and every 15 seconds elsewhere, without moving your place. OK on a card (or **More info**) opens a pop-up with progress, file name, quality, source, downloader and save location, plus **Cancel download** and **Find another release**. Both need a second OK to confirm.
- **Video player:** titles on disk show **▶ Play**, which plays movies and episodes from Plex inside MediaLoader: original quality when the TV can play the file, otherwise converted by Plex. It offers resume, audio track and subtitle choice (subtitles inside the file, separate subtitle files, and picture subtitles), subtitle size, quality, preview thumbnails while scrubbing, Skip Intro / Skip Credits, Up Next for episodes, and the remote's play/pause keys. Progress syncs back to Plex. **Open in Plex** hands the title to the Plex app instead.
- **Search keyboard:** OK on the search box opens a letter grid (a–z, 0–9, Space, Delete, Clear) under it, like Plex's; results update as you type. Down goes to the results, and Back closes it.
- **Remote sounds:** a soft click when you move, select or go back, with its own sound for Back. Turn them off in Settings › Remote sounds.
- **Settings** has a server address and API key for each app, and a connection status that is checked automatically. Keys are always hidden apart from their last 4 characters. Editing a key starts with an empty field; leave it empty to keep the current key.

## Category rows (no accounts needed)

| Screen | Rows | Sources |
| --- | --- | --- |
| TV Shows | New series this week · Returning this week · Premiering soon · Popular this week · streaming-service rows · genre rows | TVmaze schedule (English-language premieres, streaming and US networks); iTunes TV chart (genres) |
| Movies | In cinemas & new releases · Coming soon to cinemas · Top movies on iTunes · Popular right now · genre rows | Radarr's public TMDb lists (trending, popular); iTunes movie chart |
| Music | Popular new albums · Most played right now · genre rows | Apple Music most-played albums chart |

Charts use region `au`; set `MEDIALOADER_REGION` in `js/config.js` to change it. Downloading from the Music rows adds the artist to Lidarr but monitors **only their latest album**.

**Saved between launches:** rows are kept in browser storage, so they appear immediately when the app starts. They're refreshed in the background once they're more than 30 minutes old. Fresh rows only replace what's on screen if you haven't started browsing; otherwise they're used the next time the screen opens.

Radarr's metadata service, Apple's music feed and Deezer don't allow direct requests from an ordinary web browser (CORS). The Docker container proxies them at `/feeds/radarr`, `/feeds/apple` and `/feeds/deezer`, On the TV the app calls the sources directly; Tizen apps generally aren't subject to CORS, but confirm this on your set.

## Downloading

| Action | What happens |
| --- | --- |
| **Download** on a new title | Adds it to the right app with its first root folder and quality profile, monitored, and starts searching straight away. |
| **Search for missing** on a title you already have | Sends a `SeriesSearch` / `MoviesSearch` / `ArtistSearch` command so it fetches anything missing. |

**Cancelling:** *Cancel download* removes the item from the queue and deletes it from your download client. *Find another release* does the same, but also blocks that release so the app searches for a different one.

**Remote:** use the arrows to move and OK to select. Press OK on the search box to open the keyboard. **More info** sits under the banner's description, between the search box and the first row.

- **Return/Back** closes a pop-up. Otherwise it opens the side menu on the current screen (so does **Left** from the content); **Right** closes it again.
- Back from the side menu goes to TV Shows, or exits the app if you're already there.
- In the details pop-up, **Up** highlights a shortened description; OK opens it in full.

## Configuration

Everything the app needs to reach your servers lives in a `.env` file at the root of the project. It's git-ignored, so keys never end up in the repository.

```sh
cp .env.example .env
```

| Variable | What to put in it |
|---|---|
| `SONARR_URL`, `RADARR_URL`, `LIDARR_URL` | Server addresses, e.g. `http://192.168.1.20:8989`. Use IP addresses for the TV: most Samsung TVs can't resolve `.local` names. |
| `SONARR_API_KEY`, `RADARR_API_KEY`, `LIDARR_API_KEY` | Each app's **Settings › General › Security › API Key**. |
| `SONARR_QUALITY_PROFILE`, `RADARR_QUALITY_PROFILE`, `LIDARR_QUALITY_PROFILE` | Quality profile name used for new downloads. Empty means the app's first profile (Lidarr: the root folder's default). Can be changed later in the app's Settings. |
| `PLEX_URL`, `PLEX_TOKEN` | Optional. Your Plex server and the **server owner's** token, for the built-in player, Play In Plex, Recently played and theme music. ([Finding a token](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/)) |

`.env` is read in two places: the Docker container (for browser testing) and `build-tv.ps1` (baked into the TV package). The repository's `js/config.js` only holds placeholders and is never modified.

No servers yet? The app still starts: the category rows come from public feeds, and each media screen asks for its keys in Settings.

## Run it locally in a browser

The app is plain HTML, CSS and JavaScript with no build step, so any desktop Chrome or Edge can run it. The layout is fixed at 1920×1080; use a full-screen window or zoom out (Ctrl + −) on smaller displays.

### Option A: Docker (recommended)

Needs [Docker Desktop](https://www.docker.com/products/docker-desktop/).

```sh
cp .env.example .env            # fill in your addresses and keys
docker compose up -d --build
```

Open **http://localhost:8080**.

- `index.html`, `css/` and `js/` are mounted into the container, so edit a file and refresh; nothing is cached.
- After changing `.env`, run `docker compose up -d` again (the container writes `/js/config.js` from it at start-up).
- Rebuild with `--build` only after changing the `Dockerfile` or anything in `docker/`.
- The container also proxies three public feeds that block browser requests (CORS): Radarr's metadata lists, Apple Music charts and Deezer. Without Docker, those rows stay empty in a browser.
- Stop it with `docker compose down`.

### Option B: any static web server

```sh
npx http-server . -p 8080 -c-1        # or: python -m http.server 8080
```

Open http://localhost:8080, then enter your server addresses and keys on the **Settings** screen (they're kept in the browser's local storage). The Movies and Music rows and Similar pages are partly empty this way because of the CORS feeds above; TV rows, search, downloads and the player work.

### Using it with a keyboard

| Key | Remote button |
|---|---|
| Arrow keys | D-pad |
| Enter | OK |
| Esc (or Backspace outside a text field) | Back |
| Letters and numbers | Type into the search keyboard |

### Try it on the TV without installing

With the Docker container running, open the TV's **Internet** app and go to `http://<your-PC's-IP>:8080`. Allow inbound TCP 8080 through the PC's firewall. It's a quick way to check the TV can reach your servers, but some things only work in the installed app: the remote's Back button acts as browser Back, the built-in player uses the browser's video element instead of Samsung's, and Play In Plex can't open the Plex app.

### Automated tests

```sh
npm ci
npm test              # unit tests (node --test), against a made-up mock media world
npm run coverage      # the same with a coverage report in coverage/
```

The tests never contact real servers: `tests/mock/world.js` answers every Sonarr, Radarr, Lidarr, Plex and public-feed request with fictional data.

## Deploy to a Samsung TV

Samsung TVs only install apps that are signed with a **Samsung certificate made for that specific TV**. A free Samsung account is enough. The steps below are for Windows; Tizen Studio also runs on macOS and Linux, but `build-tv.ps1` is a PowerShell script.

Tested on a 2019 Samsung Q60R (Tizen 5.0); it should work on any Samsung TV from 2017 onwards (Tizen 3.0+).

### One-time setup

**1. Install Tizen Studio** on the PC.

- Download the **IDE installer** (not the CLI-only one) from [developer.tizen.org](https://developer.tizen.org/development/tizen-studio/download) and install it, e.g. to `C:\tizen-studio`.
- Open the **Package Manager** (`C:\tizen-studio\package-manager\package-manager.exe`; it needs administrator rights). Under **Extension SDK**, install **TV Extensions** (the newest version; it builds for older TVs too) and the **Samsung Certificate Extension**.

**2. Put the TV in Developer Mode.**

1. Open **Apps** on the TV and enter **1 2 3 4 5** with the remote (on a Smart Remote, press the **123** button for the number pad).
2. Turn **Developer mode** on and enter your PC's IP address (from `ipconfig`) as **Host PC IP**.
3. Restart the TV by **holding the power button** until the logo appears. A short press doesn't apply the change.
4. Note the TV's IP address: **Settings › General › Network › Network Status › IP Settings**.

**3. Connect to the TV.**

```powershell
C:\tizen-studio\tools\sdb.exe connect <tv-ip>
C:\tizen-studio\tools\sdb.exe devices        # should list <tv-ip>:26101  device  <model>
```

Allow `sdb.exe` through Windows Firewall if asked.

**4. Create the signing certificate** (with the TV still connected).

1. In Tizen Studio, open **Tools › Certificate Manager** and click **+**.
2. Choose **Samsung**, device type **TV**, and name the profile **`MediaLoader`** (the name `build-tv.ps1` expects; use `-CertProfile` for another).
3. Create a new **author certificate**. You'll sign in with your Samsung account in the browser.
4. Create the **distributor certificate** with privilege **Public**. Check that your TV's **DUID** is in the device list (it's filled in automatically while the TV is connected). Without it, installs fail with a certificate error.

Back up `C:\tizen-studio-data\keystore\` and your certificate folder. If you lose them, you'll need a new certificate and a reinstall (which clears the app's saved settings).

**5. Fill in `.env`** as described in [Configuration](#configuration), with IP addresses rather than `.local` names.

### Install or update

From the project folder, in PowerShell:

```powershell
.\build-tv.ps1 -TvIp <tv-ip>
```

The script:
1. copies only the app files (`config.xml`, `index.html`, `icon.png`, `css/`, `js/`) into `.buildResult\`;
2. writes your `.env` addresses and keys into that copy's `js\config.js` (the source file stays key-free);
3. signs and packages it as `.buildResult\Reelhouse.wgt`;
4. connects to the TV, installs the package and starts it.

Reelhouse then appears at the end of the TV's **Apps** list. Run the same command again to update; your settings and saved rows are kept.

| Option | Use |
|---|---|
| `-NoInstall` | Only build `.buildResult\Reelhouse.wgt` |
| `-CertProfile <name>` | Certificate profile other than `MediaLoader` |
| `-TizenHome <path>` | Tizen Studio installed somewhere other than `C:\tizen-studio` |

If PowerShell refuses to run the script, allow local scripts once: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

**From a GitHub release:** each release has two downloads.

- `reelhouse-vX.Y.Z.wgt` is signed with the repository owner's Samsung certificate, so it only installs on the TVs listed in that certificate. Install it with `tizen.bat install -n reelhouse-vX.Y.Z.wgt -s <tv-ip>:26101 -- <folder>`. It contains no server addresses or keys, so enter them on the TV in **Settings**.
- The zip holds the app files. For your own TV, unzip it over a copy of this repository (or anywhere with `build-tv.ps1` and your `.env` next to it) and run the script as above, which signs with your certificate.

To sign releases of your own fork, add four repository secrets (Settings › Secrets and variables › Actions): `TIZEN_AUTHOR_P12` and `TIZEN_DISTRIBUTOR_P12` (your `author.p12` / `distributor.p12`, base64-encoded) and `TIZEN_AUTHOR_PASSWORD` / `TIZEN_DISTRIBUTOR_PASSWORD`. The **TV package** workflow can also be run by hand from the Actions tab; the `.wgt` is then kept as a build artifact for 14 days.

### Doing it by hand

The equivalent commands, useful when a step fails:

```powershell
C:\tizen-studio\tools\ide\bin\tizen.bat package -t wgt -s MediaLoader -- .buildResult
C:\tizen-studio\tools\sdb.exe connect <tv-ip>
C:\tizen-studio\tools\ide\bin\tizen.bat install -n Reelhouse.wgt -s <tv-ip>:26101 -- .buildResult
C:\tizen-studio\tools\ide\bin\tizen.bat run -p MdLoader01.MediaLoader -s <tv-ip>:26101
```

To remove the app: `tizen.bat uninstall -p MdLoader01.MediaLoader -s <tv-ip>:26101`.

### Debugging on the TV

```powershell
C:\tizen-studio\tools\sdb.exe -s <tv-ip>:26101 shell 0 debug MdLoader01.MediaLoader   # prints "port: NNNNN"
C:\tizen-studio\tools\sdb.exe -s <tv-ip>:26101 forward tcp:9333 tcp:NNNNN
```

Then open `http://127.0.0.1:9333/json` and open the listed `devtoolsFrontendUrl` in Chrome for the console, network log and element inspector of the running app.

### Troubleshooting

| Problem | Fix |
|---|---|
| `sdb connect` times out | The Host PC IP in Developer Mode must match this PC exactly; hold the power button to restart the TV; allow `sdb.exe` through the firewall. |
| "Tizen CLI not found" | Pass `-TizenHome <install folder>`. |
| Packaging fails | The certificate profile name doesn't match: pass `-CertProfile <name>`. |
| Install fails with a signature or certificate error | The TV's DUID isn't in the distributor certificate. Reconnect the TV and create the distributor certificate again. |
| Installs stopped working after a TV update | Firmware updates can switch Developer Mode off. Turn it on again (step 2). |
| "Can't reach Sonarr" (or Radarr, Lidarr) | Use IP addresses in `.env` instead of `.local` names, then run the script again. |
| Movies / Music rows are empty on the TV | The TV is blocking the public feeds (CORS). Point the feed URLs at a proxy such as the Docker container's `/feeds/` routes. |

## Files

| Path | What it is |
|---|---|
| `config.xml` | Tizen app manifest: app id, privileges, version |
| `index.html` | All markup: side menu, browse screen, pop-ups, player |
| `css/style.css` | All styles, laid out for 1920×1080 |
| `js/` | The app: navigation, *arr and Plex clients, feeds, people, seasons, player, sounds, screens |
| `tests/` | Unit tests and the mock media world |
| `docker/`, `Dockerfile`, `docker-compose.yml` | Local test server with feed proxies |
| `build-tv.ps1` | Sign, package and install on a TV |
| `tools/` | Icon generator |
| `AGENTS.md` | Detailed developer notes: architecture, constraints, how each feature works |
