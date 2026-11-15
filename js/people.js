/*
 * People: cast lists, actor search, biographies and filmographies.
 *
 * Sources (all free, no account):
 *   Cast of a movie   Radarr's metadata service (TMDb credits, with TMDb person ids + headshots)
 *   Cast of a show    TVmaze /shows/{id}/cast
 *   Actor search      Wikidata name search, kept to people with a TMDb person id or an acting occupation
 *   Biography/photo   Wikipedia page summary (+ Wikimedia Commons portrait)
 *   Filmography       Wikidata "cast member" (P161) works, with their TMDb movie ids (P4947) and TVDB ids (P4835);
 *                     movie details/posters from Radarr's metadata (bulk), show details/posters from TVmaze.
 *
 * Person cards and filmography items are feed-style items (see Feeds.hydrate), so the browse screen,
 * details modal, Download and Play In Plex all work on them unchanged. Each item carries its `kind`.
 */
var People = (function () {
    'use strict';

    const onTizen = typeof tizen !== 'undefined';
    const viaProxy = !onTizen && /^https?:$/.test(location.protocol);
    const RADARR_LISTS = viaProxy ? '/feeds/radarr' : 'https://api.radarr.video';
    const TVMAZE = 'https://api.tvmaze.com';
    const WIKIDATA = 'https://www.wikidata.org/w/api.php';
    const SPARQL = 'https://query.wikidata.org/sparql';
    const WIKIPEDIA = 'https://en.wikipedia.org/api/rest_v1/page/summary/';
    const WIKI_API = 'https://en.wikipedia.org/w/api.php';
    const ACTING = ['Q33999', 'Q10800557', 'Q10798782', 'Q2405480', 'Q2259451', 'Q245068'];   // actor, film/TV/voice/stage actor, comedian
    const MAX_FILMS = 60;

    function request(method, url, body, timeout) {
        return new Promise((resolve, reject) => {
            const x = new XMLHttpRequest();
            x.open(method, url, true);
            x.timeout = timeout || 30000;
            x.setRequestHeader('Accept', 'application/json');
            if (body) { x.setRequestHeader('Content-Type', 'application/json'); }
            // Wikimedia rate-limits anonymous clients harder; it asks browser apps to name themselves this way.
            if (/wiki(data|pedia)\.org/.test(url)) { x.setRequestHeader('Api-User-Agent', 'Reelhouse/1.0 (Tizen TV media browser)'); }
            x.onload = () => {
                if (x.status >= 200 && x.status < 300) {
                    try { resolve(JSON.parse(x.responseText)); } catch (e) { reject(new Error('Bad data')); }
                } else {
                    const err = new Error(x.status === 429 ? 'Wikidata is busy, try again in a few seconds' : 'HTTP ' + x.status);
                    err.status = x.status; err.retryAfter = parseInt(x.getResponseHeader('Retry-After'), 10) || 0; reject(err);
                }
            };
            x.onerror = () => reject(new Error('Network error'));
            x.ontimeout = () => reject(new Error('Timed out'));
            x.send(body ? JSON.stringify(body) : null);
        });
    }
    const get = (url, t) => request('GET', url, null, t);
    const soft = p => p.catch(() => null);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const stripHtml = s => String(s || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
    const tmdbSize = (url, size) => String(url || '').replace('/t/p/original/', '/t/p/' + size + '/');
    const commons = (file, width) => 'https://commons.wikimedia.org/wiki/Special:FilePath/' + encodeURIComponent(file) + '?width=' + width;
    const tvmaze = (path, tries) => get(TVMAZE + path).catch(err => {
        if (err.status === 429 && (tries || 0) < 3) { return sleep(2500 * ((tries || 0) + 1)).then(() => tvmaze(path, (tries || 0) + 1)); }
        throw err;
    });
    // Wikidata / Wikipedia: one request at a time (bursts get HTTP 429), retrying 429s after the wait they ask for.
    let wikiChain = Promise.resolve();
    function wiki(url, timeout) {
        const attempt = tries => get(url, timeout).catch(err => {
            if (err.status !== 429 || tries >= 3) { throw err; }
            return sleep(Math.min(8, err.retryAfter || 2 * (tries + 1)) * 1000).then(() => attempt(tries + 1));
        });
        const run = wikiChain.then(() => attempt(0));
        wikiChain = run.catch(() => null);
        return run;
    }
    /* Saved answers (localStorage), so the same searches, biographies, filmographies and cast lists
       don't hit Wikidata / TVmaze again: fewer HTTP 429s and instant repeat visits. */
    const STORE = 'medialoader.people';
    const DAY = 24 * 60 * 60 * 1000;
    const MAX_ENTRIES = 300;
    let store = (() => { try { return JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch (e) { return {}; } })();
    let storeTimer = null;
    function saveStore() {
        clearTimeout(storeTimer);
        storeTimer = setTimeout(() => {
            const keys = Object.keys(store);
            if (keys.length > MAX_ENTRIES) {
                keys.sort((a, b) => store[a].at - store[b].at).slice(0, keys.length - MAX_ENTRIES).forEach(k => { delete store[k]; });
            }
            for (let i = 0; i < 3; i++) {
                try { localStorage.setItem(STORE, JSON.stringify(store)); return; } catch (e) {
                    // Storage full: drop the older half and try again.
                    const ks = Object.keys(store).sort((a, b) => store[a].at - store[b].at);
                    ks.slice(0, Math.ceil(ks.length / 2)).forEach(k => { delete store[k]; });
                }
            }
        }, 1000);
    }
    const pending = {};
    function remember(key, ttl, fetch) {
        const hit = store[key];
        if (hit && Date.now() - hit.at < ttl) { return Promise.resolve(hit.v); }
        if (!pending[key]) {
            pending[key] = fetch().then(v => { store[key] = { at: Date.now(), v }; saveStore(); delete pending[key]; return v; },
                err => { delete pending[key]; throw err; });
        }
        return pending[key];
    }

    const sparql = q => wiki(SPARQL + '?format=json&query=' + encodeURIComponent(q), 30000).then(d => (d && d.results && d.results.bindings) || []);

    /* ---------------- people as cards ---------------- */

    // A person as a feed-style item. `p` = { name, photo, photoFull, tmdb, qid, wiki, description, character }
    function card(p) {
        return {
            _feed: true, _person: p, kind: 'people', key: 'person:' + (p.qid || p.tmdb || p.tvmaze || p.name),
            view: {
                title: p.name,
                meta: [p.character ? 'as ' + p.character + (p.note ? ' (' + p.note + ')' : '') + (p.known ? ' in ' + p.known : '') : (p.known ? 'In ' + p.known : ''), p.description || ''].filter(Boolean),
                poster: p.photo || '',
                backdrop: p.photoFull || p.photo || '',
                overview: p.bio || ''
            }
        };
    }

    function fromEntity(ent) {
        const claims = ent.claims || {};
        const val = prop => { const c = claims[prop] && claims[prop][0]; return c && c.mainsnak && c.mainsnak.datavalue ? c.mainsnak.datavalue.value : null; };
        const img = val('P18');
        return {
            qid: ent.id,
            name: ent.labels && (ent.labels.en || ent.labels.mul) ? (ent.labels.en || ent.labels.mul).value : ent.id,
            description: ent.descriptions && ent.descriptions.en ? ent.descriptions.en.value : '',
            photo: img ? commons(img, 400) : '',
            photoFull: img ? commons(img, 1400) : '',
            tmdb: val('P4985'),
            wiki: ent.sitelinks && ent.sitelinks.enwiki ? ent.sitelinks.enwiki.title : '',
            acting: (claims.P106 || []).some(c => c.mainsnak && c.mainsnak.datavalue && ACTING.indexOf(c.mainsnak.datavalue.value.id) !== -1)
        };
    }

    function entities(ids) {
        if (!ids.length) { return Promise.resolve([]); }
        return wiki(WIKIDATA + '?action=wbgetentities&format=json&origin=*&props=labels|descriptions|claims|sitelinks&languages=en|mul&sitefilter=enwiki&ids=' + ids.join('|'))
            .then(d => ids.map(id => d.entities && d.entities[id]).filter(Boolean).map(fromEntity));
    }

    /* Actor search by name: people only (TMDb person id or an acting occupation), best match first. */
    function search(name) {
        const term = name.trim().toLowerCase();
        return remember('s:' + term, 7 * DAY, () =>
            wiki(WIKIDATA + '?action=wbsearchentities&format=json&origin=*&language=en&type=item&limit=20&search=' + encodeURIComponent(term))
                .then(d => entities(((d && d.search) || []).map(s => s.id)))
                .then(list => list.filter(p => p.tmdb || p.acting)))
            .then(list => list.map(p => Object.assign({}, p)));     // callers add to these; keep the saved copy clean
    }

    function byTmdb(tmdbId) {
        return remember('t:' + tmdbId, 30 * DAY, () => sparql('SELECT ?p WHERE { ?p wdt:P4985 "' + String(tmdbId).replace(/\D/g, '') + '". } LIMIT 1')
            .then(b => (b[0] ? entities([b[0].p.value.split('/').pop()]) : []))
            .then(l => l[0] || null)).then(e => (e ? Object.assign({}, e) : null));
    }

    /* Fill in a cast member's Wikidata entry (needed for their filmography). */
    function resolve(p) {
        if (p.qid) { return Promise.resolve(p); }
        const found = p.tmdb ? byTmdb(p.tmdb) : Promise.resolve(null);
        return found.then(e => e || search(p.name).then(l => l[0] || null)).then(e => {
            if (!e) { return p; }
            return Object.assign({}, e, { character: p.character, photo: p.photo || e.photo, photoFull: p.photoFull || e.photoFull });
        });
    }

    /* Biography + best portrait from Wikipedia, with fallbacks:
         1. the article Wikidata links to (or the person's name as a title)
         2. if that's missing, a disambiguation page, or about someone else: a Wikipedia search for "<name> actor"
         3. Wikidata's short description ("American actor (born 1962)")  */
    const ACTING_WORDS = /act(or|ress)|comedian|presenter|performer|singer|musician|host|personality|model|dancer|director|writer|broadcaster|filmmaker|voice/i;
    const sameName = (a, b) => String(a || '').toLowerCase().replace(/[^a-z0-9]/g, '') === String(b || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    // Near-miss spellings in cast lists (TVmaze has "Philip Madog" for Philip Madoc): same first name and at most
    // 2 letters different overall.
    function closeName(a, b) {
        if (sameName(a, b)) { return true; }
        const wa = String(a || '').toLowerCase().split(/\s+/), wb = String(b || '').toLowerCase().split(/\s+/);
        if (!wa[0] || wa[0] !== wb[0]) { return false; }
        const x = wa.join(''), y = wb.join('');
        if (Math.abs(x.length - y.length) > 2) { return false; }
        let prev = [];
        for (let j = 0; j <= y.length; j++) { prev[j] = j; }
        for (let i = 1; i <= x.length; i++) {
            const cur = [i];
            for (let j = 1; j <= y.length; j++) { cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1)); }
            prev = cur;
        }
        return prev[y.length] <= 2;
    }
    function wikiSummary(title) {
        return wiki(WIKIPEDIA + encodeURIComponent(String(title).replace(/ /g, '_')), 15000).then(s => (!s || s.type === 'disambiguation' ? null : s));
    }
    // The best Wikipedia article for a performer by name ("Jason Watkins (actor)" over the footballer).
    function wikiFind(name, retried) {
        return wiki(WIKI_API + '?action=query&list=search&format=json&origin=*&srlimit=5&srsearch=' + encodeURIComponent(name + ' actor')).then(d => {
            const list = (d && d.query && d.query.search) || [];
            const bare = h => h.title.replace(/\s*\(.*\)$/, '');
            const exact = list.filter(h => sameName(bare(h), name))[0];
            if (exact) { return { title: exact.title, exact: !retried }; }
            const near = list.filter(h => closeName(bare(h), name))[0];
            if (near) { return { title: near.title, exact: false }; }
            // Misspelt in the cast list? Try Wikipedia's own spelling suggestion once ("philip madoc actor").
            const sug = d && d.query && d.query.searchinfo && d.query.searchinfo.suggestion;
            const fixed = sug ? sug.replace(/\s+actor$/i, '') : '';
            return !retried && fixed && closeName(fixed, name) && !sameName(fixed, name) ? wikiFind(fixed, true) : null;
        });
    }
    function biography(p) {
        const title = p.wiki || p.name;
        // A linked article is trusted; a page found by name must look like it's about a performer.
        const fromTitle = (t, trusted) => wikiSummary(t).then(s => (s && s.extract && (trusted || ACTING_WORDS.test(s.description || '') || ACTING_WORDS.test(s.extract.slice(0, 200)))
            ? { bio: s.extract, image: (s.originalimage && s.originalimage.source) || (s.thumbnail && s.thumbnail.source) || '' } : null));
        return remember('b4:' + title, 30 * DAY, () => fromTitle(title, !!p.wiki).catch(() => null)
            // An exactly matching article is trusted; a near-miss spelling must be about a performer.
            .then(r => r || wikiFind(p.name).then(f => (f ? fromTitle(f.title, f.exact) : null)).catch(() => null))
            .then(r => r || { bio: '', image: '' }))
            .then(b => ({ bio: b.bio || p.description || '', image: b.image }), () => ({ bio: p.description || '', image: '' }));
    }

    /* A photo for someone whose cast list had none: TVmaze's people search (same name), then their Wikipedia
       article's image, then Wikidata's Commons portrait. Saved for 30 days (including "none found"). */
    function photo(p) {
        if (p.photo) { return Promise.resolve({ photo: p.photo, photoFull: p.photoFull || p.photo }); }
        return remember('ph2:' + String(p.name).toLowerCase(), 30 * DAY, () =>
            tvmaze('/search/people?q=' + encodeURIComponent(p.name)).then(list => {
                const people = (list || []).map(r => r.person).filter(x => x.image);
                const hit = people.filter(x => sameName(x.name, p.name))[0] || people.filter(x => closeName(x.name, p.name))[0];
                return hit ? { photo: hit.image.medium || hit.image.original, photoFull: hit.image.original || hit.image.medium } : null;
            }).catch(() => null)
                .then(r => r || biography(p).then(b => (b.image ? { photo: b.image, photoFull: b.image } : null)).catch(() => null))
                .then(r => r || resolve(Object.assign({}, p)).then(e => (e && e.photo ? { photo: e.photo, photoFull: e.photoFull || e.photo } : null)).catch(() => null))
                .then(r => r || { photo: '', photoFull: '' }));
    }

    /* ---------------- cast lists ---------------- */

    function cast(kind, real, item) {
        if (kind === 'movie' && real.tmdbId) {
            return remember('c:m' + real.tmdbId, 7 * DAY, () => get(RADARR_LISTS + '/v1/movie/' + real.tmdbId).then(m => ((m.Credits && m.Credits.Cast) || []).slice(0, 30).map(c => {
                const img = ((c.Images || [])[0] || {}).Url;
                return { name: c.Name, character: c.Character, tmdb: c.TmdbId, photo: img ? tmdbSize(img, 'w342') : '', photoFull: img ? tmdbSize(img, 'h632') : '' };
            }))).then(list => list.map(p => Object.assign({}, p)));
        }
        if (kind === 'tv') {
            const id = (item && item.tvmaze) || real.tvMazeId;
            const ck = 'c:t' + (id || real.tvdbId);
            const lookup = id ? Promise.resolve(id) : (real.tvdbId ? tvmaze('/lookup/shows?thetvdb=' + real.tvdbId).then(s => s && s.id) : Promise.resolve(null));
            const base = store[ck] && Date.now() - store[ck].at < 7 * DAY ? Promise.resolve(store[ck].v)
                : lookup.then(tid => (tid ? tvmaze('/shows/' + tid + '/cast') : [])).then(list => (list || []).slice(0, 30).map(c => ({
                    name: c.person.name, character: c.character && c.character.name, tvmaze: c.person.id,
                    photo: c.person.image ? (c.person.image.medium || c.person.image.original) : '',
                    photoFull: c.person.image ? (c.person.image.original || c.person.image.medium) : ''
                }))).then(list => { if (list.length) { store[ck] = { at: Date.now(), v: list }; saveStore(); } return list; });
            return Promise.all([base, lookup]).then(r => annotateRecasts(r[0].map(p => Object.assign({}, p)), r[1], real));
        }
        return Promise.resolve([]);
    }

    /* TVmaze merges revivals and recasts into one show cast (e.g. a 1970s sitcom with a one-off revival: the original cast and the
       2016 special's cast, two actors per role). When several actors share a character and one of them is in
       Plex's cast for the show (the main cast), the others are marked with a note ("2016 special" / "2016 revival",
       from a gap of 8+ years in the episode dates, else "recast") and listed after the main cast. */
    const norm = x => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    function revivalOf(eps) {
        const dated = (eps || []).filter(e => e.airdate).sort((a, b) => (a.airdate < b.airdate ? -1 : 1));
        for (let i = 1; i < dated.length; i++) {
            if (Date.parse(dated[i].airdate) - Date.parse(dated[i - 1].airdate) > 8 * 365 * DAY) {
                return { year: dated[i].airdate.slice(0, 4), count: dated.length - i };
            }
        }
        return null;
    }
    function annotateRecasts(list, tvmazeId, real) {
        const byChar = {};
        list.forEach(p => { const k = norm(p.character); if (k) { (byChar[k] = byChar[k] || []).push(p); } });
        const shared = Object.keys(byChar).filter(k => byChar[k].length > 1);
        if (!shared.length || typeof Plex === 'undefined' || !Plex.configured()) { return Promise.resolve(list); }
        return Promise.all([
            Plex.findItem('tv', real).then(show => (show ? Plex.api('GET', '/library/metadata/' + show.ratingKey)
                .then(d => (((d.MediaContainer && d.MediaContainer.Metadata) || [])[0] || {}).Role || []) : [])).catch(() => []),
            tvmazeId ? remember('rv:' + tvmazeId, 30 * DAY, () => tvmaze('/shows/' + tvmazeId + '/episodes?specials=1').then(revivalOf)).catch(() => null) : null
        ]).then(r => {
            const main = {};
            r[0].forEach(x => { main[norm(x.tag)] = true; });
            if (!Object.keys(main).length) { return list; }
            const note = r[1] ? r[1].year + (r[1].count === 1 ? ' special' : ' revival') : 'recast';
            shared.forEach(k => {
                const group = byChar[k];
                if (!group.some(p => main[norm(p.name)])) { return; }
                group.forEach(p => { if (!main[norm(p.name)]) { p.note = note; } });
            });
            return list.filter(p => !p.note).concat(list.filter(p => p.note));
        });
    }

    /* ---------------- filmography ---------------- */

    function filmography(p) {
        if (!p.qid) { return Promise.resolve({ movies: [], shows: [] }); }
        return remember('f:' + p.qid, 7 * DAY, () => sparql('SELECT ?w ?tmdbMovie ?tvdb ?date WHERE { ?w wdt:P161 wd:' + p.qid + '. ' +
            'OPTIONAL { ?w wdt:P4947 ?tmdbMovie. } OPTIONAL { ?w wdt:P4835 ?tvdb. } OPTIONAL { ?w wdt:P577 ?date. } }').then(rows => {
            const movieDates = {}, showIds = [];
            rows.forEach(b => {
                const d = b.date ? Date.parse(b.date.value) || 0 : 0;
                if (b.tmdbMovie) { const id = b.tmdbMovie.value; movieDates[id] = Math.max(movieDates[id] || 0, d); }
                else if (b.tvdb && showIds.indexOf(b.tvdb.value) === -1) { showIds.push(b.tvdb.value); }
            });
            const movieIds = Object.keys(movieDates).sort((a, b) => movieDates[b] - movieDates[a]).slice(0, MAX_FILMS).map(Number);
            const now = Date.now();
            // Movie details in bulk from Radarr's metadata (50 per request), kept newest first.
            const chunks = [];
            for (let i = 0; i < movieIds.length; i += 50) { chunks.push(movieIds.slice(i, i + 50)); }
            const movies = Promise.all(chunks.map(c => soft(request('POST', RADARR_LISTS + '/v1/movie/bulk', c)))).then(parts => {
                const byId = {};
                parts.forEach(list => (list || []).forEach(m => { byId[m.TmdbId] = m; }));
                return movieIds.filter(id => byId[id]).map(id => Object.assign(Feeds.movieDesc(byId[id], now), { kind: 'movie' }));
            });
            // Show details from TVmaze, one lookup per show (TVmaze is rate limited, so keep it to 20).
            const shows = Promise.all(showIds.slice(0, 20).map(tvdb => soft(tvmaze('/lookup/shows?thetvdb=' + tvdb)))).then(list => list.filter(Boolean).map(s => ({
                key: 'tvdb:' + s.externals.thetvdb, src: 'tvdb', ref: s.externals.thetvdb, tvmaze: s.id, kind: 'tv', genres: s.genres || [],
                view: {
                    title: s.name,
                    meta: [s.premiered ? s.premiered.slice(0, 4) : '', (s.webChannel && s.webChannel.name) || (s.network && s.network.name) || '', (s.genres || []).slice(0, 2).join(', ')].filter(Boolean),
                    poster: s.image ? (s.image.medium || s.image.original) : '',
                    backdrop: '',
                    overview: stripHtml(s.summary)
                }
            })));
            // Shorter descriptions keep the saved copy small; the details pop-up loads the full text anyway.
            const trim = d => { d.view.overview = String(d.view.overview || '').slice(0, 300); return d; };
            return Promise.all([movies, shows]).then(r => ({ movies: r[0].map(trim), shows: r[1].map(trim) }));
        })).then(f => JSON.parse(JSON.stringify(f)));     // a fresh copy each time (hydrate shares view objects)
    }

    /* ---------------- default Actors page ---------------- */

    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const shortDate = t => { const d = new Date(t); return d.getDate() + ' ' + MONTHS[d.getMonth()] + (d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : ''); };
    const withPhoto = list => list.filter(p => p.photo).slice(0, 15);

    // Recently released movies (Radarr's TMDb lists already include the cast) and new TV series
    // (TVmaze premieres of the past week, cast fetched per show): [{title, date, kind, cast}], newest first.
    function recentTitles() {
        const now = Date.now();
        const movies = Promise.all([soft(get(RADARR_LISTS + '/v1/list/tmdb/trending')), soft(get(RADARR_LISTS + '/v1/list/tmdb/popular'))]).then(lists => {
            const seen = {}, out = [];
            (lists[0] || []).concat(lists[1] || []).forEach(m => {
                if (seen[m.TmdbId]) { return; }
                seen[m.TmdbId] = true;
                // Released = in cinemas or out digitally already; the latest of those counts as its release date.
                const dates = [m.InCinema, m.DigitalRelease].map(d => (d ? Date.parse(d) : NaN)).filter(d => d <= now);
                if (!dates.length) { return; }
                const cast = withPhoto(((m.Credits && m.Credits.Cast) || []).map(c => {
                    const img = ((c.Images || [])[0] || {}).Url;
                    return { name: c.Name, character: c.Character, tmdb: c.TmdbId, photo: img ? tmdbSize(img, 'w342') : '', photoFull: img ? tmdbSize(img, 'h632') : '' };
                }));
                if (cast.length >= 3) { out.push({ title: m.Title, date: Math.max.apply(null, dates), kind: 'movie', cast }); }
            });
            return out;
        });
        const days = [0, 1, 2, 3, 4, 5, 6].map(i => new Date(now - i * 86400000).toISOString().slice(0, 10));
        const shows = Promise.all(days.map(d => soft(tvmaze('/schedule/web?date=' + d)))).then(lists => {
            const seen = {}, picks = [];
            lists.forEach(list => (list || []).forEach(ep => {
                const show = ep._embedded && ep._embedded.show;
                if (!show || ep.number !== 1 || seen[show.id] || show.language !== 'English' || !show.image) { return; }
                if (['News', 'Sports', 'Talk Show', 'Game Show', 'Reality'].indexOf(show.type) !== -1) { return; }
                seen[show.id] = true;
                picks.push({ show, date: Date.parse(ep.airstamp || ep.airdate) || now, season: ep.season });
            }));
            // The most followed premieres (TVmaze weight), at most 8, to stay inside TVmaze's rate limit.
            picks.sort((a, b) => (b.show.weight || 0) - (a.show.weight || 0));
            return Promise.all(picks.slice(0, 8).map(pk => soft(tvmaze('/shows/' + pk.show.id + '/cast')).then(list => ({
                title: pk.show.name + (pk.season > 1 ? ' · Season ' + pk.season : ''), date: pk.date, kind: 'tv',
                cast: withPhoto((list || []).map(c => ({ name: c.person.name, character: c.character && c.character.name, tvmaze: c.person.id,
                    photo: c.person.image ? (c.person.image.medium || c.person.image.original) : '',
                    photoFull: c.person.image ? (c.person.image.original || c.person.image.medium) : '' })))
            })))).then(list => list.filter(t => t.cast.length >= 3));
        });
        return Promise.all([movies, shows]).then(r => r[0].concat(r[1]).sort((a, b) => b.date - a.date).slice(0, 20));
    }

    // Rows for the Actors screen: the top 5 billed leads of each new movie / series, mixed together and
    // each person once (under their newest title), newest release first, grouped by how recent it is.
    function recent() {
        return remember('home', 12 * 60 * 60 * 1000, recentTitles).then(titles => {
            const seen = {}, people = [];
            titles.forEach(t => t.cast.slice(0, 5).forEach((p, rank) => {
                const id = p.tmdb ? 't' + p.tmdb : 'n' + String(p.name).toLowerCase();
                if (seen[id]) { return; }
                seen[id] = true;
                people.push({ p: Object.assign({}, p, { known: t.title }), date: t.date, rank });
            }));
            const now = Date.now(), DAY_MS = 86400000;
            const groups = [
                { title: 'In new releases this week', test: d => now - d < 7 * DAY_MS },
                { title: 'In last week’s releases', test: d => now - d >= 7 * DAY_MS && now - d < 14 * DAY_MS },
                { title: 'In recent releases', test: d => now - d >= 14 * DAY_MS }
            ];
            // Mixed across titles: every title's top-billed lead first (newest title first), then every second lead, and so on.
            return groups.map(g => ({
                title: g.title,
                items: people.filter(x => g.test(x.date)).sort((a, b) => a.rank - b.rank || b.date - a.date).map(x => card(x.p))
            })).filter(r => r.items.length);
        });
    }

    /* Biography for a person card: resolves their Wikidata entry, then fills the card's text. Cached on the card. */
    function details(item) {
        if (!item._details) {
            item._details = resolve(item._person).then(full => biography(full).then(bio => {
                const p = Object.assign(item._person, full, { name: item._person.name || full.name, bio: bio.bio, photoFull: item._person.photoFull || bio.image || full.photoFull });
                if (!p.photo) { p.photo = bio.image || full.photo; }
                item.view.overview = p.bio;
                if (!item.view.poster && p.photo) { item.view.poster = p.photo; item.view.backdrop = p.photoFull || p.photo; }
                if (p.description && item.view.meta.indexOf(p.description) === -1) { item.view.meta.push(p.description); }
                return p;
            }));
            item._details.catch(() => { item._details = null; });
        }
        return item._details;
    }

    /* Their movies and TV shows as browse rows (newest first). Cached on the card. */
    function works(item) {
        if (!item._works) {
            item._works = details(item).then(filmography).then(f => {
                const rows = [];
                if (f.movies.length) { rows.push({ title: 'Movies', items: f.movies }); }
                if (f.shows.length) { rows.push({ title: 'TV shows', items: f.shows }); }
                return Feeds.hydrate(rows);
            });
            item._works.catch(() => { item._works = null; });
        }
        return item._works;
    }

    return {
        search: name => search(name).then(list => list.map(card)),
        cast: (kind, real, item) => cast(kind, real, item).then(list => list.map(card)),
        details,
        photo,
        works,
        recent
    };
}());
