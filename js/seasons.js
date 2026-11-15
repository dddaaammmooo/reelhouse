/*
 * Seasons: a TV show's seasons and episodes for the details pop-up and the season screen.
 *
 * Combines three sources:
 *   TVmaze  season / episode names, artwork, air dates, runtimes, summaries (any show, no key)
 *   Sonarr  which episodes are downloaded (only for shows already in Sonarr)
 *   Plex    which episodes can be played, and what's been watched (Plex rating keys for the player)
 */
var Seasons = (function () {
    'use strict';

    const TVMAZE = 'https://api.tvmaze.com';
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const stripHtml = s => String(s || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
    const cache = {};

    function getJSON(url) {
        return new Promise((resolve, reject) => {
            const x = new XMLHttpRequest();
            x.open('GET', url, true);
            x.timeout = 20000;
            x.onload = () => {
                if (x.status >= 200 && x.status < 300) { try { resolve(JSON.parse(x.responseText)); } catch (e) { reject(new Error('Bad data')); } }
                else { const err = new Error('HTTP ' + x.status); err.status = x.status; reject(err); }
            };
            x.onerror = () => reject(new Error('Network error'));
            x.ontimeout = () => reject(new Error('Timed out'));
            x.send();
        });
    }
    // TVmaze allows about 20 requests per 10 s; back off on HTTP 429.
    const tvmaze = (path, tries) => {
        if (cache[path]) { return cache[path]; }
        const p = getJSON(TVMAZE + path).catch(err => {
            delete cache[path];
            if (err.status === 429 && (tries || 0) < 3) { return sleep(2500 * ((tries || 0) + 1)).then(() => tvmaze(path, (tries || 0) + 1)); }
            throw err;
        });
        cache[path] = p;
        return p;
    };

    function showId(item, real) {
        const id = (item && item.tvmaze) || (real && real.tvMazeId);
        if (id) { return Promise.resolve(id); }
        if (!real || !real.tvdbId) { return Promise.resolve(null); }
        return tvmaze('/lookup/shows?thetvdb=' + real.tvdbId).then(s => s && s.id, () => null);
    }

    const today = () => new Date().toISOString().slice(0, 10);

    // Season posters from Plex (the best art when the show is on the Plex server), keyed by season number.
    function plexSeasonArt(real) {
        if (typeof Plex === 'undefined' || !Plex.configured()) { return Promise.resolve({}); }
        return Plex.findItem('tv', real).then(show => (show ? Plex.api('GET', '/library/metadata/' + show.ratingKey + '/children') : null)).then(d => {
            const out = {};
            ((d && d.MediaContainer && d.MediaContainer.Metadata) || []).forEach(m => {
                if (!m.thumb) { return; }
                const url = w => Plex.base() + '/photo/:/transcode?width=' + w + '&height=' + Math.round(w * 1.5) + '&minSize=1&url=' + encodeURIComponent(m.thumb) + '&X-Plex-Token=' + encodeURIComponent(Plex.token());
                out[m.index] = { small: url(256), large: url(720) };
            });
            return out;
        }).catch(() => ({}));
    }

    // Sonarr's season posters (from TheTVDB), when the show is in Sonarr.
    function sonarrSeasonArt(series, number) {
        const s = ((series && series.seasons) || []).filter(x => x.seasonNumber === number)[0];
        const img = s && (s.images || []).filter(i => i.coverType === 'poster')[0];
        return img ? (img.remoteUrl || img.url || '') : '';
    }

    /* All seasons (specials left out), each with art and Sonarr's download counts when the show is in Sonarr. */
    function forShow(item, real) {
        const sonarr = real && real.id > 0 && Api.configured('tv') ? Api.series(real.id).catch(() => null) : Promise.resolve(null);
        return Promise.all([showId(item, real).then(id => (id ? tvmaze('/shows/' + id + '/seasons') : [])).catch(() => []), sonarr, plexSeasonArt(real)]).then(r => {
            const maze = (r[0] || []).filter(s => s.number > 0);
            const stats = {};
            ((r[1] && r[1].seasons) || []).forEach(s => { stats[s.seasonNumber] = s.statistics || {}; });
            let list = maze.map(s => ({
                number: s.number, tvmazeSeasonId: s.id,
                name: s.name && !/^Season \d+$/i.test(s.name) ? s.name : 'Season ' + s.number,
                image: s.image ? (s.image.medium || s.image.original) : '',
                imageFull: s.image ? (s.image.original || s.image.medium) : '',
                episodes: s.episodeOrder || 0, premiere: s.premiereDate || '', summary: stripHtml(s.summary)
            }));
            // No TVmaze data: fall back to Sonarr's (or the lookup's) season numbers.
            if (!list.length) {
                list = ((r[1] && r[1].seasons) || (real && real.seasons) || []).filter(s => s.seasonNumber > 0).map(s => ({
                    number: s.seasonNumber, name: 'Season ' + s.seasonNumber, image: '', imageFull: '', episodes: 0, premiere: '', summary: ''
                }));
            }
            list.forEach(s => {
                // Art: Plex's season poster, else Sonarr's, else TVmaze's (else the show poster, in app.js).
                const px = r[2][s.number], so = sonarrSeasonArt(r[1], s.number);
                if (px) { s.image = px.small; s.imageFull = px.large; }
                else if (so) { s.image = so; s.imageFull = so; }
                const st = stats[s.number];
                s.files = st ? st.episodeFileCount || 0 : 0;
                s.aired = st ? st.episodeCount || 0 : 0;               // aired (and monitored) episodes Sonarr knows about
                s.total = (st && st.totalEpisodeCount) || s.episodes;
                s.future = !!(s.premiere && s.premiere > today());
            });
            return list;
        });
    }

    // Plex's episodes of one season, keyed by episode number (to play them and show what's watched).
    function plexEpisodes(real, season) {
        if (typeof Plex === 'undefined' || !Plex.configured()) { return Promise.resolve({}); }
        return Plex.findItem('tv', real).then(show => {
            if (!show) { return {}; }
            return Plex.api('GET', '/library/metadata/' + show.ratingKey + '/children').then(d => {
                const s = ((d.MediaContainer && d.MediaContainer.Metadata) || []).filter(x => x.index === season)[0];
                if (!s) { return {}; }
                return Plex.api('GET', '/library/metadata/' + s.ratingKey + '/children').then(e => {
                    const out = {};
                    ((e.MediaContainer && e.MediaContainer.Metadata) || []).forEach(m => { out[m.index] = m; });
                    return out;
                });
            });
        }).catch(() => ({}));
    }

    /* One season's episodes, merged from TVmaze, Sonarr and Plex. */
    function episodes(item, real, season) {
        const maze = season.tvmazeSeasonId ? tvmaze('/seasons/' + season.tvmazeSeasonId + '/episodes').catch(() => []) : Promise.resolve([]);
        const sonarr = real && real.id > 0 && Api.configured('tv') ? Api.seriesEpisodes(real.id, season.number).catch(() => []) : Promise.resolve([]);
        return Promise.all([maze, sonarr, plexEpisodes(real, season.number)]).then(r => {
            const byNum = {};
            const at = n => byNum[n] || (byNum[n] = { number: n, title: '', airdate: '', runtime: 0, image: '', summary: '' });
            (r[0] || []).forEach(e => {
                if (e.number == null) { return; }                          // specials inside a season
                const x = at(e.number);
                x.title = e.name || ''; x.airdate = e.airdate || ''; x.runtime = e.runtime || 0;
                x.image = e.image ? (e.image.medium || e.image.original) : ''; x.summary = stripHtml(e.summary);
            });
            (r[1] || []).forEach(e => {
                const x = at(e.episodeNumber);
                x.sonarr = { id: e.id, hasFile: !!e.hasFile, monitored: !!e.monitored };
                if (!x.title) { x.title = e.title || ''; }
                if (!x.airdate) { x.airdate = e.airDate || ''; }
                if (!x.summary) { x.summary = e.overview || ''; }
            });
            Object.keys(r[2] || {}).forEach(n => {
                const m = r[2][n], x = at(+n);
                x.plex = { ratingKey: m.ratingKey, watched: !!m.viewCount, offset: m.viewOffset || 0, duration: m.duration || 0 };
                if (!x.title) { x.title = m.title || ''; }
                if (!x.summary) { x.summary = m.summary || ''; }
                if (!x.image && m.thumb) { x.plexThumb = m.thumb; }
            });
            const t = today();
            return Object.keys(byNum).map(k => byNum[k]).sort((a, b) => a.number - b.number).map(x => {
                x.future = !!(x.airdate && x.airdate > t);
                x.onDisk = !!((x.sonarr && x.sonarr.hasFile) || x.plex);
                return x;
            });
        });
    }

    return { forShow, episodes };
}());
