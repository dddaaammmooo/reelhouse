/*
 * Plex: "Play In Plex" starts the title in the Plex app on the TV.
 *
 * How (all through the Plex server, which relays player commands to the TV's Plex app):
 *   1. Find the title on the server: /hubs/search, matched by tmdb:// / tvdb:// / imdb:// Guid, else title + year.
 *      TV shows play the On Deck episode (else the first unwatched one); music plays the artist.
 *   2. Open the Plex app (tizen.application.launch).
 *   3. Create a play queue *as the TV's player* (X-Plex-Client-Identifier = the player's id); a queue owned
 *      by anyone else fails on the TV with "error loading items into the play queue".
 *   4. Send /player/playback/playMedia with X-Plex-Target-Client-Identifier, pointing the player at the
 *      server's secure plex.direct address (Plex apps reject plain http addresses), retrying while the app loads.
 *
 * Needs MEDIALOADER_PLEX = { url, token } (token: the Plex Home admin / server owner, PLEX_TOKEN in .env).
 * Without a token, Play just opens the Plex app.
 */
var Plex = (function () {
    'use strict';

    const cfg = () => (typeof MEDIALOADER_PLEX !== 'undefined' && MEDIALOADER_PLEX) || {};
    const APP_ID = (typeof MEDIALOADER_PLEX_APP !== 'undefined' && MEDIALOADER_PLEX_APP) || 'kIciSQlYEM.plex';
    const CONTROLLER_ID = 'medialoader-tizen';
    const base = () => String(cfg().url || '').replace(/\/+$/, '');
    const configured = () => !!(cfg().url && cfg().token);
    const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    let commandId = 0;

    function request(method, url, headers, timeout) {
        return new Promise((resolve, reject) => {
            const x = new XMLHttpRequest();
            x.open(method, url, true);
            x.timeout = timeout || 20000;
            const h = Object.assign({
                'Accept': 'application/json',
                'X-Plex-Token': cfg().token,
                'X-Plex-Client-Identifier': CONTROLLER_ID,
                'X-Plex-Product': 'Reelhouse',
                'X-Plex-Device-Name': 'Reelhouse',
                'X-Plex-Platform': 'Tizen'
            }, headers || {});
            Object.keys(h).forEach(k => { if (h[k] !== undefined) { x.setRequestHeader(k, h[k]); } });
            x.onload = () => {
                if (x.status < 200 || x.status >= 300) { reject(new Error('Plex HTTP ' + x.status)); return; }
                let data = null;
                try { data = JSON.parse(x.responseText); } catch (e) { data = { text: x.responseText || '' }; }
                resolve(data);
            };
            x.onerror = () => reject(new Error('Can’t reach Plex'));
            x.ontimeout = () => reject(new Error('Plex timed out'));
            x.send();
        });
    }
    const plex = (method, path, headers, timeout) => request(method, base() + path, headers, timeout);

    // Player replies come back as <Response code="200" …/> (or JSON); anything but 200 is a refusal.
    const playerOk = d => !d.text || /code="200"/.test(d.text);

    /* ---- server identity + the secure address the TV's Plex app expects ---- */
    let serverPromise = null;
    function server() {
        if (!serverPromise) {
            serverPromise = plex('GET', '/identity').then(d => {
                const id = d.MediaContainer.machineIdentifier;
                const u = base().match(/^(https?):\/\/([^:/]+)(?::(\d+))?/) || [];
                const fallback = { id, protocol: u[1] || 'http', address: u[2], port: u[3] || '32400' };
                return request('GET', 'https://plex.tv/api/v2/resources?includeHttps=1', null, 15000).then(list => {
                    const res = (list || []).filter(r => r.clientIdentifier === id)[0];
                    const conn = res && (res.connections || []).filter(c => c.local && !c.relay && c.protocol === 'https')[0];
                    if (!conn) { return fallback; }
                    const m = conn.uri.match(/^https:\/\/([^:/]+):(\d+)/);
                    return m ? { id, protocol: 'https', address: m[1], port: m[2] } : fallback;
                }, () => fallback);
            });
            serverPromise.catch(() => { serverPromise = null; });
        }
        return serverPromise;
    }

    /* ---- find the title on the server ---- */
    function findItem(kind, real) {
        const type = kind === 'movie' ? 'movie' : kind === 'tv' ? 'show' : 'artist';
        const title = kind === 'music' ? (real.artistName || real.title) : real.title;
        const guids = [];
        if (real.tmdbId) { guids.push('tmdb://' + real.tmdbId); }
        if (real.tvdbId) { guids.push('tvdb://' + real.tvdbId); }
        if (real.imdbId) { guids.push('imdb://' + real.imdbId); }
        return plex('GET', '/hubs/search?query=' + encodeURIComponent(title) + '&limit=30&includeGuids=1').then(d => {
            const all = [];
            ((d.MediaContainer && d.MediaContainer.Hub) || []).forEach(h => (h.Metadata || []).forEach(m => { if (m.type === type) { all.push(m); } }));
            const byGuid = all.filter(m => (m.Guid || []).some(g => guids.indexOf(g.id) !== -1))[0];
            if (byGuid) { return byGuid; }
            return all.filter(m => norm(m.title) === norm(title) && (!real.year || !m.year || Math.abs(m.year - real.year) <= 1))[0] || null;
        });
    }

    // What to actually play: a movie as-is (resuming), a show's next episode, an artist's tracks.
    function target(kind, item) {
        if (kind === 'movie') { return Promise.resolve({ key: item.key, offset: item.viewOffset || 0, type: 'video', label: item.title }); }
        if (kind === 'music') { return Promise.resolve({ key: item.key, offset: 0, type: 'music', label: item.title }); }
        return plex('GET', '/library/metadata/' + item.ratingKey + '?includeOnDeck=1').then(d => {
            const show = (d.MediaContainer.Metadata || [])[0] || {};
            const deck = show.OnDeck && show.OnDeck.Metadata && show.OnDeck.Metadata[0];
            if (deck) { return deck; }
            // Not On Deck (Plex drops shows after a while): the unfinished episode, else the one after the last
            // episode watched (in order), else the first.
            return plex('GET', '/library/metadata/' + item.ratingKey + '/allLeaves').then(l => {
                const eps = (l.MediaContainer.Metadata || []).filter(e => e.parentIndex > 0);
                const unfinished = eps.filter(e => e.viewOffset && !e.viewCount)[0];
                if (unfinished) { return unfinished; }
                let last = -1;
                eps.forEach((e, i) => { if (e.viewCount) { last = i; } });
                return eps[last + 1] || eps[0];
            });
        }).then(ep => {
            if (!ep) { throw new Error('No episodes of this show are in Plex yet'); }
            return { key: ep.key, ratingKey: ep.ratingKey, offset: ep.viewOffset || 0, type: 'video', season: ep.parentIndex, episode: ep.index,
                resume: !!(ep.viewOffset && !ep.viewCount), label: item.title + ' · S' + ep.parentIndex + 'E' + ep.index };
        });
    }

    /* ---- the TV's Plex app as a player ---- */
    function findClient() {
        return plex('GET', '/clients').then(d => {
            const list = (d.MediaContainer && d.MediaContainer.Server) || [];
            const wanted = norm(cfg().client);
            return list.filter(c => wanted ? norm(c.name) === wanted : /samsung/i.test(c.product || '') || /tizen/i.test(c.platform || ''))[0] || null;
        });
    }

    /* Wait until the Plex app is at its menu and accepting commands. The server's /resources lists the
       player only while the app is running and connected: an empty list while Plex is closed or still
       loading (measured: ~11.6 s from a cold start), the player as soon as it's ready. Polled every 0.5 s. */
    function waitForPlayer() {
        const wanted = norm(cfg().client);
        const started = Date.now();
        const poll = () => plex('GET', '/resources', null, 2500).then(d => {
            const players = (d.MediaContainer && d.MediaContainer.Player) || [];
            return players.filter(p => wanted ? norm(p.title) === wanted : /samsung/i.test(p.product || '') || /tizen/i.test(p.platform || ''))[0] || null;
        }, () => null).then(p => {
            if (p) { return p; }
            if (Date.now() - started > 45000) { return findClient(); }   // fall back to the server's last-known player
            return sleep(500).then(poll);
        });
        return poll();
    }

    function launchApp() {
        return new Promise(resolve => {
            try { tizen.application.launch(APP_ID, () => resolve(true), () => resolve(false)); }
            catch (e) { resolve(false); }
        });
    }

    /* Start the title. Resolves { played, label } or rejects with a readable error. */
    function play(kind, real) {
        if (!configured()) { return launchApp().then(() => ({ played: false, reason: 'Plex isn’t set up in Reelhouse, so Plex just opens' })); }
        return Promise.all([server(), findItem(kind, real)]).then(res => {
            const srv = res[0], item = res[1];
            if (!item) { return launchApp().then(() => ({ played: false, reason: 'This title isn’t in your Plex library yet' })); }
            return target(kind, item).then(t => launchApp().then(() => waitForPlayer()).then(client => {
                if (!client) { throw new Error('Plex on the TV didn’t finish starting'); }
                const queueType = t.type === 'music' ? 'audio' : 'video';
                const uri = 'server://' + srv.id + '/com.plexapp.plugins.library' + t.key;
                return plex('POST', '/playQueues?type=' + queueType + '&uri=' + encodeURIComponent(uri) +
                    '&shuffle=0&repeat=0&continuous=' + (kind === 'tv' ? 1 : 0) + '&own=1',
                    { 'X-Plex-Client-Identifier': client.machineIdentifier }).then(q => {
                    const qid = q.MediaContainer.playQueueID;
                    const params = 'providerIdentifier=com.plexapp.plugins.library' +
                        '&containerKey=' + encodeURIComponent('/playQueues/' + qid + '?own=1') +
                        '&key=' + encodeURIComponent(t.key) + '&offset=' + t.offset +
                        '&machineIdentifier=' + srv.id + '&protocol=' + srv.protocol + '&address=' + srv.address + '&port=' + srv.port +
                        '&type=' + t.type + '&token=' + encodeURIComponent(cfg().token);
                    // Ground truth is the server's "now playing" list: once the TV shows up there with
                    // this title, stop. Only one play request is ever in flight, and a new one is sent
                    // only after the last was refused or went unanswered while nothing is playing.
                    // This covers both cases:
                    //   - Plex already open: the first request is accepted within a second or two;
                    //   - Plex starting cold (can take 10-30 s): early requests are refused or unanswered,
                    //     and are retried until the app is ready, without ever playing twice (a second
                    //     delivered play restarts the movie).
                    const started = Date.now(), LIMIT = 75000;
                    let done = false;
                    const isPlaying = () => plex('GET', '/status/sessions', null, 6000).then(d => ((d.MediaContainer && d.MediaContainer.Metadata) || [])
                        .some(m => m.Player && m.Player.machineIdentifier === client.machineIdentifier &&
                            [m.key, m.parentKey, m.grandparentKey].indexOf(t.key) !== -1), () => false);
                    const watch = () => (done || Date.now() - started > LIMIT) ? null
                        : isPlaying().then(p => { if (p) { done = true; return null; } return sleep(2000).then(watch); });
                    const send = () => {
                        if (done) { return Promise.resolve(); }
                        if (Date.now() - started > LIMIT) { throw new Error('Plex didn’t start playback in time'); }
                        return plex('GET', '/player/playback/playMedia?' + params + '&commandID=' + (++commandId),
                            { 'X-Plex-Target-Client-Identifier': client.machineIdentifier }, 30000)
                            .then(r => (playerOk(r) ? 'accepted' : 'refused'), () => 'unanswered')
                            .then(res => {
                                if (res === 'accepted' || done) { done = true; return; }
                                // Refused or unanswered: make sure it isn't already playing before trying again.
                                return isPlaying().then(p => { if (p) { done = true; return; } return sleep(3000).then(send); });
                            });
                    };
                    // waitForPlayer() already confirmed the app is ready, so send straight away.
                    return Promise.all([send(), watch()]).then(() => ({ played: true, label: t.label }));
                });
            }));
        });
    }

    /* A trailer Plex can stream for this movie (Plex's trailer extras), as a direct MP4 URL, or null.
       The extra's URL redirects to Plex's video host; asking for bitrate=5000 gets the best version. */
    function trailer(kind, real) {
        if (!configured() || kind !== 'movie') { return Promise.resolve(null); }
        return findItem(kind, real).then(item => {
            if (!item) { return null; }
            return plex('GET', '/library/metadata/' + item.ratingKey + '?includeExtras=1').then(d => {
                const m = ((d.MediaContainer && d.MediaContainer.Metadata) || [])[0] || {};
                const t = ((m.Extras && m.Extras.Metadata) || []).filter(e => e.subtype === 'trailer')[0];
                const part = t && t.Media && t.Media[0] && t.Media[0].Part && t.Media[0].Part[0];
                if (!part || !part.key) { return null; }
                const key = part.key.replace(/bitrate=\d+/, 'bitrate=5000');
                return base() + key + (key.indexOf('?') === -1 ? '?' : '&') + 'X-Plex-Token=' + encodeURIComponent(cfg().token);
            });
        }).catch(() => null);
    }

    /* ---- recently played, for the "Recently played" row at the top of TV Shows / Movies / Music ---- */
    let sectionsP = null;
    function sections() {
        if (!sectionsP) {
            sectionsP = plex('GET', '/library/sections').then(d => (d.MediaContainer && d.MediaContainer.Directory) || []);
            sectionsP.catch(() => { sectionsP = null; });
        }
        return sectionsP;
    }
    // Titles watched most recently (any of the kind's libraries, except home videos / music videos), newest first.
    function recentlyPlayed(kind) {
        if (!configured()) { return Promise.resolve([]); }
        const type = kind === 'movie' ? 'movie' : kind === 'tv' ? 'show' : 'artist';
        const num = kind === 'movie' ? 1 : kind === 'tv' ? 2 : 8;
        return sections().then(list => Promise.all(list.filter(s => s.type === type && !/home videos|music videos/i.test(s.title)).map(s =>
            plex('GET', '/library/sections/' + s.key + '/all?type=' + num + '&sort=lastViewedAt:desc&viewCount%3E%3E=1&includeGuids=1&X-Plex-Container-Start=0&X-Plex-Container-Size=20')
                .then(d => (d.MediaContainer && d.MediaContainer.Metadata) || [], () => []))))
            .then(parts => [].concat.apply([], parts).filter(m => m.lastViewedAt && !/^various( artists)?$/i.test(m.title))
                .sort((a, b) => b.lastViewedAt - a.lastViewedAt).slice(0, 20))
            .catch(() => []);
    }
    // A Plex image (poster / background) resized by the server.
    const photo = (path, w, h) => (path ? base() + '/photo/:/transcode?width=' + w + '&height=' + h + '&minSize=1&upscale=1&url=' + encodeURIComponent(path) + '&X-Plex-Token=' + encodeURIComponent(token()) : '');

    // For MediaLoader's own player (js/player.js).
    const token = () => cfg().token || '';
    return { configured, play, launchApp, findItem, server, trailer, target, api: plex, base, token, recentlyPlayed, photo };
}());
