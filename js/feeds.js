/*
 * Category rows shown on the TV / Movies / Music screens.
 * All sources are public and need no account:
 *   Movies: Radarr's TMDb lists (trending + popular), Apple iTunes top movies chart
 *   TV:     TVmaze schedule (premieres this week and coming up), Apple iTunes top TV seasons chart
 *   Music:  Apple Music most-played albums chart
 * Charts use MEDIALOADER_REGION (default "au").
 *
 * Rows are built as plain data ({ title, items: [descriptor] }) so they can be saved in localStorage
 * and shown instantly on the next launch. hydrate() turns descriptors into items with resolve(), which
 * looks the title up in the right *arr app only when you choose to download it. A title that appears
 * in several rows becomes one shared object, so its download status shows everywhere at once.
 */
var Feeds = (function () {
    'use strict';

    const REGION = (typeof MEDIALOADER_REGION !== 'undefined' && MEDIALOADER_REGION) || 'au';
    const DAY = 86400000;
    const ROW_MAX = 30;
    const STORE_KEY = 'medialoader.feed.';
    const STORE_VERSION = 10;       // 10: YouTube is no longer a channel (row / publisher); 9: publisher (network / studio / label) on each title

    // Radarr's list API and Apple's Music RSS don't send CORS headers. Tizen apps aren't bound by CORS,
    // but a desktop browser is, so when served over http (the Docker test container) use its proxy.
    const onTizen = typeof tizen !== 'undefined';
    const viaProxy = !onTizen && /^https?:$/.test(location.protocol);
    const RADARR_LISTS = viaProxy ? '/feeds/radarr' : 'https://api.radarr.video';
    const APPLE_RSS = viaProxy ? '/feeds/apple' : 'https://rss.marketingtools.apple.com';
    const ITUNES = 'https://itunes.apple.com';      // sends CORS headers
    const TVMAZE = 'https://api.tvmaze.com';        // sends CORS headers
    const DEEZER = viaProxy ? '/feeds/deezer' : 'https://api.deezer.com';   // related artists; no CORS headers

    function getJSON(url, timeout) {
        return new Promise((resolve, reject) => {
            const x = new XMLHttpRequest();
            x.open('GET', url, true);
            x.timeout = timeout || 30000;
            x.onload = () => {
                if (x.status >= 200 && x.status < 300) {
                    try { resolve(JSON.parse(x.responseText)); } catch (e) { reject(new Error('Bad data')); }
                } else { const err = new Error('HTTP ' + x.status); err.status = x.status; reject(err); }
            };
            x.onerror = () => reject(new Error('Network error'));
            x.ontimeout = () => reject(new Error('Timed out'));
            x.send();
        });
    }

    // TVmaze allows about 20 requests per 10 seconds; when it says "too many", wait and try again.
    function tvmaze(path, tries) {
        return getJSON(TVMAZE + path).catch(err => {
            if (err.status === 429 && (tries || 0) < 3) {
                return new Promise(r => setTimeout(r, 2500 * ((tries || 0) + 1))).then(() => tvmaze(path, (tries || 0) + 1));
            }
            throw err;
        });
    }
    function postJSON(url, body, timeout) {
        return new Promise((resolve, reject) => {
            const x = new XMLHttpRequest();
            x.open('POST', url, true);
            x.setRequestHeader('Content-Type', 'application/json');
            x.timeout = timeout || 30000;
            x.onload = () => {
                if (x.status >= 200 && x.status < 300) {
                    try { resolve(JSON.parse(x.responseText)); } catch (e) { reject(new Error('Bad data')); }
                } else { reject(new Error('HTTP ' + x.status)); }
            };
            x.onerror = () => reject(new Error('Network error'));
            x.ontimeout = () => reject(new Error('Timed out'));
            x.send(JSON.stringify(body));
        });
    }
    const soft = p => p.catch(() => null);         // one failing source shouldn't empty the page

    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const fmtDate = t => { const d = new Date(t); return d.getDate() + ' ' + MONTHS[d.getMonth()]; };
    const isoDay = d => d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
    const stripHtml = s => String(s || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
    const appleArt = (url, size) => String(url || '').replace(/\/\d+x\d+bb\.(png|jpg)$/, '/' + size + 'bb.jpg');
    const rows = list => list.filter(r => r.items.length).map(r => ({ title: r.title, items: r.items.slice(0, ROW_MAX) }));

    // Genre rows: the most common genres (at least `min` titles), in order of popularity.
    function genreRows(items, min, max, rename) {
        const counts = {};
        items.forEach(it => (it.genres || []).forEach(g => { counts[g] = (counts[g] || 0) + 1; }));
        return Object.keys(counts).filter(g => counts[g] >= min)
            .sort((a, b) => counts[b] - counts[a]).slice(0, max)
            .map(g => ({ title: (rename && rename[g]) || g, items: items.filter(it => (it.genres || []).indexOf(g) !== -1) }));
    }

    /* Rows grouped by a field (streaming service, studio): groups with at least `min` titles, the biggest
       `max` groups, in order of size. */
    // A show's streaming service, else its network. YouTube isn't treated as one: no YouTube row or Publisher tile.
    const NOT_A_CHANNEL = /^youtube/i;
    const webChannel = show => { const n = show.webChannel && show.webChannel.name; return n && !NOT_A_CHANNEL.test(n) ? n : ''; };
    const channelOf = show => webChannel(show) || (show.network && show.network.name) || '';

    function groupRows(items, keyOf, min, max, titleOf) {
        const groups = {}, order = [];
        items.forEach(it => {
            const k = keyOf(it);
            if (!k) { return; }
            if (!groups[k]) { groups[k] = []; order.push(k); }
            if (groups[k].indexOf(it) === -1) { groups[k].push(it); }
        });
        return order.filter(k => groups[k].length >= min).sort((a, b) => groups[b].length - groups[a].length).slice(0, max)
            .map(k => ({ title: titleOf(k), items: groups[k].slice(0, GENRE_MAX) }));
    }

    /* ======================= genre rows (shared) ======================= */

    const GENRE_MAX = 24;      // posters per genre row
    const GENRE_MIN = 4;       // a genre needs at least this many titles to get a row

    // One iTunes per-genre chart (store top sellers), as raw entries.
    const itunesGenre = (path, id) => soft(getJSON(ITUNES + '/' + REGION + '/rss/' + path + '/limit=' + GENRE_MAX + '/genre=' + id + '/json', 15000))
        .then(d => [].concat((d && d.feed && d.feed.entry) || []));

    /* Collects genre rows from several sources under one title each (e.g. TMDb "Science Fiction" and
       iTunes "Sci-Fi & Fantasy" both land in "Sci-Fi & Fantasy"); earlier sources fill rows first,
       duplicates are dropped. Rows come out in `order`, then any other genre alphabetically. */
    function genreBook(order) {
        const book = {};
        return {
            add: (title, items) => {
                if (!title) { return; }
                const row = book[title] || (book[title] = []);
                items.forEach(it => { if (row.indexOf(it) === -1 && row.length < GENRE_MAX) { row.push(it); } });
            },
            rows: () => Object.keys(book).filter(t => book[t].length >= GENRE_MIN)
                .sort((a, b) => {
                    const ia = order.indexOf(a), ib = order.indexOf(b);
                    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib) || a.localeCompare(b);
                })
                .map(t => ({ title: t, items: book[t] }))
        };
    }

    /* ======================= Movies ======================= */

    const MOVIE_GENRES = [[4401, 'Action & Adventure'], [4413, 'Sci-Fi & Fantasy'], [4404, 'Comedy'], [4406, 'Drama'],
        [4416, 'Thriller'], [4408, 'Horror'], [4412, 'Romance'], [4410, 'Kids & Family'], [4402, 'Anime'], [4405, 'Documentary'],
        [4409, 'Independent'], [4407, 'Foreign'], [4403, 'Classics'], [4418, 'Western'], [4411, 'Musicals'], [4417, 'Sports'],
        [4420, 'Holiday'], [4422, 'Concert Films'], [4423, 'Music Documentaries'], [4424, 'Music Feature Films'],
        [4419, 'Urban'], [4414, 'Short Films'], [4415, 'Special Interest']];
    const MOVIE_ORDER = ['Action & Adventure', 'Comedy', 'Drama', 'Thriller', 'Sci-Fi & Fantasy', 'Horror', 'Crime', 'Mystery',
        'Romance', 'Kids & Family', 'Animation', 'Anime', 'Documentary', 'Independent', 'Foreign', 'War', 'History', 'Western',
        'Classics', 'Musicals', 'Music', 'Sports', 'Holiday', 'Concert Films', 'Music Documentaries', 'Music Feature Films', 'Urban',
        'Short Films', 'Special Interest'];
    // TMDb genre names -> the row they join
    const TMDB_GENRE = { 'Action': 'Action & Adventure', 'Adventure': 'Action & Adventure', 'Science Fiction': 'Sci-Fi & Fantasy',
        'Fantasy': 'Sci-Fi & Fantasy', 'Family': 'Kids & Family', 'TV Movie': '' };

    function itunesMovieDesc(e) {
        const name = e['im:name'].label.replace(/\s*\(\d{4}\)\s*$/, '');
        const released = Date.parse((e['im:releaseDate'] || {}).label) || 0;
        const year = released ? new Date(released).getFullYear() : '';
        const img = (e['im:image'] || []).slice(-1)[0];
        const genre = e.category && e.category.attributes ? e.category.attributes.label : '';
        return {
            key: 'itm:' + name + ':' + year, src: 'movieTitle', ref: name, year,
            genres: genre ? [genre] : [], pub: rightsHolder(e.rights && e.rights.label),
            view: {
                title: name,
                meta: ['Top on iTunes', year, genre].filter(Boolean),
                poster: img ? appleArt(img.label, '400x600') : '',
                backdrop: img ? appleArt(img.label, '1200x1800') : '',
                overview: e.summary ? e.summary.label : ''
            }
        };
    }

    /* Who released a title, from an iTunes copyright line: "© 2026 Paramount Pictures" -> "Paramount Pictures",
       "An Atlantic Records Release, ℗ 2026 …" -> "Atlantic Records", "℗ 2026 X under license to Y" -> "X". */
    const MAJORS = [[/warner bros|\bwbei\b/i, 'Warner Bros. Pictures'], [/columbia pictures/i, 'Columbia Pictures'],
        [/universal (city )?studios|universal pictures/i, 'Universal Pictures'], [/paramount/i, 'Paramount Pictures'],
        [/walt disney|disney enterprises/i, 'Walt Disney Pictures'], [/lions ?gate/i, 'Lionsgate'], [/\ba24\b/i, 'A24'],
        [/sony pictures/i, 'Sony Pictures'], [/metro-goldwyn|\bmgm\b/i, 'Metro-Goldwyn-Mayer'],
        [/20th century|twentieth century/i, '20th Century Studios'], [/pixar/i, 'Pixar']];
    function rightsHolder(text) {
        let t = String(text || '');
        if (!t) { return ''; }
        const major = MAJORS.filter(m => m[0].test(t))[0];
        if (major) { return major[1]; }
        const release = /\bAn? (.+?) Release\b/i.exec(t);
        if (release) { return release[1].trim(); }
        t = t.replace(/^.*?VERSION:/i, '').replace(/[℗©®™]|\((c|p)\)/gi, ' ').replace(/\b(19|20)\d\d\b/g, ' ').replace(/All Rights Reserved\.?/gi, ' ');
        t = t.replace(/\b(this )?compilation\b|\bdistributed by\b|\bmarketed by\b|\breleased by\b/gi, ' ').trim();
        t = t.split(/\s+for\s+the\s+|\s+manufactured\b|\s+\(formerly\b|\s+under\s+|\s+and\s+|\s+distributed\s+|\s+marketed\s+|,|;|\/|\s+-\s+/i)[0];
        t = t.replace(/\b(Inc|LLC|Ltd|Limited|Corp|Corporation|Pty|GmbH)\b\.?/gi, ' ').replace(/[\s.]+$/, '').replace(/\s+/g, ' ').trim();
        return t.length >= 2 && t.length <= 40 && /[a-z0-9]/i.test(t) && !/^&/.test(t) ? t : '';
    }

    function tmdbImg(m, type, size) {
        const i = (m.Images || []).filter(x => x.CoverType === type)[0];
        return i && i.Url ? i.Url.replace('/t/p/original/', '/t/p/' + size + '/') : '';
    }

    function movieDesc(m, now) {
        const cinema = m.InCinema ? Date.parse(m.InCinema) : NaN;
        const digital = m.DigitalRelease ? Date.parse(m.DigitalRelease) : NaN;
        let when = '';
        if (cinema > now) { when = 'In cinemas ' + fmtDate(cinema); }
        else if (digital <= now) { when = 'Now streaming'; }
        else if (cinema > now - 150 * DAY) { when = 'In cinemas now'; }
        return {
            key: 'tmdb:' + m.TmdbId, src: 'tmdb', ref: m.TmdbId, cinema, digital,
            genres: m.Genres || [], pub: m.Studio || '',
            view: {
                title: m.Title,
                meta: [when, m.Year, m.Runtime ? Math.floor(m.Runtime / 60) + 'h ' + (m.Runtime % 60) + 'm' : '', (m.Genres || []).slice(0, 2).join(', ')].filter(Boolean),
                poster: tmdbImg(m, 'Poster', 'w342'),
                backdrop: tmdbImg(m, 'Fanart', 'w1280'),
                overview: m.Overview
            }
        };
    }

    function movies() {
        return Promise.all([
            soft(getJSON(RADARR_LISTS + '/v1/list/tmdb/trending')),
            soft(getJSON(RADARR_LISTS + '/v1/list/tmdb/popular')),
            soft(getJSON(ITUNES + '/' + REGION + '/rss/topmovies/limit=50/json')),
            Promise.all(MOVIE_GENRES.map(g => itunesGenre('topmovies', g[0])))
        ]).then(([trending, popular, itunes, genreCharts]) => {
            trending = trending || []; popular = popular || [];
            if (!trending.length && !popular.length && !itunes) { throw new Error('No movie lists available'); }
            const now = Date.now();
            const memo = {};

            const desc = m => memo[m.TmdbId] || (memo[m.TmdbId] = movieDesc(m, now));

            const all = [];
            trending.concat(popular).forEach(m => { const d = desc(m); if (all.indexOf(d) === -1) { all.push(d); } });

            const inCinemas = all.filter(i => i.cinema <= now && i.cinema > now - 150 * DAY && !(i.digital <= now));
            const justStreaming = all.filter(i => i.digital <= now && i.digital > now - 120 * DAY);
            const comingSoon = all.filter(i => i.cinema > now).sort((a, b) => a.cinema - b.cinema);

            const itm = e => { const d = itunesMovieDesc(e); return memo[d.key] || (memo[d.key] = d); };
            const store = ((itunes && itunes.feed && itunes.feed.entry) || []).map(itm);

            // Genre rows: what's trending in each genre first, then that genre's iTunes chart.
            const book = genreBook(MOVIE_ORDER);
            all.forEach(it => it.genres.forEach(g => {
                const title = TMDB_GENRE[g] !== undefined ? TMDB_GENRE[g] : g;
                book.add(title, [it]);
            }));
            MOVIE_GENRES.forEach((g, i) => book.add(g[1], (genreCharts[i] || []).map(itm)));

            return rows([
                { title: 'In cinemas & new releases', items: inCinemas.concat(justStreaming) },
                { title: 'Coming soon to cinemas', items: comingSoon },
                { title: 'Top movies on iTunes', items: store },
                { title: 'Popular right now', items: popular.map(desc) }
            ].concat(book.rows()));
        });
    }

    /* ======================= TV ======================= */

    const TV_GENRES = [[4000, 'Comedy'], [4001, 'Drama'], [4002, 'Animation'], [4003, 'Action & Adventure'], [4004, 'Classics'],
        [4005, 'Kids & Family'], [4006, 'Documentary'], [4007, 'Reality TV'], [4008, 'Sci-Fi & Fantasy'], [4009, 'Sports'],
        [4010, 'Teen'], [4011, 'Latino TV']];
    const TV_ORDER = ['Drama', 'Comedy', 'Crime', 'Thriller', 'Mystery', 'Action & Adventure', 'Sci-Fi & Fantasy', 'Horror',
        'Romance', 'Reality TV', 'Documentary', 'Animation', 'Anime', 'Kids & Family', 'Teen', 'Medical', 'Legal', 'History', 'War',
        'Western', 'Music', 'Food', 'Travel', 'Nature', 'Sports', 'Classics', 'Latino TV'];
    // TVmaze genre / type names -> the row they join
    const TVMAZE_GENRE = { 'Action': 'Action & Adventure', 'Adventure': 'Action & Adventure', 'Science-Fiction': 'Sci-Fi & Fantasy',
        'Fantasy': 'Sci-Fi & Fantasy', 'Supernatural': 'Sci-Fi & Fantasy', 'Family': 'Kids & Family', 'Children': 'Kids & Family',
        'Espionage': 'Thriller' };
    const TVMAZE_TYPE = { 'Reality': 'Reality TV', 'Documentary': 'Documentary', 'Animation': 'Animation', 'Game Show': 'Game Shows' };

    function tv() {
        const past = [], future = [];
        for (let i = 0; i < 7; i++) { past.push(isoDay(new Date(Date.now() - i * DAY))); }
        for (let i = 1; i <= 3; i++) { future.push(isoDay(new Date(Date.now() + i * DAY))); }
        // Streaming premieres for every day; US broadcast TV for the last 3 days only (keeps the request
        // count under TVmaze's limit).
        const sched = (days, withUS) => Promise.all(days.reduce((reqs, d, i) => {
            reqs.push(soft(tvmaze('/schedule/web?date=' + d)));
            if (withUS && i < 3) { reqs.push(soft(tvmaze('/schedule?country=US&date=' + d))); }
            return reqs;
        }, []));

        return Promise.all([sched(past, true), sched(future, false), soft(getJSON(ITUNES + '/' + REGION + '/rss/toptvseasons/limit=50/json')),
            Promise.all(TV_GENRES.map(g => itunesGenre('toptvseasons', g[0])))])
            .then(([pastLists, futureLists, itunes, genreCharts]) => {
                const memo = {};
                const premieres = lists => {
                    const found = {};
                    lists.forEach(list => (list || []).forEach(ep => {
                        const show = ep.show || (ep._embedded && ep._embedded.show);
                        if (!show || ep.number !== 1 || !show.externals || !show.externals.thetvdb) { return; }
                        if (show.language && show.language !== 'English') { return; }
                        if (['News', 'Sports', 'Award Show', 'Talk Show'].indexOf(show.type) !== -1) { return; }
                        if (found[show.id] && found[show.id].season >= ep.season) { return; }
                        found[show.id] = { show, season: ep.season, airdate: ep.airdate };
                    }));
                    return Object.keys(found).map(k => found[k]).sort((a, b) => (b.show.weight || 0) - (a.show.weight || 0));
                };
                const desc = ({ show, season, airdate }, upcoming) => {
                    if (memo[show.id]) { return memo[show.id]; }
                    const net = channelOf(show);
                    const day = airdate ? fmtDate(Date.parse(airdate)) : '';
                    let label;
                    if (upcoming) { label = season > 1 ? 'Season ' + season + ' premieres ' + day : 'New series · starts ' + day; }
                    else { label = season > 1 ? 'Season ' + season + ' premiere' : 'New series'; }
                    return (memo[show.id] = {
                        key: 'tvdb:' + show.externals.thetvdb, src: 'tvdb', ref: show.externals.thetvdb, tvmaze: show.id,
                        genres: show.genres || [], pub: net,
                        view: {
                            title: show.name,
                            meta: [label, net, upcoming ? '' : day, (show.genres || []).slice(0, 2).join(', ')].filter(Boolean),
                            poster: show.image ? (show.image.medium || show.image.original) : '',
                            backdrop: '',
                            overview: stripHtml(show.summary)
                        }
                    });
                };

                const recent = premieres(pastLists);
                const recentDescs = recent.map(p => desc(p, false));
                const upcoming = premieres(futureLists).filter(p => !memo[p.show.id]);

                // Everything airing this week (not just premieres), most popular first: feeds the genre rows.
                const airing = {};
                pastLists.forEach(list => (list || []).forEach(ep => {
                    const show = ep.show || (ep._embedded && ep._embedded.show);
                    if (!show || !show.externals || !show.externals.thetvdb || airing[show.id]) { return; }
                    if (show.language && show.language !== 'English') { return; }
                    if (['News', 'Sports', 'Award Show', 'Talk Show'].indexOf(show.type) !== -1) { return; }
                    airing[show.id] = show;
                }));
                const airingShows = Object.keys(airing).map(k => airing[k]).sort((a, b) => (b.weight || 0) - (a.weight || 0));
                const airDesc = show => memo[show.id] || (memo[show.id] = {
                    key: 'tvdb:' + show.externals.thetvdb, src: 'tvdb', ref: show.externals.thetvdb, tvmaze: show.id,
                    genres: show.genres || [], pub: channelOf(show),
                    view: {
                        title: show.name,
                        meta: ['On this week', channelOf(show),
                            (show.genres || []).slice(0, 2).join(', ')].filter(Boolean),
                        poster: show.image ? (show.image.medium || show.image.original) : '',
                        backdrop: '',
                        overview: stripHtml(show.summary)
                    }
                });

                const seen = {};
                const itvMemo = {};
                const itv = e => {
                    const full = e['im:name'].label;
                    const name = full.replace(/,\s*(Season|Series|Vol\.?|Volume)\s*\d+.*$/i, '').trim();
                    const seasonMatch = /(Season|Series)\s*(\d+)/i.exec(full);
                    const img = (e['im:image'] || []).slice(-1)[0];
                    const key = 'itv:' + name.toLowerCase();
                    if (itvMemo[key]) { return itvMemo[key]; }
                    return (itvMemo[key] = {
                        key, src: 'seriesTitle', ref: name,
                        genres: e.category && e.category.attributes ? [e.category.attributes.label] : [],
                        view: {
                            title: name,
                            meta: [seasonMatch ? 'Season ' + seasonMatch[2] : '', 'Top on iTunes', (e.category && e.category.attributes && e.category.attributes.label) || ''].filter(Boolean),
                            poster: img ? appleArt(img.label, '400x400') : '',
                            backdrop: img ? appleArt(img.label, '1200x1200') : '',
                            overview: e.summary ? e.summary.label : ''
                        }
                    });
                };
                const store = ((itunes && itunes.feed && itunes.feed.entry) || []).map(itv).filter(d => (seen[d.key] ? false : (seen[d.key] = true)));

                // Genre rows: shows airing this week (TVmaze genres) first, then each iTunes TV genre chart.
                const book = genreBook(TV_ORDER);
                airingShows.forEach(show => {
                    const d = airDesc(show);
                    (show.genres || []).forEach(g => book.add(TVMAZE_GENRE[g] || g, [d]));
                    if (TVMAZE_TYPE[show.type]) { book.add(TVMAZE_TYPE[show.type], [d]); }
                });
                TV_GENRES.forEach((g, i) => book.add(g[1], (genreCharts[i] || []).map(itv)));

                // Rows per streaming service (TVmaze's "web channel": Netflix, Apple TV+, Prime Video…), busiest first.
                const services = groupRows(airingShows, webChannel, 4, 6, n => n).map(r => ({ title: r.title, items: r.items.map(airDesc) }));
                const result = rows([
                    { title: 'New series this week', items: recentDescs.filter((d, i) => recent[i].season === 1) },
                    { title: 'Returning this week', items: recentDescs.filter((d, i) => recent[i].season > 1) },
                    { title: 'Premiering soon', items: upcoming.map(p => desc(p, true)) },
                    { title: 'Popular this week', items: airingShows.slice(0, GENRE_MAX).map(airDesc) }
                ].concat(services, book.rows()));          // (the iTunes "to buy" chart only feeds the genre rows)
                if (!result.length) { throw new Error('No TV lists available'); }
                return result;
            });
    }

    /* ======================= Music ======================= */

    // Apple Music's chart (with genres), falling back to the older iTunes chart: the newer feed
    // sometimes doesn't respond at all, so it only gets 12 seconds.
    function albumChart() {
        return getJSON(APPLE_RSS + '/api/v2/' + REGION + '/music/most-played/100/albums.json', 12000).then(d => {
            const list = (d && d.feed && d.feed.results) || [];
            if (!list.length) { throw new Error('Empty chart'); }
            return list.map(a => ({ id: a.id, name: a.name, artist: a.artistName, released: a.releaseDate, art: a.artworkUrl100,
                genres: (a.genres || []).map(g => g.name) }));
        }).catch(() => getJSON(ITUNES + '/' + REGION + '/rss/topalbums/limit=100/json', 15000).then(d => {
            return ((d && d.feed && d.feed.entry) || []).map(e => ({
                id: e.id && e.id.attributes ? e.id.attributes['im:id'] : e['im:name'].label,
                name: e['im:name'].label,
                artist: e['im:artist'].label,
                released: (e['im:releaseDate'] || {}).label,
                art: ((e['im:image'] || []).slice(-1)[0] || {}).label,
                genres: e.category && e.category.attributes ? [e.category.attributes.label] : [],
                label: rightsHolder(e.rights && e.rights.label)
            }));
        }));
    }

    const MUSIC_GENRES = [[14, 'Pop'], [21, 'Rock'], [18, 'Hip Hop/Rap'], [20, 'Alternative'], [6, 'Country'], [17, 'Dance'],
        [7, 'Electronic'], [15, 'R&B/Soul'], [10, 'Singer/Songwriter'], [1153, 'Heavy Metal'], [11, 'Jazz'], [2, 'Blues'],
        [5, 'Classical'], [16, 'Soundtrack'], [1289, 'Folk'], [24, 'Reggae'], [12, 'Latin'], [51, 'K-Pop'], [22, 'Christian & Gospel'],
        [4, 'Children’s Music'], [9, 'Opera'], [1122, 'Brazilian'], [1197, 'Arabic'], [8, 'Holiday'], [50, 'Fitness & Workout']];
    const DECADES = [['1960s', '60s', '1960'], ['1970s', '70s', '1970'], ['1980s', '80s', '1980'], ['1990s', '90s', '1990'],
        ['2000s', '2000s', '2000s'], ['2010s', '2010s', '2010s'], ['2020s', '2020s', '2020s']];

    function itunesAlbumDesc(e, genreTitle) {
        const name = e['im:name'].label, artist = e['im:artist'].label;
        const released = Date.parse((e['im:releaseDate'] || {}).label) || 0;
        const art = ((e['im:image'] || []).slice(-1)[0] || {}).label;
        return {
            key: 'album:' + (e.id && e.id.attributes ? e.id.attributes['im:id'] : name), src: 'artist', ref: artist, released,
            genres: [genreTitle], add: { monitor: 'latest' }, pub: rightsHolder(e.rights && e.rights.label),
            view: {
                title: name,
                meta: [artist, released ? 'Released ' + fmtDate(released) + ' ' + new Date(released).getFullYear() : '', genreTitle].filter(Boolean),
                poster: appleArt(art, '400x400'),
                backdrop: appleArt(art, '1200x1200'),
                overview: 'Adds ' + artist + ' to Lidarr and downloads their latest album.'
            }
        };
    }

    /* One Deezer "<decade> hits" playlist per decade: the playlist whose title names that decade (and no
       other), then its tracks' artists, one card each with the album the hit came from. */
    function decadeRows() {
        const norm = s => String(s || '').toLowerCase();
        return Promise.all(DECADES.map(dec => soft(getJSON(DEEZER + '/search/playlist?q=' + encodeURIComponent(dec[1] + ' hits') + '&limit=15', 15000)).then(r => {
            const lists = (r && r.data) || [];
            const others = DECADES.filter(d => d !== dec);
            const names = t => norm(t).indexOf(norm(dec[1])) !== -1 || norm(t).indexOf(dec[2]) !== -1;
            const clash = t => others.some(o => norm(t).indexOf(norm(o[1])) !== -1);
            const pick = lists.filter(p => names(p.title) && !clash(p.title)).sort((a, b) => (b.nb_tracks || 0) - (a.nb_tracks || 0))[0] || lists[0];
            if (!pick) { return null; }
            return soft(getJSON(DEEZER + '/playlist/' + pick.id + '/tracks?limit=80', 15000)).then(t => {
                const seen = {};
                const items = (((t && t.data) || []).filter(x => x.artist && x.album && !seen[x.artist.id] && (seen[x.artist.id] = true)))
                    .slice(0, GENRE_MAX).map(x => ({
                        key: 'dz:' + x.artist.id, src: 'artist', ref: x.artist.name, genres: [], add: { monitor: 'latest' },
                        view: {
                            title: x.artist.name,
                            meta: [x.album.title, 'Hits of the ' + dec[0]].filter(Boolean),
                            poster: x.album.cover_big || x.album.cover_medium || '',
                            backdrop: x.album.cover_xl || '',
                            overview: '“' + x.title + '” is one of the hits of the ' + dec[0] + '. Adds ' + x.artist.name + ' to Lidarr and downloads their latest album.'
                        }
                    }));
                return items.length ? { title: 'Hits of the ' + dec[0], items } : null;
            });
        }))).then(list => list.filter(Boolean));
    }

    function music() {
        const genreCharts = Promise.all(MUSIC_GENRES.map(g => itunesGenre('topalbums', g[0])));
        return Promise.all([albumChart(), genreCharts, decadeRows().catch(() => [])]).then(([albums, charts, decades]) => {
            const now = Date.now();
            const chart = albums.map(a => {
                const released = Date.parse(a.released) || 0;
                const genres = a.genres.filter(g => g !== 'Music');
                return {
                    key: 'album:' + a.id, src: 'artist', ref: a.artist, released, genres, pub: a.label || '',
                    add: { monitor: 'latest' },
                    view: {
                        title: a.name,
                        meta: [a.artist, released > now - 30 * DAY ? 'New · ' + fmtDate(released) : 'Released ' + fmtDate(released) + ' ' + new Date(released).getFullYear(), genres[0]].filter(Boolean),
                        poster: appleArt(a.art, '600x600'),
                        backdrop: appleArt(a.art, '1200x1200'),
                        overview: 'Adds ' + a.artist + ' to Lidarr and downloads this, their latest album.'
                    }
                };
            });
            if (!chart.length) { throw new Error('No albums found'); }
            const newest = chart.slice().sort((x, y) => y.released - x.released);
            // Genre rows: each iTunes album chart, plus anything from the main chart in that genre.
            const book = genreBook(MUSIC_GENRES.map(g => g[1]));
            MUSIC_GENRES.forEach((g, i) => book.add(g[1], (charts[i] || []).map(e => itunesAlbumDesc(e, g[1]))));
            chart.forEach(it => it.genres.forEach(g => book.add(g === 'Hip-Hop/Rap' ? 'Hip Hop/Rap' : g, [it])));
            return rows([
                { title: 'Popular new albums', items: newest },
                { title: 'Most played right now', items: chart }
            ].concat(decades, book.rows()));
        });
    }

    /* ======================= descriptors -> items ======================= */

    function hydrate(rowsData) {
        const memo = {};
        const make = d => {
            if (memo[d.key]) { return memo[d.key]; }
            const it = { _feed: true, key: d.key, view: d.view, addOptions: d.add, genres: d.genres || [], pub: d.pub || '', tvmaze: d.tvmaze, src: d.src, ref: d.ref, year: d.year };
            if (d.kind) { it.kind = d.kind; }          // set on mixed rows (an actor's movies + shows)
            if (d.src === 'tmdb') { it.resolve = () => Api.lookupMovie(d.ref); }
            else if (d.src === 'movieTitle') { it.resolve = () => Api.lookupMovieByTitle(d.ref, d.year); }
            else if (d.src === 'tvdb') { it.resolve = () => Api.lookupSeries(d.ref); }
            else if (d.src === 'seriesTitle') { it.resolve = () => Api.lookupSeriesByTitle(d.ref); }
            else { it.resolve = () => Api.lookupArtist(d.ref); }
            if (d.tvmaze && !d.view.backdrop) {
                // Wide background image, fetched when the item is first highlighted.
                it.loadBackdrop = () => tvmaze('/shows/' + d.tvmaze + '/images').then(imgs => {
                    const bg = (imgs || []).filter(i => i.type === 'background')[0];
                    return bg ? bg.resolutions.original.url : d.view.poster;
                });
            }
            return (memo[d.key] = it);
        };
        return rowsData.map(r => ({ title: r.title, items: r.items.map(make) }));
    }

    // Keep only what's needed to rebuild the rows (drops the date/genre working fields).
    const slim = rowsData => rowsData.map(r => ({
        title: r.title,
        items: r.items.map(d => ({ key: d.key, src: d.src, ref: d.ref, year: d.year, tvmaze: d.tvmaze, add: d.add, genres: d.genres, pub: d.pub,
            view: Object.assign({}, d.view, { overview: String(d.view.overview || '').slice(0, 600) }) }))
    }));

    function save(kind, rowsData) {
        try { localStorage.setItem(STORE_KEY + kind, JSON.stringify({ v: STORE_VERSION, at: Date.now(), rows: slim(rowsData) })); } catch (e) { /* storage full or unavailable */ }
    }

    /* ======================= "Similar" pages ======================= */

    // Movies: TMDb recommendations (via Radarr's public metadata service), details fetched in one request.
    function similarMovies(tmdbId) {
        return getJSON(RADARR_LISTS + '/v1/movie/' + tmdbId).then(m => {
            const ids = (m.Recommendations || []).map(r => r.TmdbId).slice(0, 20);
            if (!ids.length) { return []; }
            return postJSON(RADARR_LISTS + '/v1/movie/bulk', ids).then(list => {
                const now = Date.now();
                return [{ title: 'Recommended if you liked ' + m.Title, items: (list || []).map(x => movieDesc(x, now)) }];
            });
        });
    }

    // TV: other shows starring the main cast (TVmaze has cast lists but no recommendations).
    function similarShows(tvmazeId) {
        const showDesc = show => ({
            key: 'tvdb:' + show.externals.thetvdb, src: 'tvdb', ref: show.externals.thetvdb, tvmaze: show.id,
            genres: show.genres || [],
            view: {
                title: show.name,
                meta: [show.premiered ? show.premiered.slice(0, 4) : '', channelOf(show),
                    (show.genres || []).slice(0, 2).join(', ')].filter(Boolean),
                poster: show.image ? (show.image.medium || show.image.original) : '',
                backdrop: '',
                overview: stripHtml(show.summary)
            }
        });
        return tvmaze('/shows/' + tvmazeId + '/cast').then(cast => {
            const people = (cast || []).slice(0, 4).map(c => c.person);
            return Promise.all(people.map(pp => soft(tvmaze('/people/' + pp.id + '/castcredits?embed=show')))).then(lists =>
                lists.map((cc, i) => ({
                    title: 'Starring ' + people[i].name,
                    items: (cc || []).map(c => c._embedded && c._embedded.show)
                        .filter(sh => sh && sh.id !== tvmazeId && sh.externals && sh.externals.thetvdb && (!sh.language || sh.language === 'English'))
                        .sort((a, b) => (b.weight || 0) - (a.weight || 0))
                        .map(showDesc)
                })));
        });
    }

    // Music: related artists from Deezer, plus the artists those are related to.
    function similarArtists(name) {
        const norm = x => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const artistDesc = a => ({
            key: 'artist:' + norm(a.name), src: 'artist', ref: a.name, add: { monitor: 'latest' }, genres: [],
            view: {
                title: a.name,
                meta: [a.nb_fan ? a.nb_fan.toLocaleString() + ' fans on Deezer' : ''].filter(Boolean),
                poster: a.picture_xl || a.picture_big || '',
                backdrop: a.picture_xl || '',
                overview: 'Adds ' + a.name + ' to Lidarr and downloads their latest album.'
            }
        });
        return getJSON(DEEZER + '/search/artist?q=' + encodeURIComponent(name) + '&limit=5').then(r => {
            const found = (r && r.data) || [];
            const a = found.filter(x => norm(x.name) === norm(name))[0] || found[0];
            if (!a) { return []; }
            return getJSON(DEEZER + '/artist/' + a.id + '/related?limit=30').then(rel => {
                const related = (rel && rel.data) || [];
                const seen = {};
                seen[norm(a.name)] = true;
                related.forEach(x => { seen[norm(x.name)] = true; });
                return Promise.all(related.slice(0, 3).map(x => soft(getJSON(DEEZER + '/artist/' + x.id + '/related?limit=15')))).then(more => {
                    const second = [];
                    more.forEach(m => ((m && m.data) || []).forEach(x => { if (!seen[norm(x.name)]) { seen[norm(x.name)] = true; second.push(x); } }));
                    return [
                        { title: 'Artists like ' + a.name, items: related.map(artistDesc) },
                        { title: 'Fans also like', items: second.map(artistDesc) }
                    ];
                });
            });
        });
    }

    /* Rows for a "similar" page. `real` is the *arr lookup item; `pool` is everything already loaded on
       this screen, used for extra "More <genre>" rows. */
    function similar(kind, real, item, pool) {
        let p;
        if (kind === 'movie') { p = real.tmdbId ? similarMovies(real.tmdbId) : Promise.resolve([]); }
        else if (kind === 'tv') { const id = item.tvmaze || real.tvMazeId; p = id ? similarShows(id) : Promise.resolve([]); }
        else { p = similarArtists(real.artistName || item.view.title); }
        return p.catch(() => []).then(data => {
            const rowsOut = hydrate(rows(data));
            const exclude = item.key || '';
            (real.genres || []).slice(0, 2).forEach(g => {
                const items = pool.filter(it => it !== item && it.key !== exclude && (it.genres || []).indexOf(g) !== -1);
                if (items.length >= 3) { rowsOut.push({ title: 'More ' + g, items: items.slice(0, ROW_MAX) }); }
            });
            if (!rowsOut.length) { throw new Error('No similar titles found'); }
            return rowsOut;
        });
    }

    const LOADERS = { tv, movie: movies, music };
    const SUMMARY = {
        tv: 'New series, returning seasons and what’s premiering soon',
        movie: 'What’s in cinemas, coming soon and popular right now',
        music: 'The most-played albums right now, newest first and by genre'
    };
    const inflight = {};

    const genreName = (kind, g) => {
        if (kind === 'movie') { return TMDB_GENRE[g] !== undefined ? TMDB_GENRE[g] : g; }
        if (kind === 'tv') { return TVMAZE_GENRE[g] || TMDB_GENRE[g] || g; }
        return g === 'Hip-Hop/Rap' ? 'Hip Hop/Rap' : g;
    };

    return {
        summary: kind => SUMMARY[kind],
        genreName,
        rightsHolder,
        similar,
        hydrate,
        movieDesc,
        // A show's TVmaze images (posters, backgrounds…): [{ type, medium, original }]
        images: tvmazeId => tvmaze('/shows/' + tvmazeId + '/images').then(list => (list || []).map(i => ({
            type: i.type, medium: (i.resolutions.medium || i.resolutions.original).url, original: i.resolutions.original.url }))),

        /* Rows saved by a previous launch, shown instantly: { rows, at } or null. */
        cached: kind => {
            try {
                const c = JSON.parse(localStorage.getItem(STORE_KEY + kind) || 'null');
                if (!c || c.v !== STORE_VERSION || !c.rows || !c.rows.length) { return null; }
                return { rows: hydrate(c.rows), at: c.at };
            } catch (e) { return null; }
        },

        /* Fresh rows from the network; also saved for the next launch. */
        load: kind => {
            if (!inflight[kind]) {
                inflight[kind] = LOADERS[kind]().then(data => { save(kind, data); return hydrate(data); });
                const clear = () => { delete inflight[kind]; };
                inflight[kind].then(clear, clear);
            }
            return inflight[kind];
        }
    };
}());
