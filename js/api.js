/*
 * Client for Sonarr (v3 API), Radarr (v3 API) and Lidarr (v1 API).
 * Each service knows how to search, build an "add" payload, trigger a search for something already
 * in the library, and turn its download queue into one common shape.
 */
var Api = (function () {
    'use strict';

    const SETTINGS_KEY = 'medialoader.settings';
    const KINDS = ['tv', 'movie', 'music'];

    /* ---------- settings ---------- */

    function loadSettings() {
        const s = JSON.parse(JSON.stringify(MEDIALOADER_DEFAULTS));
        try {
            const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
            KINDS.forEach(k => {
                if (saved[k] && saved[k].url) { s[k].url = saved[k].url; }
                if (saved[k] && saved[k].apiKey) { s[k].apiKey = saved[k].apiKey; }
                if (saved[k] && typeof saved[k].qualityProfile === 'string') { s[k].qualityProfile = saved[k].qualityProfile; }
            });
        } catch (e) { /* ignore corrupt storage */ }
        return s;
    }

    let settings = loadSettings();
    let contexts = {};
    let artistIndex = null;   // Lidarr's (small) artist list, fetched once for library checks

    /* ---------- HTTP ---------- */

    function errorFrom(status, data) {
        if (status === 401) { return 'Invalid API key'; }
        if (data && data.length && data[0].errorMessage) { return data[0].errorMessage; }
        if (data && data.message) { return data.message; }
        return 'Server error (' + status + ')';
    }

    const baseUrl = kind => settings[kind].url.replace(/\/+$/, '');

    function request(kind, method, path, body) {
        const cfg = settings[kind];
        const svc = SERVICES[kind];
        return new Promise((resolve, reject) => {
            if (!cfg.apiKey) { reject(new Error(svc.app + ' API key not set')); return; }
            const x = new XMLHttpRequest();
            x.open(method, baseUrl(kind) + svc.base + path, true);
            x.setRequestHeader('X-Api-Key', cfg.apiKey);
            x.setRequestHeader('Accept', 'application/json');
            if (body) { x.setRequestHeader('Content-Type', 'application/json'); }
            x.timeout = 30000;
            x.onload = () => {
                let data = null;
                try { data = JSON.parse(x.responseText); } catch (e) { /* non-JSON */ }
                if (x.status >= 200 && x.status < 300) { resolve(data); }
                else { const err = new Error(errorFrom(x.status, data)); err.status = x.status; reject(err); }
            };
            x.onerror = () => reject(new Error("Can't reach " + svc.app));
            x.ontimeout = () => reject(new Error(svc.app + ' timed out'));
            x.send(body ? JSON.stringify(body) : null);
        });
    }

    const get = (kind, path) => request(kind, 'GET', path);
    const post = (kind, path, body) => request(kind, 'POST', path, body);
    const clone = o => JSON.parse(JSON.stringify(o));

    /* ---------- helpers ---------- */

    // Prefer the public remote URL; fall back to the server's cached copy (needs the API key).
    function image(kind, item, types) {
        const imgs = (item && item.images) || [];
        for (let t = 0; t < types.length; t++) {
            for (let i = 0; i < imgs.length; i++) {
                if (imgs[i].coverType !== types[t]) { continue; }
                if (imgs[i].remoteUrl) { return imgs[i].remoteUrl; }
                if (imgs[i].url) {
                    const u = imgs[i].url;
                    if (/^https?:/.test(u)) { return u; }
                    return baseUrl(kind) + u + (u.indexOf('?') === -1 ? '?' : '&') + 'apikey=' + encodeURIComponent(settings[kind].apiKey);
                }
            }
        }
        return (item && item.remotePoster) || '';
    }

    const firstId = list => (list && list.length ? list[0].id : undefined);
    // Quality profile chosen by name in config (e.g. 'HD-1080p'); falls back to the first profile.
    function profileId(list, name) {
        const wanted = String(name || '').trim().toLowerCase();
        const match = wanted && (list || []).filter(p => String(p.name).toLowerCase() === wanted)[0];
        return match ? match.id : firstId(list);
    }
    const pad2 = n => (n < 10 ? '0' : '') + n;

    /* ---------- per-service definitions ---------- */

    const SERVICES = {
        tv: {
            app: 'Sonarr', label: 'TV Shows', noun: 'TV show', base: '/api/v3',
            lookup: '/series/lookup', add: '/series',
            queuePath: '/queue?page=1&pageSize=200&includeSeries=true&includeEpisode=true',
            loadContext: () => Promise.all([
                get('tv', '/rootfolder'),
                get('tv', '/qualityprofile'),
                // Sonarr v3 needs a language profile; v4 removed the endpoint, so a failure is fine.
                get('tv', '/languageprofile').catch(() => [])
            ]).then(r => ({ rootFolderPath: r[0][0] && r[0][0].path, qualityProfileId: profileId(r[1], settings.tv.qualityProfile), languageProfileId: firstId(r[2]) })),
            view: it => {
                const seasons = (it.seasons || []).filter(s => s.seasonNumber > 0).length;
                return {
                    title: it.title,
                    meta: [it.year, it.network, seasons ? seasons + (seasons === 1 ? ' season' : ' seasons') : ''].filter(Boolean),
                    poster: image('tv', it, ['poster']),
                    backdrop: image('tv', it, ['fanart', 'banner', 'poster']),
                    overview: it.overview
                };
            },
            buildAdd: (it, ctx) => {
                const o = clone(it);
                o.qualityProfileId = ctx.qualityProfileId;
                if (ctx.languageProfileId) { o.languageProfileId = ctx.languageProfileId; }
                o.rootFolderPath = ctx.rootFolderPath;
                o.monitored = true;
                o.seasonFolder = true;
                (o.seasons || []).forEach(s => { s.monitored = s.seasonNumber > 0; });
                o.addOptions = { monitor: 'all', searchForMissingEpisodes: true, searchForCutoffUnmetEpisodes: false,
                    ignoreEpisodesWithFiles: false, ignoreEpisodesWithoutFiles: false };
                return o;
            },
            searchCommand: id => ({ name: 'SeriesSearch', seriesId: id }),
            queueMedia: r => {
                const ep = r.episode;
                return {
                    mediaId: r.seriesId,
                    title: (r.series && r.series.title) || r.title,
                    sub: ep ? 'S' + pad2(ep.seasonNumber) + 'E' + pad2(ep.episodeNumber) + (ep.title ? ' · ' + ep.title : '') : r.title,
                    poster: image('tv', r.series, ['poster']),
                    // The episode's own synopsis if there is one, otherwise the show's
                    overview: (ep && ep.overview) || (r.series && r.series.overview) || ''
                };
            }
        },

        movie: {
            app: 'Radarr', label: 'Movies', noun: 'movie', base: '/api/v3',
            lookup: '/movie/lookup', add: '/movie',
            queuePath: '/queue?page=1&pageSize=200&includeMovie=true',
            loadContext: () => Promise.all([get('movie', '/rootfolder'), get('movie', '/qualityprofile')])
                .then(r => ({ rootFolderPath: r[0][0] && r[0][0].path, qualityProfileId: profileId(r[1], settings.movie.qualityProfile) })),
            view: it => ({
                title: it.title,
                meta: [it.year, it.runtime ? Math.floor(it.runtime / 60) + 'h ' + (it.runtime % 60) + 'm' : '', it.studio].filter(Boolean),
                poster: image('movie', it, ['poster']),
                backdrop: image('movie', it, ['fanart', 'poster']),
                overview: it.overview
            }),
            buildAdd: (it, ctx) => {
                const o = clone(it);
                o.qualityProfileId = ctx.qualityProfileId;
                o.rootFolderPath = ctx.rootFolderPath;
                o.monitored = true;
                o.minimumAvailability = o.minimumAvailability || 'released';
                o.addOptions = { searchForMovie: true, monitor: 'movieOnly' };
                return o;
            },
            searchCommand: id => ({ name: 'MoviesSearch', movieIds: [id] }),
            queueMedia: r => ({
                mediaId: r.movieId,
                title: (r.movie && r.movie.title) || r.title,
                sub: r.movie && r.movie.year ? String(r.movie.year) : r.title,
                poster: image('movie', r.movie, ['poster']),
                overview: (r.movie && r.movie.overview) || ''
            })
        },

        music: {
            app: 'Lidarr', label: 'Music', noun: 'artist', base: '/api/v1',
            lookup: '/artist/lookup', add: '/artist',
            queuePath: '/queue?page=1&pageSize=200&includeArtist=true&includeAlbum=true',
            loadContext: () => Promise.all([get('music', '/rootfolder'), get('music', '/qualityprofile'), get('music', '/metadataprofile')])
                .then(r => {
                    const root = r[0][0] || {};
                    return {
                        rootFolderPath: root.path,
                        qualityProfileId: settings.music.qualityProfile ? profileId(r[1], settings.music.qualityProfile) : (root.defaultQualityProfileId || firstId(r[1])),
                        metadataProfileId: root.defaultMetadataProfileId || firstId(r[2])
                    };
                }),
            view: it => ({
                title: it.artistName,
                meta: [it.disambiguation, it.artistType, it.genres && it.genres.length ? it.genres.slice(0, 2).join(', ') : ''].filter(Boolean),
                poster: image('music', it, ['poster', 'cover', 'fanart']),
                backdrop: image('music', it, ['fanart', 'banner', 'poster']),
                overview: it.overview
            }),
            buildAdd: (it, ctx, opts) => {
                const o = clone(it);
                o.qualityProfileId = ctx.qualityProfileId;
                o.metadataProfileId = ctx.metadataProfileId;
                o.rootFolderPath = ctx.rootFolderPath;
                o.monitored = true;
                o.monitorNewItems = 'all';
                // From the "new albums" row we only want the latest album, not the whole discography.
                o.addOptions = { monitor: (opts && opts.monitor) || 'all', searchForMissingAlbums: true };
                return o;
            },
            searchCommand: id => ({ name: 'ArtistSearch', artistId: id }),
            queueMedia: r => ({
                mediaId: r.artistId,
                title: (r.artist && r.artist.artistName) || r.title,
                sub: (r.album && r.album.title) || r.title,
                poster: image('music', r.album, ['cover', 'poster']) || image('music', r.artist, ['poster', 'fanart']),
                overview: (r.album && r.album.overview) || (r.artist && r.artist.overview) || ''
            })
        }
    };

    /* ---------- queue normalisation ---------- */

    // "01:02:03" or "1.02:03:04" -> "1h 2m left"
    function eta(timeleft) {
        if (!timeleft) { return ''; }
        const m = /^(?:(\d+)\.)?(\d+):(\d+):(\d+)/.exec(timeleft);
        if (!m) { return ''; }
        const d = +(m[1] || 0), h = +m[2], min = +m[3], s = +m[4];
        if (d) { return d + 'd ' + h + 'h left'; }
        if (h) { return h + 'h ' + min + 'm left'; }
        if (min) { return min + 'm left'; }
        return s + 's left';
    }

    function bytes(n) {
        if (!n || n < 1) { return '0 B'; }
        const u = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
        return (n / Math.pow(1024, i)).toFixed(i >= 3 ? 1 : 0) + ' ' + u[i];
    }

    function normalise(kind, r) {
        const media = SERVICES[kind].queueMedia(r);
        const size = r.size || 0, left = r.sizeleft || 0;
        const progress = size ? Math.max(0, Math.min(1, (size - left) / size)) : 0;
        const tState = (r.trackedDownloadState || '').toLowerCase();
        const tStatus = (r.trackedDownloadStatus || '').toLowerCase();
        const status = (r.status || '').toLowerCase();

        let messages = [];
        (r.statusMessages || []).forEach(m => { messages = messages.concat(m.messages || []); });
        if (r.errorMessage) { messages.unshift(r.errorMessage); }

        let state, label;
        if (tState === 'failed' || tState === 'failedpending' || status === 'failed') { state = 'failed'; label = 'Failed'; }
        else if (tStatus === 'warning' || tStatus === 'error') { state = 'attention'; label = 'Needs attention'; }
        else if (tState === 'importpending' || tState === 'importing' || status === 'completed') { state = 'importing'; label = 'Importing'; }
        else if (status === 'paused') { state = 'queued'; label = 'Paused'; }
        else if (status === 'queued' || status === 'delay' || status === 'downloadclientunavailable' || (status !== 'downloading' && progress === 0)) { state = 'queued'; label = 'Waiting'; }
        else { state = 'downloading'; label = 'Downloading'; }

        const quality = r.quality && r.quality.quality ? r.quality.quality.name : '';
        return {
            key: kind + ':' + r.id,
            kind, id: r.id, mediaId: media.mediaId,
            title: media.title, sub: media.sub, poster: media.poster,
            overview: media.overview || '',
            app: SERVICES[kind].app,
            progress, size, sizeLeft: left,
            sizeText: bytes(size - left) + ' of ' + bytes(size),
            sizeTotal: bytes(size),
            eta: eta(r.timeleft),
            state, label,
            message: messages[0] || '',
            messages,
            // Details for the download panel
            release: r.title || '',
            quality,
            languages: (r.languages || []).map(l => l.name).filter(Boolean).join(', '),
            protocol: r.protocol === 'usenet' ? 'Usenet' : r.protocol === 'torrent' ? 'Torrent' : (r.protocol || ''),
            client: r.downloadClient || '',
            indexer: r.indexer || '',
            outputPath: r.outputPath || '',
            added: r.added || ''
        };
    }

    const STATE_ORDER = { failed: 0, attention: 1, downloading: 2, importing: 3, queued: 4 };

    /* ---------- add context (root folder / profiles), cached ---------- */

    function context(kind) {
        if (!contexts[kind]) {
            contexts[kind] = SERVICES[kind].loadContext().then(ctx => {
                if (!ctx.rootFolderPath) { throw new Error('No root folder set up in ' + SERVICES[kind].app); }
                if (!ctx.qualityProfileId) { throw new Error('No quality profile found in ' + SERVICES[kind].app); }
                return ctx;
            });
            contexts[kind].catch(() => { delete contexts[kind]; });
        }
        return contexts[kind];
    }

    return {
        KINDS,
        services: SERVICES,
        settings: () => settings,
        configured: kind => !!settings[kind].apiKey,
        saveSettings: s => {
            try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
            // Re-merge over the defaults so settings the form doesn't edit (quality profiles) survive.
            settings = loadSettings();
            KINDS.forEach(k => {
                if (!s[k]) { return; }
                if (s[k].url) { settings[k].url = s[k].url; }
                if (s[k].apiKey) { settings[k].apiKey = s[k].apiKey; }
                if (typeof s[k].qualityProfile === 'string') { settings[k].qualityProfile = s[k].qualityProfile; }
            });
            contexts = {};
        },
        resetSettings: () => {
            try { localStorage.removeItem(SETTINGS_KEY); } catch (e) { /* ignore */ }
            settings = loadSettings(); contexts = {};
        },

        search: (kind, term) => get(kind, SERVICES[kind].lookup + '?term=' + encodeURIComponent(term)),

        /* Add to the library and start searching. Resolves with the saved item. */
        add: (kind, item, opts) => context(kind).then(ctx => post(kind, SERVICES[kind].add, SERVICES[kind].buildAdd(item, ctx, opts))),

        /* Exact lookups used by the "new releases" rows. Each resolves to one lookup item. */
        // Radarr's TMDb lookup doesn't say whether the movie is already in the library (no id), so check
        // the library first (/movie?tmdbId=) and only fall back to the lookup for movies you don't have.
        lookupMovie: tmdbId => get('movie', '/movie?tmdbId=' + encodeURIComponent(tmdbId)).then(owned => {
            if (owned && owned.length) { return owned[0]; }
            return get('movie', '/movie/lookup/tmdb?tmdbId=' + encodeURIComponent(tmdbId)).then(r => {
                const m = Array.isArray(r) ? r[0] : r;
                if (!m) { throw new Error('Radarr couldn’t find this movie'); }
                return m;
            });
        }),
        lookupSeries: tvdbId => get('tv', '/series/lookup?term=' + encodeURIComponent('tvdb:' + tvdbId)).then(r => {
            if (!r || !r.length) { throw new Error('Sonarr couldn’t find this show'); }
            return r[0];
        }),
        // Chart entries (iTunes) only have a name, so match on title (and year for movies).
        lookupMovieByTitle: (title, year) => get('movie', '/movie/lookup?term=' + encodeURIComponent(title + (year ? ' ' + year : ''))).then(r => {
            if (!r || !r.length) { throw new Error('Radarr couldn’t find ' + title); }
            return r.filter(m => String(m.year) === String(year))[0] || r[0];
        }),
        lookupSeriesByTitle: title => get('tv', '/series/lookup?term=' + encodeURIComponent(title)).then(r => {
            if (!r || !r.length) { throw new Error('Sonarr couldn’t find ' + title); }
            const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            return r.filter(a => norm(a.title) === norm(title))[0] || r[0];
        }),
        lookupArtist: name => get('music', '/artist/lookup?term=' + encodeURIComponent(name)).then(r => {
            if (!r || !r.length) { throw new Error('Lidarr couldn’t find ' + name); }
            const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            return r.filter(a => norm(a.artistName) === norm(name))[0] || r[0];
        }),

        /* Cancel a download: remove it from the queue and the download client.
           blocklist=true also stops this release being grabbed again (the app then looks for another). */
        removeQueue: (kind, id, blocklist) => request(kind, 'DELETE',
            '/queue/' + id + '?removeFromClient=true&blocklist=' + (blocklist ? 'true' : 'false') + '&skipRedownload=' + (blocklist ? 'false' : 'true')),

        /* Already in the library: search for anything missing. */
        searchExisting: (kind, id) => post(kind, '/command', SERVICES[kind].searchCommand(id)),

        /* ---- TV seasons and episodes (Sonarr) ---- */
        series: id => get('tv', '/series/' + id),
        seriesEpisodes: (seriesId, season) => get('tv', '/episode?seriesId=' + seriesId + (season != null ? '&seasonNumber=' + season : '')),

        // Download a whole season (episodeNumbers = null) or some of its episodes. A show that isn't in Sonarr
        // yet is added first with nothing monitored, so only what was asked for gets downloaded.
        downloadEpisodes: (real, season, episodeNumbers) => {
            const ensure = real.id > 0 ? Promise.resolve(real.id) : context('tv').then(ctx => {
                const o = SERVICES.tv.buildAdd(real, ctx);
                (o.seasons || []).forEach(x => { x.monitored = false; });
                o.addOptions = { monitor: 'none', searchForMissingEpisodes: false, searchForCutoffUnmetEpisodes: false };
                return post('tv', '/series', o);
            }).then(saved => {
                real.id = saved.id;
                // Sonarr lists a new show's episodes a few seconds after adding it.
                const wait = tries => get('tv', '/episode?seriesId=' + saved.id).then(eps => (eps && eps.length) || tries >= 20
                    ? saved.id : new Promise(r => setTimeout(r, 1500)).then(() => wait(tries + 1)));
                return wait(0);
            });
            return ensure.then(id => Promise.all([get('tv', '/series/' + id), get('tv', '/episode?seriesId=' + id + '&seasonNumber=' + season)]).then(r => {
                const series = r[0], eps = r[1] || [];
                const pick = eps.filter(e => !episodeNumbers || episodeNumbers.indexOf(e.episodeNumber) !== -1);
                if (!pick.length) { throw new Error('Sonarr doesn’t list those episodes yet'); }
                const steps = [request('tv', 'PUT', '/episode/monitor', { episodeIds: pick.map(e => e.id), monitored: true })];
                if (!episodeNumbers) {
                    // Monitor the season too, so episodes that air later are downloaded as well.
                    (series.seasons || []).forEach(x => { if (x.seasonNumber === season) { x.monitored = true; } });
                    steps.push(request('tv', 'PUT', '/series/' + id, series));
                }
                return Promise.all(steps).then(() => post('tv', '/command', episodeNumbers
                    ? { name: 'EpisodeSearch', episodeIds: pick.map(e => e.id) }
                    : { name: 'SeasonSearch', seriesId: id, seasonNumber: season })).then(() => ({ seriesId: id, count: pick.length }));
            }));
        },

        test: kind => get(kind, '/system/status'),

        /* Is this title already in the library? Cheap per-title checks: { id, hasFile } or null.
           src/ref come from the category feeds (tmdb id, tvdb id, artist name, or a chart title). */
        libraryMatch: (src, ref, year) => {
            const norm = x => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            if (src === 'tmdb') {
                return get('movie', '/movie?tmdbId=' + encodeURIComponent(ref)).then(l => (l && l[0] ? { id: l[0].id, hasFile: !!l[0].hasFile } : null));
            }
            if (src === 'tvdb') {
                return get('tv', '/series?tvdbId=' + encodeURIComponent(ref)).then(l => (l && l[0] ? { id: l[0].id, hasFile: ((l[0].statistics || {}).episodeFileCount || 0) > 0 } : null));
            }
            if (src === 'artist') {
                if (!artistIndex) {
                    artistIndex = get('music', '/artist').then(list => {
                        const map = {};
                        (list || []).forEach(a => { map[norm(a.artistName)] = { id: a.id, hasFile: ((a.statistics || {}).trackFileCount || 0) > 0 }; });
                        return map;
                    });
                    artistIndex.catch(() => { artistIndex = null; });
                }
                return artistIndex.then(map => map[norm(ref)] || null);
            }
            if (src === 'movieTitle') {
                return get('movie', '/movie/lookup?term=' + encodeURIComponent(ref + (year ? ' ' + year : ''))).then(r => {
                    const m = (r || []).filter(x => String(x.year) === String(year))[0] || (r || [])[0];
                    return m && m.id > 0 ? { id: m.id, hasFile: !!m.hasFile } : null;
                });
            }
            if (src === 'seriesTitle') {
                return get('tv', '/series/lookup?term=' + encodeURIComponent(ref)).then(r => {
                    const s = (r || []).filter(x => norm(x.title) === norm(ref))[0] || (r || [])[0];
                    return s && s.id > 0 ? { id: s.id, hasFile: ((s.statistics || {}).episodeFileCount || 0) > 0 } : null;
                });
            }
            return Promise.resolve(null);
        },

        /* Downloads page extras. Each returns cards in the queue-item shape, with `item` = the library
           resource (so OK opens the title's details: Play In Plex / Search for missing). */

        // Imported in the last 14 days, newest first; TV grouped per show.
        recent: () => {
            const since = Date.now() - 14 * 86400000;
            const card = (kind, id, title, sub, item, date, overview) => ({
                key: 'recent:' + kind + ':' + id, kind, mediaId: id, title, sub, item, date, overview: overview || '',
                poster: image(kind, item, kind === 'music' ? ['poster', 'cover', 'fanart'] : ['poster']),
                app: SERVICES[kind].app, state: 'recent', label: 'Downloaded', progress: 1, sizeText: '', message: ''
            });
            const tv = !settings.tv.apiKey ? Promise.resolve([]) :
                get('tv', '/history?page=1&pageSize=80&sortKey=date&sortDirection=descending&eventType=3&includeSeries=true&includeEpisode=true').then(d => {
                    const by = {};
                    ((d && d.records) || []).forEach(r => {
                        const t = Date.parse(r.date);
                        if (!r.series || t < since) { return; }
                        const g = by[r.seriesId] || (by[r.seriesId] = { r, t, eps: [] });
                        if (r.episode) { g.eps.push(r.episode); }
                    });
                    return Object.keys(by).map(k => {
                        const g = by[k], ep = g.r.episode;
                        const sub = g.eps.length > 1 ? g.eps.length + ' new episodes' : ep ? 'S' + pad2(ep.seasonNumber) + 'E' + pad2(ep.episodeNumber) + (ep.title ? ' · ' + ep.title : '') : '';
                        return card('tv', g.r.seriesId, g.r.series.title, sub, g.r.series, g.t, (ep && ep.overview) || g.r.series.overview);
                    });
                }).catch(() => []);
            const movie = !settings.movie.apiKey ? Promise.resolve([]) :
                get('movie', '/history?page=1&pageSize=40&sortKey=date&sortDirection=descending&eventType=3&includeMovie=true').then(d => {
                    const seen = {};
                    return ((d && d.records) || []).filter(r => r.movie && Date.parse(r.date) >= since && !seen[r.movieId] && (seen[r.movieId] = true))
                        .map(r => card('movie', r.movieId, r.movie.title, String(r.movie.year || ''), r.movie, Date.parse(r.date), r.movie.overview));
                }).catch(() => []);
            const music = !settings.music.apiKey ? Promise.resolve([]) :
                get('music', '/history?page=1&pageSize=60&sortKey=date&sortDirection=descending&eventType=8&includeArtist=true&includeAlbum=true').then(d => {
                    const seen = {};
                    return ((d && d.records) || []).filter(r => r.artist && Date.parse(r.date) >= since && !seen[r.artistId] && (seen[r.artistId] = true))
                        .map(r => card('music', r.artistId, r.artist.artistName, (r.album && r.album.title) || '', r.artist, Date.parse(r.date), r.artist.overview));
                }).catch(() => []);
            return Promise.all([tv, movie, music]).then(l => l[0].concat(l[1], l[2]).sort((a, b) => b.date - a.date).slice(0, 40));
        },

        // Monitored, released and still missing ("Wanted › Missing"): what the apps are waiting to find.
        wanted: () => {
            const card = (kind, id, title, sub, item, date, overview) => ({
                key: 'pending:' + kind + ':' + id, kind, mediaId: id, title, sub, item, date, overview: overview || '',
                poster: image(kind, item, kind === 'music' ? ['poster', 'cover', 'fanart'] : ['poster']),
                app: SERVICES[kind].app, state: 'pending', label: 'Not downloaded', progress: 0, sizeText: '', message: ''
            });
            const tv = !settings.tv.apiKey ? Promise.resolve([]) :
                get('tv', '/wanted/missing?page=1&pageSize=150&sortKey=episodes.airDateUtc&sortDirection=descending&includeSeries=true&monitored=true').then(d => {
                    const by = {}, order = [];
                    ((d && d.records) || []).forEach(e => {
                        if (!e.series) { return; }
                        if (!by[e.seriesId]) { by[e.seriesId] = { e, n: 0 }; order.push(e.seriesId); }
                        by[e.seriesId].n++;
                    });
                    return order.map(id => {
                        const g = by[id], e = g.e;
                        const sub = g.n > 1 ? g.n + ' episodes missing' : 'S' + pad2(e.seasonNumber) + 'E' + pad2(e.episodeNumber) + ' missing';
                        return card('tv', id, e.series.title, sub, e.series, Date.parse(e.airDateUtc) || 0, e.series.overview);
                    });
                }).catch(() => []);
            const movie = !settings.movie.apiKey ? Promise.resolve([]) :
                get('movie', '/wanted/missing?page=1&pageSize=200&monitored=true').then(d => ((d && d.records) || [])
                    .filter(m => m.isAvailable)                           // released, so a download can exist
                    .sort((a, b) => Date.parse(b.added || 0) - Date.parse(a.added || 0))
                    .map(m => card('movie', m.id, m.title, String(m.year || ''), m, Date.parse(m.added) || 0, m.overview))).catch(() => []);
            const music = !settings.music.apiKey ? Promise.resolve([]) :
                get('music', '/wanted/missing?page=1&pageSize=100&includeArtist=true&monitored=true').then(d => {
                    const seen = {};
                    return ((d && d.records) || []).filter(a => a.artist && !seen[a.artistId] && (seen[a.artistId] = true))
                        .map(a => card('music', a.artistId, a.artist.artistName, a.title + ' missing', a.artist, Date.parse(a.releaseDate) || 0, a.artist.overview));
                }).catch(() => []);
            return Promise.all([tv, movie, music]).then(l => l[0].slice(0, 30).concat(l[1].slice(0, 30), l[2].slice(0, 20)));
        },

        /* Quality profiles for the Settings picker: [{ id, name }] */
        qualityProfiles: kind => get(kind, '/qualityprofile').then(list => (list || []).map(p => ({ id: p.id, name: p.name }))),

        /* What's on disk for a library item: { available, have, total, label } */
        libraryStatus: (kind, id) => {
            const count = (have, total, noun) => 'On disk · ' + have + (total && total !== have ? ' of ' + total : '') + ' ' + noun + (have === 1 && !(total && total !== have) ? '' : 's');
            if (kind === 'movie') {
                return get('movie', '/movie/' + id).then(m => {
                    const q = m.movieFile && m.movieFile.quality && m.movieFile.quality.quality ? m.movieFile.quality.quality.name : '';
                    return { available: !!m.hasFile, label: m.hasFile ? 'On disk' + (q ? ' · ' + q : '') : '' };
                });
            }
            if (kind === 'tv') {
                return get('tv', '/series/' + id).then(x => {
                    const st = x.statistics || {};
                    const have = st.episodeFileCount || 0, total = st.episodeCount || 0;
                    return { available: have > 0, have, total, label: have ? count(have, total, 'episode') : '' };
                });
            }
            return get('music', '/artist/' + id).then(a => {
                const st = a.statistics || {};
                const have = st.trackFileCount || 0, total = st.trackCount || 0;
                return { available: have > 0, have, total, label: have ? count(have, total, 'track') : '' };
            });
        },

        /* All queues, merged and sorted (problems first). One unreachable app doesn't hide the others. */
        queues: () => Promise.all(KINDS.map(kind => {
            if (!settings[kind].apiKey) { return Promise.resolve({ kind, items: [], error: null }); }
            return get(kind, SERVICES[kind].queuePath)
                .then(d => ({ kind, items: ((d && d.records) || d || []).map(r => normalise(kind, r)), error: null }))
                .catch(err => ({ kind, items: [], error: err.message }));
        })).then(results => {
            let items = [];
            results.forEach(r => { items = items.concat(r.items); });
            items.sort((a, b) => (STATE_ORDER[a.state] - STATE_ORDER[b.state]) || (b.progress - a.progress));
            return { items, errors: results.filter(r => r.error).map(r => SERVICES[r.kind].app + ': ' + r.error) };
        })
    };
}());
