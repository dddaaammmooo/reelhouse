/* Reelhouse (formerly MediaLoader) — screens, search, one-step downloads and a unified download queue. */
(function () {
    'use strict';

    const $ = id => document.getElementById(id);
    const svc = kind => Api.services[kind];
    // 'people' is the Actors screen: no *arr app behind it, its rows mix movies and shows (each item has .kind).
    const kindLabel = kind => (kind === 'people' ? 'Actors' : svc(kind).label);
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const cssUrl = u => (u ? 'url("' + String(u).replace(/"/g, '%22') + '")' : 'none');
    const pct = p => Math.round(p * 100) + '%';
    const icon = kind => (document.querySelector('.rail-item[data-kind="' + kind + '"] svg') || {}).outerHTML || '';
    // Card shown when a title has no poster: icon + title, sized by length so it always fits with padding.
    function placeholder(kind, title) {
        const t = String(title || 'Untitled');
        const size = t.length <= 18 ? 22 : t.length <= 32 ? 20 : t.length <= 50 ? 18 : 16;
        return '<div class="ph">' + icon(kind) + '<span class="ph-title" style="font-size:' + size + 'px">' + esc(t) + '</span></div>';
    }
    // Interface preferences (Settings › Preferences), saved straight away.
    const UI_KEY = 'medialoader.ui';
    const ui = { plexApp: false, libraryFirst: true, themeMusic: true, themeVolume: 50 };   // themeVolume: % of the original level   // "Plex app" button off; titles you have first in rows
    try { Object.assign(ui, JSON.parse(localStorage.getItem(UI_KEY) || '{}')); } catch (e) { /* defaults */ }
    const saveUi = () => { try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch (e) { /* not saved */ } };
    const CHECK = '<svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 19h16"/></svg>';

    const state = {
        screen: null,
        kind: 'tv',
        search: { tv: { term: '', results: [] }, movie: { term: '', results: [] }, music: { term: '', results: [] }, people: { term: '', results: [] } },
        queue: [],
        queueErrors: [],
        queueLoaded: false,
        armed: null,
        armTimer: null,
        searchSeq: 0,
        liveTimer: null,
        pollTimer: null
    };

    /* ===================== small UI helpers ===================== */

    let toastTimer = null;
    function toast(text, type) {
        const t = $('toast');
        t.textContent = text;
        t.className = 'toast show' + (type ? ' ' + type : '');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { t.className = 'toast' + (type ? ' ' + type : ''); }, 4000);
    }

    function el(tag, cls, html) {
        const e = document.createElement(tag);
        if (cls) { e.className = cls; }
        if (html !== undefined) { e.innerHTML = html; }
        return e;
    }

    /* Keyed list update: reuses existing nodes so progress bars animate and focus survives refreshes. */
    function syncList(container, items, create, update) {
        const existing = {};
        Array.prototype.forEach.call(container.children, n => { if (n._key) { existing[n._key] = n; } });
        const keep = {};
        items.forEach((item, i) => {
            let node = existing[item.key];
            if (!node) { node = create(item); node._key = item.key; node.style.animationDelay = Math.min(i, 8) * 40 + 'ms'; }
            update(node, item);
            keep[item.key] = true;
            if (container.children[i] !== node) { container.insertBefore(node, container.children[i] || null); }
        });
        Object.keys(existing).forEach(k => {
            if (keep[k]) { return; }
            const node = existing[k];
            if (node === Nav.current()) {
                const next = node.nextElementSibling || node.previousElementSibling;
                container.removeChild(node);
                if (next) { Nav.focus(next); } else { Nav.focusFirst(); }
            } else {
                container.removeChild(node);
            }
        });
    }

    /* ===================== screens ===================== */

    function show(name, kind, navKey) {
        const next = $('screen-' + name);
        const prev = document.querySelector('.screen.active');
        if (prev && prev !== next) {
            prev.classList.remove('active');
            prev.classList.add('leaving');
            setTimeout(() => prev.classList.remove('leaving'), 520);
        }
        next.classList.remove('leaving');
        next.classList.add('active');
        state.screen = name;
        disarm();

        const items = document.querySelectorAll('.rail-item');
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            const match = navKey ? it.getAttribute('data-nav') === navKey
                : it.getAttribute('data-nav') === name && (name !== 'search' || it.getAttribute('data-kind') === kind);
            it.classList.toggle('current', match);
        }
        schedulePoll(0);
    }

    /* TV Shows is the start screen: Back from anywhere else returns to it, Back on TV Shows exits. */
    const START_KIND = 'tv';

    function goStart() {
        openSearch(START_KIND);
    }

    /* Back: closes a pop-up; otherwise opens the side menu on the current screen.
       From the side menu: goes to TV Shows, or exits the app when already there. */
    function back() {
        if (closeBrowse() || closeArt() || closeSeason() || closeText() || closeDetails() || closePerson() || closeInfo() || closePicker()) { return; }
        if (state.keyboard && !Nav.inRail()) { closeKeyboard(true); return; }
        // Back on search results clears the search and brings the category rows back.
        const sr = state.screen === 'search' && !state.dlMode && state.search[state.kind];
        if (sr && sr.term && !sr.similar && !Nav.inRail()) {
            $('search-input').value = '';
            runSearch(false);
            Nav.focus(firstCard() || $('search-input'));
            return;
        }
        const onSimilar = state.screen === 'search' && !state.dlMode && state.search[state.kind].similar;
        if (onSimilar && !Nav.inRail()) { exitSimilar(); return; }
        if (!Nav.inRail()) { Nav.focusRail(); return; }
        const onStart = state.screen === 'search' && !state.dlMode && state.kind === START_KIND && !onSimilar;
        // If TV Shows isn't set up yet, Settings is effectively the start screen.
        const stuckInSetup = state.screen === 'settings' && !Api.configured(START_KIND);
        if (!onStart && !stuckInSetup) { goStart(); return; }
        try { tizen.application.getCurrentApplication().exit(); } catch (e) { /* not on a TV */ }
    }

    /* ===================== status helpers ===================== */

    const inLibrary = item => !!(item.id && item.id > 0);

    function queueStatus(q) {
        return { state: q.state, label: q.state === 'downloading' ? 'Downloading ' + pct(q.progress) : q.label, progress: q.progress };
    }

    function statusFor(kind, item) {
        if (inLibrary(item)) {
            const recs = state.queue.filter(q => q.kind === kind && q.mediaId === item.id);
            if (recs.length) {
                recs.sort((a, b) => b.progress - a.progress);
                const s = queueStatus(recs[0]);
                if (recs.length > 1) { s.label += ' · ' + recs.length + ' items'; }
                return s;
            }
        }
        if (item._searching) { return { state: 'searching', label: 'Searching…' }; }
        if (item._disk && item._disk.available) { return { state: 'ondisk', label: 'On disk' }; }
        if (inLibrary(item)) { return { state: 'library', label: 'In library' }; }
        return null;
    }

    function statusHtml(s) {
        if (!s) { return ''; }
        const bar = s.progress !== undefined && (s.state === 'downloading' || s.state === 'importing')
            ? '<div class="bar"><i style="width:' + pct(s.progress) + '"></i></div>' : '';
        return '<div class="status ' + s.state + '"><span class="dot"></span>' + esc(s.label) + bar + '</div>';
    }

    /* ===================== search & category rows ===================== */

    // Rows shown under the hero: one "Results" row while searching, otherwise the category rows.
    function rowsOf(kind) {
        const s = state.search[kind];
        if (s.similar) { return s.similar.rows; }
        if (s.term) { return s.done && s.results.length ? [{ title: 'Results for “' + s.term + '”', items: s.results }] : []; }
        const feed = s.feed || [];
        const top = [];
        if (s.recent && s.recent.length) { top.push({ title: 'Recently played', items: s.recent, recent: true }); }
        if (s.recent && s.recent.length && s.recentSimilar && s.recentSimilar.length) {
            top.push({ title: 'Similar to recently played', items: s.recentSimilar, recent: true });
        }
        return top.concat(feed);
    }

    /* ---- Recently played: kept by Reelhouse itself (localStorage), from what you play here, merged with
       Plex's watch history (so things watched elsewhere appear too). Newest first, 20 per kind. ---- */
    const RECENT_KEY = 'medialoader.recent';
    const RECENT_KINDS = ['tv', 'movie', 'music'];
    let recentStore = (() => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '{}') || {}; } catch (e) { return {}; } })();
    const saveRecent = () => { try { localStorage.setItem(RECENT_KEY, JSON.stringify(recentStore)); } catch (e) { /* not saved */ } };
    const recentKey = (src, ref) => src + ':' + String(ref).toLowerCase();

    // A saved, feed-style description of a title (enough to rebuild its card and look it up again).
    function recentDesc(kind, item) {
        const v = viewOf(kind, item);
        let src, ref;
        if (item._feed && item.src) { src = item.src; ref = item.ref; }
        else if (kind === 'movie') { src = item.tmdbId ? 'tmdb' : 'movieTitle'; ref = item.tmdbId || item.title; }
        else if (kind === 'tv') { src = item.tvdbId ? 'tvdb' : 'seriesTitle'; ref = item.tvdbId || item.title; }
        else { src = 'artist'; ref = item.artistName || (item.artist && item.artist.artistName) || v.title; }
        return { key: recentKey(src, ref), src, ref, year: item.year, tvmaze: item.tvmaze || item.tvMazeId, kind, genres: item.genres || [],
            view: { title: v.title, meta: (v.meta || []).slice(0, 3), poster: v.poster || '', backdrop: v.backdrop || '', overview: String(v.overview || '').slice(0, 400) } };
    }

    function plexRecentDesc(kind, m) {
        const guid = scheme => ((m.Guid || []).map(g => g.id).filter(id => id.indexOf(scheme + '://') === 0)[0] || '').split('//')[1];
        let src, ref;
        if (kind === 'movie') { ref = guid('tmdb'); src = ref ? 'tmdb' : 'movieTitle'; ref = ref ? +ref : m.title; }
        else if (kind === 'tv') { ref = guid('tvdb'); src = ref ? 'tvdb' : 'seriesTitle'; ref = ref ? +ref : m.title; }
        else { src = 'artist'; ref = m.title; }
        return { key: recentKey(src, ref), src, ref, year: m.year, kind, genres: (m.Genre || []).map(g => g.tag), at: (m.lastViewedAt || 0) * 1000,
            view: { title: m.title, meta: [m.year ? String(m.year) : ''].filter(Boolean),     // "Watched …" is added when shown
                poster: Plex.photo(m.thumb, 342, 513), backdrop: m.art ? Plex.photo(m.art, 1280, 720) : '', overview: String(m.summary || '').slice(0, 400) } };
    }

    function mergeRecent(kind, list) {
        const byKey = {};
        (recentStore[kind] || []).concat(list).forEach(d => {
            const old = byKey[d.key];
            if (!old) { byKey[d.key] = d; return; }
            // Keep the saved card (its artwork matches the rest of the app) with the newest time.
            byKey[d.key] = Object.assign({}, old.src ? old : d, { at: Math.max(old.at || 0, d.at || 0) });
        });
        recentStore[kind] = Object.keys(byKey).map(k => byKey[k]).sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 20);
        saveRecent();
        showRecent(kind);
        loadSimilarToRecent(kind);
    }

    /* "Similar to recently played": suggestions for the 3 most recently played titles (same sources as the
       Similar button), mixed together (each title's best match first), without anything already in
       Recently played. Saved for 12 hours; rebuilt in the background when Recently played changes. */
    const SIM_TTL = 12 * 60 * 60 * 1000;
    const simBusy = {};
    function loadSimilarToRecent(kind) {
        const s = state.search[kind];
        const recent = (recentStore[kind] || []).slice(0, 3);
        if (!recent.length || !Api.configured(kind)) { s.recentSimilar = []; return; }
        const sig = recent.map(d => d.key).join('|');
        const saved = recentStore['similar_' + kind];
        if (saved && saved.sig === sig && Date.now() - saved.at < SIM_TTL) {
            if (!s.recentSimilar || s.recentSimilarSig !== sig) {
                s.recentSimilar = Feeds.hydrate([{ title: '', items: saved.items }])[0].items;
                s.recentSimilarSig = sig;
                showRecent(kind);
            }
            return;
        }
        if (simBusy[kind] === sig) { return; }
        simBusy[kind] = sig;
        whenIdle(() => {
            const items = Feeds.hydrate([{ title: '', items: recent }])[0].items;
            Promise.all(items.map(it => lookupOf(it).then(real => Feeds.similar(kind, real, it, [])).then(rows => (rows[0] && rows[0].items) || [], () => [])))
                .then(lists => {
                    const exclude = {};
                    (recentStore[kind] || []).forEach(d => { exclude[d.key] = true; });
                    const out = [], seen = {};
                    for (let i = 0; out.length < 20 && lists.some(l => l.length > i); i++) {
                        lists.forEach(l => {
                            const it = l[i];
                            if (!it || out.length >= 20) { return; }
                            const k = it.src && it.ref != null ? recentKey(it.src, it.ref) : it.key;
                            if (exclude[k] || seen[k]) { return; }
                            seen[k] = true;
                            out.push({ key: it.key, src: it.src, ref: it.ref, year: it.year, tvmaze: it.tvmaze, kind, genres: it.genres || [],
                                view: Object.assign({}, it.view, { overview: String(it.view.overview || '').slice(0, 400) }) });
                        });
                    }
                    simBusy[kind] = null;
                    recentStore['similar_' + kind] = { sig, at: Date.now(), items: out };
                    saveRecent();
                    s.recentSimilar = Feeds.hydrate([{ title: '', items: out }])[0].items;
                    s.recentSimilarSig = sig;
                    showRecent(kind);
                });
        }, 1500);
    }

    // Something was played from Reelhouse: it goes to the front of that kind's Recently played row.
    function rememberPlayed(kind, item) {
        if (RECENT_KINDS.indexOf(kind) === -1 || !item) { return; }
        const d = recentDesc(kind, item);
        d.at = Date.now();
        mergeRecent(kind, [d]);
    }

    function showRecent(kind) {
        const s = state.search[kind];
        s.recent = (recentStore[kind] || []).length ? Feeds.hydrate([{ title: '', items: recentStore[kind] }])[0].items : [];
        // "Watched …" from the latest play (yours here or Plex's history), worked out now rather than saved: a saved
        // label went stale, and Plex only updates its time when you finish something.
        s.recent.forEach((it, i) => {
            const at = recentStore[kind][i] && recentStore[kind][i].at;
            it.view.meta = (it.view.meta || []).filter(x => !/^Watched /.test(x)).concat(at ? ['Watched ' + ago(at)] : []);
        });
        // Refresh the screen only if you're on it and haven't moved off the first poster (so nothing jumps under you).
        const onScreen = state.kind === kind && state.screen === 'search' && !state.dlMode && !s.similar && !s.term;
        const cur = Nav.current();
        if (onScreen && (!cur || cur === firstCard() || cur === $('search-input') || !isCard(cur))) {
            const wasFirst = cur === firstCard();
            renderRows();
            if (wasFirst && firstCard()) { Nav.focus(firstCard()); }
        }
    }

    function loadRecent() {
        RECENT_KINDS.forEach(kind => {
            if (recentStore[kind] && recentStore[kind].length) {
                state.search[kind].recent = Feeds.hydrate([{ title: '', items: recentStore[kind] }])[0].items;
                const saved = recentStore['similar_' + kind];
                if (saved && saved.items) { state.search[kind].recentSimilar = Feeds.hydrate([{ title: '', items: saved.items }])[0].items; }
            }
            if (Plex.configured()) { Plex.recentlyPlayed(kind).then(list => { if (list.length) { mergeRecent(kind, list.map(m => plexRecentDesc(kind, m))); } }); }
        });
    }

    /* Titles you already have first in each row, ones still to download after them (Preferences › In library first).
       Uses what's known when the row is drawn, so cards never shuffle while you're looking at them. */
    function libraryFirst(items) {
        const owned = it => {
            if (inLibrary(it)) { return true; }
            const c = it._feed && libCache[kindOf(it) + '|' + it.key];
            // Any earlier check counts here (even past the 6-hour refresh): whether you have a title rarely changes.
            if (c && c.hit && c.hit.id > 0) { it.id = c.hit.id; return true; }
            return false;
        };
        return items.map((it, i) => ({ it, i, o: owned(it) ? 0 : 1 })).sort((a, b) => a.o - b.o || a.i - b.i).map(x => x.it);
    }
    const viewOf = (kind, item) => (item._feed ? item.view : svc(kind).view(item));
    const kindOf = item => (item && item.kind) || state.kind;
    const isCard = node => !!(node && node.classList && node.classList.contains('card') && node.closest('#results-rows'));
    const firstCard = () => $('results-rows').querySelector('.card');

    function openSearch(kind) {
        if (kind !== 'people' && !Api.configured(kind)) {
            toast(svc(kind).app + ' isn’t connected yet — add its API key', 'err');
            openSettings(kind);
            return;
        }
        const switching = state.kind !== kind || state.screen !== 'search' || state.dlMode || !!state.search[kind].similar;
        state.kind = kind;
        state.dlMode = false;
        const s = state.search[kind];
        s.similar = null;
        state.heroCard = null;
        $('search-input').value = s.term;
        $('search-input').placeholder = 'Search ' + kindLabel(kind);
        if (s.pendingFeed) { s.feed = s.pendingFeed; s.pendingFeed = null; }
        show('search', kind);
        loadFeed(kind);                      // fills s.feed from the saved copy straight away
        if (switching) { renderRows(); }

        // Start on the first poster. If rows haven't arrived yet, wait on the search box and
        // move to the first poster when they do (unless you've started doing something else).
        if (firstCard()) { state.autoFocus = null; Nav.focus(firstCard()); }
        else { state.autoFocus = kind; Nav.focus($('search-input')); setHero(heroForSearchBox()); }
    }

    /* Saved rows show instantly; fresh ones are fetched in the background when the saved copy is
       over 30 minutes old. Fresh rows only replace what's on screen if you haven't started browsing. */
    const FEED_FRESH = 30 * 60 * 1000;

    function loadFeed(kind) {
        if (kind === 'people') { loadActors(); return; }
        const s = state.search[kind];
        if (!s.feed) {
            const saved = Feeds.cached(kind);
            if (saved) { s.feed = saved.rows; s.feedAt = saved.at; warmImages(saved.rows); }
        }
        if ((s.feed && Date.now() - s.feedAt < FEED_FRESH) || s.feedLoading) { return; }
        if (state.booting && s.feed) { return; }          // refreshed by afterBoot()
        s.feedLoading = true;
        Feeds.load(kind).then(rows => {
            s.feedAt = Date.now(); s.feedError = null;
            const onScreen = state.kind === kind && state.screen === 'search' && !state.dlMode && !s.similar && !s.term;
            // Fresh rows never replace the screen you're looking at (that froze navigation for a moment just
            // after start-up); they're used next time the screen opens, or straight away if it had no rows.
            const untouched = !s.feed || !onScreen;
            whenIdle(() => { warmImages(rows); preloadAllArt(); });
            if (untouched && !Nav.isEditing() && !state.info) {
                s.feed = rows;
                if (onScreen) { renderRows(); }
            } else {
                s.pendingFeed = rows;        // applied next time this screen opens
            }
        }, err => {
            if (!s.feed) { s.feedError = err.message; }
        }).then(() => {
            s.feedLoading = false;
            if (state.kind === kind && state.screen === 'search' && !state.dlMode && !s.similar && !s.term && !firstCard()) { renderRows(); }
        });
    }

    // Actors: cast of recent movies and new TV series, newest release first (saved for 12 hours).
    function loadActors() {
        const s = state.search.people;
        if (s.feed || s.feedLoading) { return; }
        s.feedLoading = true;
        People.recent().then(rows => { s.feed = rows; s.feedError = null; warmImages(rows); }, err => { s.feedError = err.message; }).then(() => {
            s.feedLoading = false;
            if (state.kind === 'people' && state.screen === 'search' && !state.dlMode && !s.similar && !s.term) { renderRows(); }
        });
    }

    // The title the hero previews when focus is on the search box or More info:
    // the last poster you highlighted, otherwise the first one.
    function previewCard() {
        const c = state.heroCard;
        return c && document.body.contains(c) ? c : firstCard();
    }
    function heroForSearchBox() {
        const c = previewCard();
        return c ? heroFor(c) : introHero();
    }

    // Fetch the first posters (and the first backdrop) of a screen ahead of time so it opens without pop-in.
    function warmImages(rows) {
        rows.slice(0, 2).forEach((row, r) => row.items.slice(0, 10).forEach((it, i) => {
            const v = it.view || {};
            if (v.poster) { new Image().src = v.poster; }
            if (r === 0 && i === 0 && v.backdrop) { new Image().src = heroImage(v.backdrop); }
        }));
    }

    function introHero() {
        if (state.dlMode) {
            return { title: state.queueLoaded ? 'Nothing downloading' : 'Downloads',
                meta: state.queueLoaded ? ['Anything you add from TV Shows, Movies or Music shows up here.'] : [] };
        }
        const s = state.search[state.kind];
        if (s.term && s.done && s.error) { return { title: 'Search failed', overview: s.error }; }
        if (s.term && s.done && !s.results.length) {
            return { title: 'No matches', overview: 'Nothing found for “' + s.term + '”. Try a different spelling or fewer words.' };
        }
        let meta = [];
        if (s.term && s.results.length) { meta = [s.results.length + (s.results.length === 1 ? ' result' : ' results') + ' for “' + s.term + '”']; }
        else if (!s.term && s.feed && s.feed.length) { meta = [Feeds.summary(state.kind)]; }
        if (state.kind === 'people' && !s.term) {
            return { title: 'Actors', meta: s.feed && s.feed.length ? ['The cast of new movies and TV series'] : [],
                overview: 'Search for an actor to see every movie and TV show they’re in.' };
        }
        return { title: kindLabel(state.kind), meta };
    }

    function runSearch(focusResults) {
        clearTimeout(state.liveTimer);
        const kind = state.kind;
        const term = $('search-input').value.trim();
        const s = state.search[kind];
        if (!term) {
            if (s.term) { s.term = ''; s.results = []; s.done = false; s.error = null; renderRows(); }
            if (focusResults && firstCard()) { Nav.focus(firstCard()); }
            return;
        }
        if (term === s.term && s.done) {
            if (focusResults && firstCard()) { Nav.focus(firstCard()); }
            return;
        }
        const seq = ++state.searchSeq;
        $('search-spinner').classList.remove('hidden');
        (kind === 'people' ? People.search(term) : Api.search(kind, term)).then(items => {
            if (seq !== state.searchSeq) { return; }
            Object.assign(s, { term, results: (items || []).slice(0, 40), done: true, error: null });
            renderRows();
            if (focusResults && firstCard()) { Nav.focus(firstCard()); }
        }, err => {
            if (seq !== state.searchSeq) { return; }
            Object.assign(s, { term, results: [], done: true, error: err.message });
            renderRows();
            toast(err.message, 'err');
        }).then(() => { if (seq === state.searchSeq) { $('search-spinner').classList.add('hidden'); } });
    }

    function liveSearch() {
        clearTimeout(state.liveTimer);
        // Actor search goes to Wikidata, which rate-limits: wait for a longer pause and at least 3 letters.
        const people = state.kind === 'people';
        const len = $('search-input').value.trim().length;
        if (people && len > 0 && len < 3) { return; }
        state.liveTimer = setTimeout(() => runSearch(false), people ? 1200 : 650);
    }

    /* ---- Search keyboard: an alphabetical letter grid under the search box (like Plex's), used instead
       of the TV's own keyboard. Results update as you type; Down from the grid goes to them. ---- */
    const KB_KEYS = 'abcdefghijklmnopqrstuvwxyz1234567890'.split('');

    function buildKeyboard() {
        const kb = $('kb');
        kb.innerHTML = KB_KEYS.map(k => '<button class="kb-key focusable" type="button" data-k="' + k + '">' + k + '</button>').join('') +
            '<button class="kb-key wide focusable" type="button" data-k=" ">Space</button>' +
            '<button class="kb-key wide focusable" type="button" data-k="del">⌫ Delete</button>' +
            '<button class="kb-key wide focusable" type="button" data-k="clear">Clear</button>';
        kb.addEventListener('click', e => {
            const b = e.target.closest ? e.target.closest('.kb-key') : null;
            if (b) { state.kbLast = b; typeKey(b.getAttribute('data-k')); }   // reopening returns to the last key pressed
        });
    }

    function typeKey(k) {
        const input = $('search-input');
        if (k === 'del') { input.value = input.value.slice(0, -1); }
        else if (k === 'clear') { input.value = ''; }
        else if (k === ' ' && (!input.value || / $/.test(input.value))) { return; }
        else { input.value += k; }
        liveSearch();
    }

    function openKeyboard() {
        state.keyboard = true;
        $('screen-search').classList.add('typing');
        Nav.focus(state.kbLast && document.body.contains(state.kbLast) ? state.kbLast : $('kb').querySelector('.kb-key'));
    }

    function closeKeyboard(focusInput) {
        if (!state.keyboard) { return false; }
        state.keyboard = false;
        $('screen-search').classList.remove('typing');
        if (focusInput) { Nav.focus($('search-input')); }
        return true;
    }

    /* ---- Voice (Tizen voice control, not Bixby): screen names switch screens; other speech is searched for.
       Whether the TV passes speech to apps this way is still being tested on the user's TV; window.vcLog records it. ---- */
    const VOICE_SCREENS = { 'tv shows': 'tv', 'tv': 'tv', 'movies': 'movie', 'music': 'music', 'actors': 'people' };
    function setupVoice() {
        window.vcLog = [];
        try {
            if (typeof tizen === 'undefined' || !tizen.voicecontrol) { return; }
            const client = tizen.voicecontrol.getVoiceControlClient();
            const words = Object.keys(VOICE_SCREENS).concat(['downloads', 'settings', 'search', 'back']);
            client.setCommandList(words.map(w => new tizen.VoiceControlCommand(w, 'FOREGROUND')), 'FOREGROUND');
            client.addResultListener((event, list, result) => {
                window.vcLog.push({ event, result, at: Date.now() });
                const said = String(result || '').trim().toLowerCase();
                if (!said || event === 'REJECTED' && !said) { return; }
                if (VOICE_SCREENS[said]) { openSearch(VOICE_SCREENS[said]); return; }
                if (said === 'downloads') { openDownloads(); return; }
                if (said === 'settings') { openSettings(); return; }
                if (said === 'back') { back(); return; }
                if (said === 'search') { if (state.screen === 'search') { Nav.focus($('search-input')); openKeyboard(); } return; }
                voiceSearch(said);
            });
        } catch (e) { window.vcLog.push({ error: e.message }); }
    }

    function voiceSearch(text) {
        if (state.screen !== 'search' || state.dlMode || state.search[state.kind].similar) { openSearch(state.kind === 'people' ? 'people' : state.kind || 'tv'); }
        if (state.screen !== 'search') { return; }
        $('search-input').value = text.replace(/[^a-z0-9 ]/gi, '').toLowerCase();
        runSearch(true);
        toast('Searching for “' + text + '”');
    }

    // Page heading: the search box normally; a title on "similar" pages and on Downloads.
    function applyMode() {
        const s = state.search[state.kind];
        const title = state.dlMode ? 'Downloads' : (s.similar ? s.similar.title : '');
        $('screen-search').classList.toggle('titled', !!title);
        $('page-title-text').textContent = title;
        $('page-title-sub').innerHTML = state.dlMode ? downloadsSummary() : (s.similar ? esc(s.similar.sub || '') : '');
    }

    // full = build every row now (needed when returning to a card further down, e.g. leaving a Similar page).
    function renderRows(full) {
        if (state.dlMode) { renderDownloadRows(true); return; }
        applyMode();
        const kind = state.kind;
        const s = state.search[kind];
        const rows = ui.libraryFirst && RECENT_KINDS.indexOf(kind) !== -1 && !s.term && !s.similar
            ? rowsOf(kind).map(r => (r.recent ? r : { title: r.title, items: libraryFirst(r.items) })) : rowsOf(kind);
        const inner = $('results-rows');
        const hadFocusInRows = isCard(Nav.current());
        inner.innerHTML = '';
        inner.style.transform = 'translate3d(0,0,0)';
        inner.setAttribute('data-y', '0');

        // Nothing is shown while rows load; only a failure gets a message.
        const empty = !s.term && !rows.length && s.feedError ? 'Couldn’t load new releases (' + s.feedError + ')' : '';
        $('results-empty').textContent = empty;
        $('results-empty').classList.toggle('hidden', !empty);

        // Only the first rows are built now; the rest are added in small batches while you're not pressing
        // keys (building all 20-30 rows at once froze the TV for about half a second).
        const seq = ++renderSeq;
        const build = (row, r) => {
            const rowEl = el('div', 'row', '<h3 class="row-title"></h3><div class="row-viewport"><div class="row-track"></div></div>');
            rowEl.querySelector('.row-title').textContent = row.title;
            rowEl.style.animationDelay = Math.min(r, 4) * 70 + 'ms';
            const track = rowEl.querySelector('.row-track');
            row.items.forEach((item, i) => {
                const v = viewOf(kindOf(item), item);
                // Only the first rows animate in; hundreds of simultaneous card animations are heavy on a TV.
                const card = el('button', 'card focusable' + (r < 3 ? ' in' : '') + (item._person ? ' person' : ''));
                card._item = item;
                if (r < 3) { card.style.animationDelay = (r * 70 + Math.min(i, 8) * 45) + 'ms'; }
                card._poster = chosenArt(kindOf(item), item) || v.poster || '';   // applied when the row comes into view (loadRowArt)
                if (item._person) {
                    // People: photo on top, name and role underneath (same card size, so rows keep their spacing).
                    // Photo on top, name and role (up to 2 lines each) underneath.
                    card.innerHTML = '<div class="pwrap"><div class="pphoto">' + (v.poster ? '' : icon('people')) + '</div>' +
                        '<div class="pname"><b>' + esc(v.title) + '</b>' + ((item._person.known || item._person.character) ? '<span>' + esc((item._person.known || item._person.character) + (item._person.note ? ' · ' + item._person.note : '')) + '</span>' : '') + '</div></div>';
                } else {
                    card.innerHTML = (v.poster ? '' : placeholder(kindOf(item), v.title)) + (item._wideArt ? '<div class="wide-title">' + esc(v.title) + '</div>' : '') +
                        '<div class="st"></div><div class="ribbon"><span>In Library</span></div>';
                }
                card.addEventListener('click', () => openInfo(card));
                track.appendChild(card);
                updateCard(card);
            });
            inner.appendChild(rowEl);
        };
        const firstCount = full === true ? rows.length : FIRST_ROWS;
        rows.slice(0, firstCount).forEach(build);
        let next = firstCount;
        const more = () => {
            if (seq !== renderSeq || next >= rows.length) { return; }
            if (Date.now() - lastKeyAt < 250) { setTimeout(more, 150); return; }   // you're navigating: wait
            rows.slice(next, next + 3).forEach((row, i) => build(row, next + i));
            next += 3;
            setTimeout(more, 30);
        };
        setTimeout(more, 60);

        // Posters and library ribbons load row by row: the first rows now, the rest as you scroll to them.
        Array.prototype.slice.call(inner.children, 0, 3).forEach(loadRowArt);

        const first = firstCard();
        if (hadFocusInRows || (state.autoFocus === kind && Nav.current() === $('search-input') && !Nav.isEditing())) {
            state.autoFocus = null;
            if (first) { Nav.focus(first); } else { Nav.focus($('search-input')); }
        }
        if (Nav.current() === $('search-input') || state.keyboard) { setHero(heroForSearchBox()); }
    }

    const itemOf = card => card._item;
    const FIRST_ROWS = 4;
    let renderSeq = 0;

    /* Keeping navigation responsive: background work waits until the remote has been quiet for a moment. */
    let lastKeyAt = 0;
    function whenIdle(fn, quietMs) {
        const quiet = quietMs || 700;
        const go = () => {
            const wait = quiet - (Date.now() - lastKeyAt);
            if (wait > 0) { setTimeout(go, wait); } else { fn(); }
        };
        setTimeout(go, 0);
    }

    /* With 20-30 rows per screen, loading every poster (and checking every title's library status) at
       once would swamp the TV, so each row does it when it's about to come into view. */
    const ROW_FIRST = 12;          // posters loaded when a row comes into view; the rest load as you move along it
    function showPoster(c) {
        if (!c || !c._poster || c._posterShown === c._poster) { return; }
        c._posterShown = c._poster;
        (c.querySelector('.pphoto') || c).style.backgroundImage = cssUrl(c._poster);
    }
    function loadRowArt(rowEl) {
        if (!rowEl || rowEl._artLoaded) { return; }
        rowEl._artLoaded = true;
        const items = [];
        Array.prototype.forEach.call(rowEl.querySelectorAll('.card'), (c, i) => {
            if (i < ROW_FIRST) { showPoster(c); }
            if (c._item) { items.push(c._item); }
            if (c._item && !c._poster) { findArt(c._item); }        // no poster from the feed: look elsewhere
        });
        checkLibrary(items);
    }

    /* ---- Artwork fallbacks: a title with no poster from its feed (e.g. TVmaze has none for "Flickers") gets
       one from Sonarr / Radarr / Lidarr (TheTVDB / TMDb artwork), else from Plex. Looked up in the background,
       2 at a time, only while the remote is quiet; the cards and banner update when it's found. ---- */
    const artLookups = [];
    let artLookupsActive = 0;
    function findArt(item) {
        if (!item || item._artTried || !item._feed || (!item.resolve && !item._person)) { return; }
        item._artTried = true;
        artLookups.push(item);
        pumpArtLookups();
    }
    function pumpArtLookups() {
        while (artLookupsActive < 2 && artLookups.length) {
            if (Date.now() - lastKeyAt < 700) { setTimeout(pumpArtLookups, 700); return; }
            const item = artLookups.shift(), kind = kindOf(item);
            artLookupsActive++;
            // People: a photo from TVmaze / Wikipedia / Wikidata (People.photo).
            const find = item._person
                ? People.photo(item._person).then(r => {
                    if (!r.photo) { return null; }
                    item._person.photo = r.photo; item._person.photoFull = r.photoFull;
                    return { poster: r.photo, backdrop: r.photoFull };
                })
                : lookupOf(item).then(real => {
                const v = svc(kind).view(real);
                if (v.poster) { return { poster: v.poster, backdrop: v.backdrop }; }
                const plex = Plex.configured() ? Plex.findItem(kind, real).catch(() => null) : Promise.resolve(null);
                return plex.then(m => {
                    if (m && m.thumb) { return { poster: Plex.photo(m.thumb, 342, 513), backdrop: m.art ? Plex.photo(m.art, 1280, 720) : '' }; }
                    // No poster anywhere (e.g. "The Well": TVmaze and TheTVDB only have a wide background): use the
                    // background, cropped to the card, with the title written on it.
                    const bgP = v.backdrop || item.view.backdrop ? Promise.resolve(v.backdrop || item.view.backdrop)
                        : (item.loadBackdrop ? item.loadBackdrop().catch(() => '') : Promise.resolve(''));
                    return bgP.then(bg => (bg ? { poster: Plex.configured() ? Plex.photo(bg, 342, 513) : bg, backdrop: item.view.backdrop || bg, wide: true } : null));
                });
            });
            find.then(art => {
                if (!art || !art.poster) { return; }
                item.view.poster = art.poster;
                if (art.wide) { item._wideArt = true; }
                if (!item.view.backdrop && art.backdrop) { item.view.backdrop = art.backdrop; }
                Array.prototype.forEach.call($('results-rows').querySelectorAll('.card'), c => {
                    if (c._item !== item) { return; }
                    c._poster = art.poster;
                    const ph = c.querySelector('.ph') || c.querySelector('.pphoto svg');
                    if (ph) { ph.parentNode.removeChild(ph); }
                    if (art.wide && !c.querySelector('.wide-title')) { c.insertAdjacentHTML('afterbegin', '<div class="wide-title">' + esc(item.view.title) + '</div>'); }
                    showPoster(c);
                    if (Nav.current() === c) { setHero(heroFor(c), true); }
                });
            }).catch(() => {}).then(() => { artLookupsActive--; pumpArtLookups(); });
        }
    }

    /* ---- Background artwork preloading: every row's posters (and the first few banner images per row) are
       downloaded one at a time at the lowest priority, pausing while keys are pressed or a video plays, so
       rows you reach later already have their artwork. Never blocks: one small request at a time. ---- */
    const preQueue = [], preSeen = {};
    let preBusy = false;
    function preloadArt(url) { if (url && !preSeen[url]) { preSeen[url] = true; preQueue.push(url); } }
    function pumpPreload() {
        if (preBusy || !preQueue.length || state.booting) { return; }
        if (Date.now() - lastKeyAt < 1500 || Player.isOpen()) { setTimeout(pumpPreload, 1000); return; }
        preBusy = true;
        const img = new Image();
        let done = false;
        const next = () => { if (done) { return; } done = true; preBusy = false; setTimeout(pumpPreload, 80); };
        img.onload = next; img.onerror = next;
        setTimeout(next, 8000);
        img.src = preQueue.shift();
    }
    // The screen you're on first, then the others.
    function preloadAllArt() {
        const kinds = [state.kind].concat(RECENT_KINDS.filter(k => k !== state.kind)).filter(k => RECENT_KINDS.indexOf(k) !== -1);
        kinds.forEach(kind => rowsOf(kind).forEach(row => row.items.forEach((it, i) => {
            const v = it.view || {};
            preloadArt(v.poster);
            if (i < 3 && v.backdrop) { preloadArt(heroImage(v.backdrop)); }
        })));
        pumpPreload();
    }
    // Moving along a row: load the posters up to 8 cards ahead.
    function loadAhead(card) {
        const cards = card.parentNode ? card.parentNode.children : [];
        const i = Array.prototype.indexOf.call(cards, card);
        for (let j = 0; j <= i + 8 && j < cards.length; j++) { showPoster(cards[j]); }
    }

    function updateCard(card) {
        const item = itemOf(card);
        if (!item) { return; }
        const s = statusFor(kindOf(item), item);
        const owned = inLibrary(item);
        // Corner banner: "Downloading" while it's on its way (searching, queued, downloading, importing), else "In Library".
        const downloading = !!(s && ['searching', 'queued', 'downloading', 'importing'].indexOf(s.state) !== -1);
        card.classList.toggle('dl', downloading);
        card.classList.toggle('in-lib', owned && !downloading);
        const rib = card.querySelector('.ribbon span');
        if (rib) { rib.textContent = downloading ? 'Downloading' : 'In Library'; }
        const st = card.querySelector('.st');            // people cards have no status
        if (st) { st.innerHTML = s && (s.state === 'library' || s.state === 'ondisk') ? '' : statusHtml(s); }
    }

    /* "In Library" ribbons for category rows: feed titles don't carry a library id, so check each
       one in the background (4 at a time), remembering results for 6 hours across launches. */
    const LIB_KEY = 'medialoader.library';
    const LIB_TTL = 6 * 60 * 60 * 1000;
    let libCache = (() => { try { return JSON.parse(localStorage.getItem(LIB_KEY) || '{}') || {}; } catch (e) { return {}; } })();
    let libSaveTimer = null;
    const saveLibCache = () => {
        clearTimeout(libSaveTimer);
        libSaveTimer = setTimeout(() => { try { localStorage.setItem(LIB_KEY, JSON.stringify(libCache)); } catch (e) { /* full */ } }, 1000);
    };
    let libQueue = [], libActive = 0;

    function applyLibrary(item, hit) {
        if (hit && hit.id > 0) {
            item.id = hit.id;
            if (!item._disk) { item._disk = { available: !!hit.hasFile, label: hit.hasFile ? 'On disk' : '' }; }
        }
        item._libChecked = true;
        Array.prototype.forEach.call($('results-rows').querySelectorAll('.card'), c => { if (c._item === item) { updateCard(c); } });
    }

    function checkLibrary(items) {
        const now = Date.now();
        items.forEach(item => {
            if (!item._feed || item._libChecked || item._libQueued || !item.src) { return; }
            const kind = kindOf(item);
            if (!Api.configured(kind)) { return; }
            const ck = kind + '|' + item.key;
            const c = libCache[ck];
            if (c && now - c.at < LIB_TTL) { applyLibrary(item, c.hit); return; }
            item._libQueued = true;
            libQueue.push({ item, kind, ck });
        });
        pumpLibrary();
    }

    function pumpLibrary() {
        if (state.booting) { return; }
        if (Date.now() - lastKeyAt < 700) { clearTimeout(pumpLibrary._t); pumpLibrary._t = setTimeout(pumpLibrary, 700); return; }
        while (libActive < 4 && libQueue.length) {
            const job = libQueue.shift();
            libActive++;
            Api.libraryMatch(job.item.src, job.item.ref, job.item.year).then(hit => {
                libCache[job.ck] = { at: Date.now(), hit: hit || null };
                saveLibCache();
                applyLibrary(job.item, hit);
            }, () => { job.item._libQueued = false; }).then(() => { libActive--; pumpLibrary(); });
        }
    }

    function updateAllCards() {
        if (state.screen !== 'search' || state.dlMode) { return; }
        const cards = $('results-rows').querySelectorAll('.card');
        for (let i = 0; i < cards.length; i++) { updateCard(cards[i]); }
        const cur = Nav.current();
        if (isCard(cur) || cur === $('hero-more') || cur === $('search-input')) { setHero(heroForSearchBox(), true); }
        if (state.info) { renderInfoStatus(); }
    }

    /* ---- hero (big preview of the focused title) ---- */

    function heroFor(card) {
        if (card._q) { return heroForQueue(card); }
        const item = itemOf(card);
        const kind = kindOf(item);
        const v = viewOf(kind, item);

        // A show you have: look up the episode Play will start once you've rested on it, so the details open ready.
        if (kind === 'tv' && item._disk && item._disk.available && !item._target && !item._targetP && Plex.configured() && !item._tgTimer) {
            item._tgTimer = setTimeout(() => {
                item._tgTimer = null;
                if (Nav.current() === card) { lookupOf(item).then(real => findTarget(item, real)).catch(() => {}); }
            }, 600);
        }
        // People: their biography loads once you've rested on them for a moment.
        if (item._person && !v.overview && !item._bioTimer) {
            item._bioTimer = setTimeout(() => {
                item._bioTimer = null;
                if (Nav.current() !== card) { return; }
                People.details(item).then(() => { if (Nav.current() === card) { setHero(heroFor(card), true); } }, () => {});
            }, 500);
        }

        // Some sources (TV premieres) fetch their wide background image on first view.
        if (!v.backdrop && item.loadBackdrop && !item._bgLoading) {
            item._bgLoading = true;
            item.loadBackdrop().then(url => {
                v.backdrop = url;
                if (Nav.current() === card) { setHero(heroFor(card), true); }
            }, () => {});
        }
        // Status (In library / Searching… / Downloading 40%) appears as a pill next to the details.
        return { card, title: v.title, meta: v.meta, status: statusFor(kind, item), overview: v.overview || '', backdrop: v.backdrop, portrait: !!item._person };
    }

    let heroTitle = null, bgTimer = null, bgFront = 'a', bgUrl = null;
    function setHero(h, quiet) {
        const info = $('hero-info');
        // People: the biography arrives a moment later, so its space is kept from the start (the name doesn't jump).
        info.classList.toggle('person', !!h.portrait);
        $('hero-eyebrow').textContent = h.eyebrow || '';
        $('hero-eyebrow').classList.toggle('hidden', !h.eyebrow);
        $('hero-title').textContent = h.title || '';
        $('hero-meta').innerHTML = (h.status ? '<span class="pill ' + h.status.state + '">' + esc(h.status.label) + '</span>' : '') +
            esc((h.meta || []).join('  ·  '));
        $('hero-overview').textContent = h.overview || '';
        // "More info" only makes sense while the hero is previewing a title.
        $('hero-more').classList.toggle('hidden', !h.card);
        // An empty Downloads page still needs something to highlight, or focus (and the side menu) stays put.
        $('hero-browse').classList.toggle('hidden', !(state.dlMode && !h.card));
        updateBrowseButtons();
        if (!quiet && h.title !== heroTitle) {
            info.classList.remove('enter');
            void info.offsetWidth;              // restart the animation
            info.classList.add('enter');
        }
        heroTitle = h.title;

        // Crossfade the backdrop, debounced so holding an arrow doesn't load every image.
        clearTimeout(bgTimer);
        bgTimer = setTimeout(() => setBackdrop(h.backdrop || null, !!h.portrait), 220);
        personStrip(h);
    }

    /* Banner backgrounds at most 1280px wide. The sources' originals are often 4K, and decoding one froze
       the 2019 TV for up to 2 s. TMDb serves a 1280 size itself; anything else is resized by the Plex server. */
    function heroImage(url) {
        if (!url) { return url; }
        if (/image\.tmdb\.org\/t\/p\/original\//.test(url)) { return url.replace('/t/p/original/', '/t/p/w1280/'); }
        if (/image\.tmdb\.org\/t\/p\/w\d+\//.test(url)) { return url; }
        if (/^https?:/.test(url) && Plex.configured() && url.indexOf(Plex.base()) !== 0) {
            return Plex.base() + '/photo/:/transcode?width=1280&height=720&minSize=1&upscale=0&url=' + encodeURIComponent(url) +
                '&X-Plex-Token=' + encodeURIComponent(Plex.token());
        }
        return url;
    }

    // A portrait (a person's photo) sits on the right at full height instead of filling the banner.
    function setBackdrop(url, portrait) {
        if (!portrait) { url = heroImage(url); }
        if (url === bgUrl) { return; }
        bgUrl = url;
        const front = $('hero-bg-' + bgFront), backId = bgFront === 'a' ? 'b' : 'a', backEl = $('hero-bg-' + backId);
        if (!url) { front.classList.remove('show'); backEl.classList.remove('show'); return; }
        const img = new Image();
        img.onload = () => {
            if (bgUrl !== url) { return; }
            backEl.style.backgroundImage = cssUrl(url);
            backEl.classList.toggle('portrait', !!portrait);
            backEl.classList.add('show');
            front.classList.remove('show');
            bgFront = backId;
        };
        img.src = url;
    }

    /* ---- A person in the banner: their main photo first, then a slow filmstrip of their other photos, each
       blended into the next, drifting right to left (People.gallery). The strip is drawn once into a canvas and
       moved with a transform only (a masked, animating layer flickers on the TV). The main photo starts exactly
       where the single portrait sits, holds for a moment, and comes round again after the others. ---- */
    const STRIP = {
        tile: 480, blend: 160, height: 600,     // each photo 480x600; neighbours overlap by 160px and cross-fade
        view: 1920, mainX: 1560,                // the strip fills the banner; the portrait's centre (.hero-bg.portrait: right 120px, 480 wide)
        speed: 22,                              // px per second
        rest: 200                               // how long to rest on a person before fetching their photos
    };
    let stripItem = null, stripGen = 0;
    function personStrip(h) {
        const item = h.portrait && h.card ? itemOf(h.card) : null;
        if (item === stripItem) { return; }
        stripItem = item;
        const gen = ++stripGen;
        hideStrip();
        People.focus(item && item._person.name);       // their lookups jump the Wikimedia queue
        if (!item) { return; }
        // Only once you've rested on the person (holding an arrow doesn't fetch everyone's photos).
        setTimeout(() => {
            if (gen !== stripGen) { return; }
            People.gallery(item).then(urls => {
                prefetchNeighbours(h.card);
                return gen === stripGen && urls.length > 1 ? loadPhotos(urls) : [];
            }).then(imgs => {
                if (gen !== stripGen || imgs.length < 2) { return; }
                // All the photos at once, as soon as they're loaded (drawn once the remote is briefly quiet).
                whenIdle(() => { if (gen === stripGen) { showStrip(imgs); } }, 200);
            }).catch(() => {});
        }, STRIP.rest);
    }
    // Flicking along a cast list: the people either side are looked up (and their photos fetched) in the
    // background, so their strips are ready when you get there.
    function prefetchNeighbours(card) {
        [card.previousElementSibling, card.nextElementSibling, card.nextElementSibling && card.nextElementSibling.nextElementSibling].forEach(c => {
            const it = c && c.classList.contains('card') ? itemOf(c) : null;
            if (!it || !it._person || it._galleryWarm) { return; }
            it._galleryWarm = true;
            whenIdle(() => People.gallery(it).then(urls => urls.slice(1).forEach(u => { new Image().src = u; })).catch(() => {}));
        });
    }
    /* Loaded images in order, without copies of the same picture (TMDb, TVmaze and Wikimedia often have the same
       photo under different names); none at all if the main photo fails (the strip must start on it). Images are
       fetched with CORS (all three hosts allow it) so their pixels can be compared; a host that refuses gets a
       plain load and is kept unchecked. */
    const STRIP_MAX = 6;
    function loadPhoto(u, cors) {
        return new Promise(res => {
            const img = new Image();
            let done = false;
            const fin = ok => { if (!done) { done = true; res(ok && img.naturalWidth >= 200 ? img : null); } };
            if (cors) { img.crossOrigin = 'anonymous'; }
            img.onload = () => fin(true);
            img.onerror = () => fin(false);
            setTimeout(() => fin(false), 10000);
            img.src = u;
        }).then(img => (img || !cors ? img : loadPhoto(u, false)));
    }
    /* A 64-bit fingerprint of the part of the photo the strip shows (the tile's crop): each cell of a 9x8 greyscale
       thumbnail compared with its right-hand neighbour. Copies of one picture differ by a few bits at most. */
    function photoPrint(img) {
        try {
            const c = document.createElement('canvas');
            c.width = 9; c.height = 8;
            const x = c.getContext('2d');
            const k = Math.max(STRIP.tile / img.naturalWidth, STRIP.height / img.naturalHeight);
            const sw = STRIP.tile / k, sh = STRIP.height / k;
            x.drawImage(img, (img.naturalWidth - sw) / 2, 0, sw, sh, 0, 0, 9, 8);
            const d = x.getImageData(0, 0, 9, 8).data, bits = [];
            const lum = i => d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
            for (let y = 0; y < 8; y++) {
                for (let i = 0; i < 8; i++) { const at = (y * 9 + i) * 4; bits.push(lum(at) > lum(at + 4) ? 1 : 0); }
            }
            return bits;
        } catch (e) { return null; }                       // no CORS: the canvas is tainted
    }
    const samePicture = (a, b) => { let diff = 0; for (let i = 0; i < 64; i++) { diff += a[i] !== b[i] ? 1 : 0; } return diff <= 10; };
    function loadPhotos(urls) {
        return Promise.all(urls.map(u => loadPhoto(u, true))).then(list => {
            if (!list[0]) { return []; }
            const kept = [], prints = [];
            list.forEach(img => {
                if (!img || kept.length >= STRIP_MAX) { return; }
                const print = photoPrint(img);
                if (print && prints.some(p => p && samePicture(p, print))) { return; }
                kept.push(img); prints.push(print);
            });
            return kept;
        });
    }
    // One photo cropped to the tile (top-aligned: faces are near the top), its left edge fading in over the last.
    function stripTile(img) {
        const c = document.createElement('canvas');
        c.width = STRIP.tile; c.height = STRIP.height;
        const x = c.getContext('2d');
        const k = Math.max(STRIP.tile / img.naturalWidth, STRIP.height / img.naturalHeight);
        const w = img.naturalWidth * k;
        x.drawImage(img, (STRIP.tile - w) / 2, 0, w, img.naturalHeight * k);
        x.globalCompositeOperation = 'destination-in';
        const g = x.createLinearGradient(0, 0, STRIP.tile, 0);
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(STRIP.blend / STRIP.tile, 'rgba(0,0,0,1)');
        g.addColorStop(1, 'rgba(0,0,0,1)');
        x.fillStyle = g;
        x.fillRect(0, 0, STRIP.tile, STRIP.height);
        return c;
    }
    /* Tiles repeat (photo j % n at j * step), so the strip loops seamlessly every n * step pixels. It starts with a
       later copy of the main photo centred on the portrait, far enough in that the very first tile (with nothing
       to blend into) never shows, and is long enough to fill the box for a whole loop. */
    function showStrip(imgs) {
        const T = STRIP.tile, step = STRIP.tile - STRIP.blend, n = imgs.length, loop = n * step;
        let r = 1;
        while (r * loop + T / 2 - STRIP.mainX < STRIP.blend) { r++; }
        const start = STRIP.mainX - T / 2 - r * loop;
        const count = Math.ceil((STRIP.view - start + loop) / step) + 1;
        const cv = document.createElement('canvas');
        cv.width = (count - 1) * step + T; cv.height = STRIP.height;
        const ctx = cv.getContext('2d'), tiles = imgs.map(stripTile);
        for (let j = 0; j < count; j++) { ctx.drawImage(tiles[j % n], j * step, 0); }
        const box = $('hero-strip');
        dropStrip(box);
        cv.style.transform = 'translate3d(' + start + 'px,0,0)';
        box.appendChild(cv);
        void box.offsetWidth;
        box.classList.add('show');
        if (cv.animate) {
            cv._anim = cv.animate([{ transform: 'translate3d(' + start + 'px,0,0)' }, { transform: 'translate3d(' + (start - loop) + 'px,0,0)' }],
                { duration: loop / STRIP.speed * 1000, iterations: Infinity, easing: 'linear' });
        }
    }
    function dropStrip(box) {
        Array.prototype.slice.call(box.querySelectorAll('canvas')).forEach(c => {
            if (c._anim) { c._anim.cancel(); }
            c.width = 0;                                   // frees the bitmap now (the TV is short of memory)
            box.removeChild(c);
        });
    }
    function hideStrip() {
        const box = $('hero-strip');
        if (!box.classList.contains('show')) { dropStrip(box); return; }
        box.classList.remove('show');
        const gen = stripGen;
        setTimeout(() => { if (gen === stripGen && !box.classList.contains('show')) { dropStrip(box); } }, 1300);
    }

    /* ---- title details modal: OK on a poster opens it; Download inside it starts the download ---- */

    // Kept so older call sites (screen changes, Back) stay harmless.
    function disarm() {}

    // The *arr lookup item for a card (category items are looked up once, then cached).
    function lookupOf(item) {
        if (!item._feed) { return Promise.resolve(item); }
        if (item._resolved) { return Promise.resolve(item._resolved); }
        return item.resolve().then(real => { item._resolved = real; if (real.id > 0) { item.id = real.id; } return real; });
    }

    function ago(t) {
        const m = Math.max(1, Math.round((Date.now() - t) / 60000));
        if (m < 60) { return m + ' min ago'; }
        const h = Math.round(m / 60);
        if (h < 24) { return h + 'h ago'; }
        const d = Math.round(h / 24);
        return d === 1 ? 'yesterday' : d + ' days ago';
    }

    const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const longDate = t => { const d = new Date(t); return isNaN(d) ? '' : d.getDate() + ' ' + MONTH_NAMES[d.getMonth()] + ' ' + d.getFullYear(); };
    const runtime = m => (m ? (m >= 60 ? Math.floor(m / 60) + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '') : m + 'm') : '');

    // Full details from the *arr lookup: ratings, facts and the complete overview.
    function detailsOf(kind, r) {
        const ratings = [], facts = [];
        const rt = r.ratings || {};
        if (kind === 'movie') {
            if (rt.imdb && rt.imdb.value) { ratings.push(['IMDb', rt.imdb.value.toFixed(1)]); }
            if (rt.tmdb && rt.tmdb.value) { ratings.push(['TMDb', Math.round(rt.tmdb.value * 10) + '%']); }
            if (rt.rottenTomatoes && rt.rottenTomatoes.value) { ratings.push(['Rotten Tomatoes', Math.round(rt.rottenTomatoes.value) + '%']); }
            if (rt.metacritic && rt.metacritic.value) { ratings.push(['Metacritic', Math.round(rt.metacritic.value)]); }
            facts.push(['In cinemas', r.inCinemas ? longDate(r.inCinemas) : '']);
            facts.push(['Digital release', r.digitalRelease ? longDate(r.digitalRelease) : '']);
            facts.push(['Runtime', runtime(r.runtime)]);
            facts.push(['Genres', (r.genres || []).join(', ')]);
            facts.push(['Rated', r.certification]);
            facts.push(['Studio', r.studio]);
        } else if (kind === 'tv') {
            if (rt.value) { ratings.push(['Rating', rt.value.toFixed(1) + (rt.votes ? ' · ' + rt.votes.toLocaleString() + ' votes' : '')]); }
            const seasons = (r.seasons || []).filter(x => x.seasonNumber > 0).length;
            facts.push(['First aired', r.firstAired ? longDate(r.firstAired) : String(r.year || '')]);
            facts.push(['Seasons', seasons ? String(seasons) : '']);
            facts.push(['Runtime', r.runtime ? runtime(r.runtime) + ' per episode' : '']);
            facts.push(['Genres', (r.genres || []).join(', ')]);
            facts.push(['Network', r.network]);
            facts.push(['Status', r.status ? r.status.charAt(0).toUpperCase() + r.status.slice(1) : '']);
            facts.push(['Rated', r.certification]);
        } else {
            // A rating from a handful of votes means nothing, so it's only shown with 5 or more.
            if (rt.value && rt.votes >= 5) { ratings.push(['Rating', rt.value.toFixed(1) + ' · ' + rt.votes.toLocaleString() + ' votes']); }
            facts.push(['Artist', r.artistName]);
            facts.push(['Genres', (r.genres || []).join(', ')]);
            facts.push(['Status', r.status ? r.status.charAt(0).toUpperCase() + r.status.slice(1) : '']);
        }
        return { overview: r.overview || '', ratings, facts: facts.filter(f => f[1] && String(f[1]).trim()) };
    }

    function openInfo(card, returnTo) {
        const item = itemOf(card);
        if (item._person) { openPersonCard(card, returnTo); return; }
        const kind = card._kind || kindOf(item);
        const v = viewOf(kind, item);
        state.info = { card, kind, item, returnTo };

        $('in-poster').style.backgroundImage = cssUrl(chosenArt(kind, item) || v.poster || v.backdrop);
        $('in-art').classList.add('hidden');
        $('in-title').textContent = v.title;
        $('in-meta').textContent = (v.meta || []).join('  ·  ');
        $('in-overview').textContent = v.overview || '';
        $('in-ratings').innerHTML = '';
        $('in-facts').innerHTML = '';
        $('in-body').style.scrollBehavior = 'auto';
        $('in-body').scrollTop = 0;
        $('in-body').style.scrollBehavior = '';
        if (kind === 'tv' && item._target) { state.info.target = item._target; }
        else if (kind === 'tv' && item._disk && item._disk.available && Plex.configured()) { state.info.targetPending = true; }
        renderInfoStatus();
        $('in-trailer').classList.add('hidden');
        $('in-seasons').classList.add('hidden');
        $('info-sheet').classList.remove('has-seasons');
        infoNav = { btn: 'in-download', season: null };
        $('in-season-track').innerHTML = '';
        $('in-similar').textContent = 'Similar';
        $('in-similar').classList.toggle('hidden', !!state.dlMode);   // Similar and Cast pages live on the browse screens
        $('in-cast').textContent = 'Cast';
        $('in-cast').classList.toggle('hidden', !!state.dlMode || kind === 'music');
        $('info-sheet').classList.add('open');
        $('info-scrim').classList.add('open');
        $('info-sheet').setAttribute('aria-hidden', 'false');
        Nav.focus($('in-download'));
        updateInfoScroll();

        // Fill in the full details (ratings, runtime, genres…) from Sonarr / Radarr / Lidarr.
        lookupOf(item).then(real => {
            if (!state.info || state.info.item !== item) { return; }
            const d = detailsOf(kind, real);
            if (d.overview) { $('in-overview').textContent = d.overview; }
            $('in-ratings').innerHTML = d.ratings.map(r => '<span class="rating">' + esc(r[0]) + '<b>' + esc(r[1]) + '</b></span>').join('');
            $('in-facts').innerHTML = d.facts.map(f => '<dt>' + esc(f[0]) + '</dt><dd>' + esc(f[1]) + '</dd>').join('');
            renderInfoStatus();
            updateInfoScroll();
            // Movies: a trailer, preferably Plex's (streams reliably on the TV), else the TMDb YouTube trailer.
            if (kind === 'movie') { findTrailer(state.info, real); }
            if (kind === 'tv') { loadSeasons(state.info, real); loadArtChoices(state.info, real); }
            playTheme(state.info, real);
            // Already in the library? Ask the app whether files are on disk, and offer Play if so.
            if (inLibrary(real)) {
                item.id = real.id;
                if (kind === 'tv' && item._disk && item._disk.available && state.info && state.info.item === item) { loadTarget(state.info, real); }
                Api.libraryStatus(kind, real.id).then(st => {
                    item._disk = st;
                    if (state.info && state.info.item === item) { renderInfoStatus(); }
                    updateAllCards();
                    if (kind === 'tv' && st.available && state.info && state.info.item === item) { loadTarget(state.info, real); }
                }, () => {});
            }
        }, () => { /* details are optional; the view data is already shown */ });
    }

    function renderInfoStatus() {
        const info = state.info;
        if (!info) { return; }
        const s = statusFor(info.kind, info.item);
        const disk = info.item._disk;
        const onDisk = !!(disk && disk.available);
        $('in-eyebrow').textContent = svc(info.kind).label + (onDisk ? ' · ' + disk.label : s ? ' · ' + s.label : '');
        const btn = $('in-download');
        const busy = s && (s.state === 'searching' || s.state === 'downloading' || s.state === 'queued' || s.state === 'importing');
        btn.classList.toggle('play', onDisk);
        // Movies and episodes play in MediaLoader's own player; music opens in the Plex app.
        const own = onDisk && info.kind !== 'music';
        // TV: says which episode Play starts (the unfinished one, or the next in sequence).
        const ep = own && info.kind === 'tv' && info.target;
        // While the episode is being found the label stays hidden, so it appears once (no "Play" → "Play S1 · E7" jump).
        btn.classList.toggle('label-wait', !!(own && info.kind === 'tv' && !ep && info.targetPending));
        btn.textContent = ep ? (ep.resume ? '▶ Resume' : '▶ Play') + ' S' + ep.season + ' · E' + ep.episode : own ? '▶ Play' : onDisk ? '▶ Play In Plex' : busy ? 'Search again' : inLibrary(info.item) ? 'Search for missing' : 'Download';
        $('in-plexapp').classList.toggle('hidden', !own || !ui.plexApp);
    }

    // Up/Down scroll the full-text page.
    function scrollInfo(dir) {
        const body = $('tx-body');
        body.scrollTop += (dir === 'down' ? 1 : -1) * Math.round(body.clientHeight * 0.6);
        setTimeout(updateSheetScroll, 400);
    }

    function updateSheetScroll() {
        updateInfoScroll(state.text ? $('tx-body') : state.person ? $('ps-body') : $('in-body'));
    }

    // Fades show there's more text; in a pop-up, a shortened description becomes something you can
    // highlight (Up) and open in full (OK).
    function updateInfoScroll(bodyEl) {
        const body = bodyEl || $('in-body');
        const scrollable = body.scrollHeight > body.clientHeight + 2;
        body.classList.toggle('more-below', scrollable && body.scrollTop + body.clientHeight < body.scrollHeight - 2);
        body.classList.toggle('more-above', scrollable && body.scrollTop > 2);
        const desc = body.id === 'tx-body' ? null : body.querySelector('.info-overview');
        if (desc) {
            // The details pop-up keeps its facts for the full page, so there's always more to see when it has any.
            const facts = body.id === 'in-body' && $('in-facts').children.length > 0;
            const cut = !!desc.textContent && (facts || desc.scrollHeight > desc.clientHeight + 2 || scrollable);
            desc.classList.toggle('focusable', cut);
            if (!cut && Nav.current() === desc) { Nav.focus($(body.id === 'ps-body' ? 'ps-close' : 'in-download')); }
        }
        if (body.id === 'in-body') { updateInfoNav(); }
    }

    // Details pop-up: Up/Down between the description, the seasons row and the buttons always return to
    // the season / button you last had there, rather than whichever happens to be nearest.
    let infoNav = { btn: 'in-download', season: null };
    function updateInfoNav() {
        const desc = $('in-overview'), track = $('in-season-track');
        const descOk = desc.classList.contains('focusable');
        const seasonsOn = !$('in-seasons').classList.contains('hidden') && track.children.length > 0;
        const lastBtn = $(infoNav.btn);
        const btnSel = lastBtn && !lastBtn.classList.contains('hidden') ? '#' + infoNav.btn : '#in-download';
        const seasonSel = seasonsOn ? '#' + (infoNav.season && $(infoNav.season) ? infoNav.season : track.children[0].id) : null;
        const set = (el, dir, sel) => { if (sel) { el.setAttribute('data-nav-' + dir, sel); } else { el.removeAttribute('data-nav-' + dir); } };
        Array.prototype.forEach.call(document.querySelectorAll('#info-sheet .sheet-actions .btn'), b => set(b, 'up', seasonSel || (descOk ? '#in-overview' : null)));
        Array.prototype.forEach.call(track.children, (c, i, all) => {
            set(c, 'up', descOk ? '#in-overview' : null);
            set(c, 'down', btnSel);
            // The ends of the seasons row stop there rather than dropping into the buttons.
            set(c, 'left', i === 0 ? '#' + c.id : null);
            set(c, 'right', i === all.length - 1 ? '#' + c.id : null);
        });
        set(desc, 'down', seasonSel || btnSel);
        // Left/Right on the description do nothing (they used to jump to the nearest season).
        set(desc, 'left', '#in-overview');
        set(desc, 'right', '#in-overview');
    }

    /* ---- Full text page: the whole description (or biography) and every fact; Back returns ---- */

    function openText(o) {
        state.text = { returnTo: Nav.current() };
        $('tx-eyebrow').textContent = o.eyebrow || '';
        $('tx-title').textContent = o.title || '';
        $('tx-body').innerHTML = o.html;
        $('tx-body').style.scrollBehavior = 'auto';
        $('tx-body').scrollTop = 0;
        $('tx-body').style.scrollBehavior = '';
        $('tx-sheet').classList.add('open');
        $('tx-sheet').setAttribute('aria-hidden', 'false');
        Nav.focus($('tx-close'));
        setTimeout(updateSheetScroll, 50);
    }

    function closeText() {
        if (!state.text) { return false; }
        const back = state.text.returnTo;
        state.text = null;
        $('tx-sheet').classList.remove('open');
        $('tx-sheet').setAttribute('aria-hidden', 'true');
        if (back && back.parentNode) { Nav.focus(back); }
        return true;
    }

    function openInfoText() {
        if (!state.info) { return; }
        const ratings = $('in-ratings').innerHTML, facts = $('in-facts').innerHTML;
        openText({
            eyebrow: $('in-eyebrow').textContent, title: $('in-title').textContent,
            html: (ratings ? '<div class="ratings">' + ratings + '</div>' : '') + '<p class="info-overview">' + esc($('in-overview').textContent) + '</p>' +
                (facts ? '<dl class="facts">' + facts + '</dl>' : '')
        });
    }

    function openPersonText() {
        if (!state.person) { return; }
        const facts = $('ps-facts').innerHTML;
        openText({
            eyebrow: 'Actor', title: $('ps-name').textContent,
            html: '<p class="info-overview">' + esc($('ps-bio').textContent) + '</p>' + (facts ? '<dl class="facts">' + facts + '</dl>' : '')
        });
    }

    /* ---- Play: hands off to the Plex app on the TV ---- */

    const PLEX_APP_ID = (typeof MEDIALOADER_PLEX_APP !== 'undefined' && MEDIALOADER_PLEX_APP) || 'kIciSQlYEM.plex';

    function playInPlex(info) {
        const title = viewOf(info.kind, info.item).title;
        if (typeof tizen === 'undefined' || !tizen.application) { toast('Play In Plex works on the TV', 'err'); return; }
        const btn = $('in-download');
        btn.textContent = 'Starting in Plex…';
        // Plex.play finds the title on the Plex server, opens the Plex app and tells it to play.
        lookupOf(info.item).then(real => Plex.play(info.kind, real)).then(r => {
            if (r.played) { rememberPlayed(info.kind, info.item); toast('Playing “' + (r.label || title) + '” in Plex', 'ok'); }
            else { toast(r.reason + ' — choose “' + title + '” there', 'err'); }
        }, err => toast('Couldn’t start “' + title + '” in Plex: ' + err.message, 'err'))
            .then(() => { if (state.info && state.info.item === info.item) { renderInfoStatus(); } });
    }

    /* ---- TV seasons: a row in the details pop-up, and a Plex-style season screen ---- */

    function seasonStatus(s) {
        if (s.future) { return { label: s.premiere ? 'Starts ' + longDate(s.premiere) : 'Coming soon', cls: '' }; }
        if (s.aired && s.files >= s.aired) { return { label: 'All ' + s.files + ' on disk', cls: 'ok' }; }
        if (s.files) { return { label: s.files + ' of ' + (s.aired || s.total) + ' on disk', cls: 'ok' }; }
        return { label: s.total ? s.total + (s.total === 1 ? ' episode' : ' episodes') : 'Not downloaded', cls: '' };
    }

    function loadSeasons(info, real) {
        Seasons.forShow(info.item, real).then(list => {
            if (state.info !== info || !list.length) { return; }
            info.seasons = list;
            info.real = real;
            const poster = viewOf('tv', info.item).poster;
            $('in-seasons-title').textContent = list.length === 1 ? '1 season' : list.length + ' seasons';
            const track = $('in-season-track');
            track.innerHTML = '';
            track.style.transform = 'translate3d(0,0,0)';
            list.forEach(s => {
                const st = seasonStatus(s);
                const c = el('button', 'season-card focusable',
                    '<div class="sc-art"></div><b>' + esc(s.name) + '</b><span class="' + st.cls + '">' + esc(st.label) + '</span>');
                c._season = s;
                c.id = 'in-season-' + s.number;
                c.querySelector('.sc-art').style.backgroundImage = cssUrl(s.image || poster);
                c.addEventListener('click', () => openSeason(c));
                track.appendChild(c);
            });
            $('in-seasons').classList.remove('hidden');
            $('info-sheet').classList.add('has-seasons');
            updateInfoScroll();
        }, () => { /* no season data: the pop-up still works */ });
    }

    // Keep the highlighted season in view (the row slides with a transform).
    function scrollSeasons(card) {
        const track = card.parentNode, view = track.parentNode;
        const x = Math.max(0, Math.min(card.offsetLeft - 150, track.scrollWidth - view.clientWidth));
        track.style.transform = 'translate3d(' + (-x) + 'px,0,0)';
    }

    let seasonArm = null, seasonArmTimer = null;
    function disarmSeason() {
        clearTimeout(seasonArmTimer);
        if (seasonArm && seasonArm._label) { seasonArm._label(); }
        seasonArm = null;
    }
    // Downloading needs a second OK, like the other important actions.
    function armed(el, prompt, restore) {
        if (seasonArm === el) { disarmSeason(); return true; }
        disarmSeason();
        seasonArm = el;
        el._label = restore;
        prompt();
        seasonArmTimer = setTimeout(disarmSeason, 5000);
        return false;
    }

    function openSeason(card) {
        const info = state.info, season = card._season;
        if (!info || !season) { return; }
        const sv = { info, season, card, eps: [] };
        state.season = sv;
        const v = viewOf('tv', info.item);
        $('ss-bg').style.backgroundImage = cssUrl(v.backdrop ? heroImage(v.backdrop) : v.poster);
        $('ss-poster').style.backgroundImage = cssUrl(season.imageFull || season.image || v.poster);
        $('ss-show').textContent = v.title;
        $('ss-title').textContent = season.name;
        $('ss-meta').textContent = [season.premiere ? season.premiere.slice(0, 4) : '', season.total ? season.total + ' episodes' : '', seasonStatus(season).label].filter(Boolean).join('  ·  ');
        $('ss-summary').textContent = season.summary || v.overview || '';
        $('ss-list').innerHTML = '';
        $('ss-list').style.transform = 'translate3d(0,0,0)';
        $('ss-play').classList.add('hidden');
        $('ss-download').classList.remove('hidden');
        $('ss-download').textContent = season.future ? 'Download when it airs' : 'Download season';
        $('ss-sheet').classList.add('open');
        $('ss-sheet').setAttribute('aria-hidden', 'false');
        Nav.focus($('ss-download'));
        loadEpisodes(sv, true);
    }

    function loadEpisodes(sv, first) {
        Seasons.episodes(sv.info.item, sv.info.real, sv.season).then(eps => {
            if (state.season !== sv) { return; }
            sv.eps = eps;
            renderEpisodes(sv, first);
        }, () => { if (state.season === sv) { toast('Couldn’t load the episodes', 'err'); } });
    }

    function epStatus(ep) {
        if (ep.plex) { return ep.plex.watched ? { label: 'Watched', cls: 'ok' } : ep.plex.offset ? { label: Math.round(ep.plex.offset / 60000) + ' min watched', cls: 'ok' } : { label: 'Ready to play', cls: 'ok' }; }
        if (ep.sonarr && ep.sonarr.hasFile) { return { label: 'Downloaded · not in Plex yet', cls: 'ok' }; }
        if (ep.future) { return { label: ep.airdate ? 'Airs ' + longDate(ep.airdate) : 'Not aired yet', cls: '' }; }
        if (ep._searching) { return { label: 'Searching…', cls: 'warn' }; }
        return { label: 'Not downloaded', cls: '' };
    }

    function renderEpisodes(sv, first) {
        const list = $('ss-list');
        const cur = Nav.current();
        const keep = cur && cur._ep ? cur._ep.number : null;
        list.innerHTML = '';
        sv.eps.forEach(ep => {
            const row = el('button', 'ep focusable');
            row.id = 'ss-ep-' + ep.number;
            row._ep = ep;
            const thumb = ep.image || (ep.plexThumb && Plex.configured() ? Plex.base() + '/photo/:/transcode?width=480&height=270&minSize=1&url=' + encodeURIComponent(ep.plexThumb) + '&X-Plex-Token=' + encodeURIComponent(Plex.token()) : '');
            const prog = ep.plex && ep.plex.offset && ep.plex.duration && !ep.plex.watched ? '<div class="ep-progress"><i style="width:' + Math.min(100, Math.round(ep.plex.offset / ep.plex.duration * 100)) + '%"></i></div>' : '';
            row.innerHTML = '<div class="ep-thumb">' + (ep.plex && ep.plex.watched ? '<span class="ep-watched">&#10003;</span>' : '') + prog + '</div>' +
                '<div class="ep-text"><h3>' + ep.number + '. ' + esc(ep.title || 'Episode ' + ep.number) + '</h3>' +
                '<p class="ep-meta"><span class="ep-state"></span>' + esc([ep.airdate ? longDate(ep.airdate) : '', ep.runtime ? runtime(ep.runtime) : ''].filter(Boolean).join('  ·  ')) + '</p>' +
                '<p class="ep-sum">' + esc(ep.summary || '') + '</p></div>';
            row.querySelector('.ep-thumb').style.backgroundImage = cssUrl(thumb);
            paintEp(row);
            row.addEventListener('click', () => episodeOk(row));
            list.appendChild(row);
        });
        // Right from the buttons goes to episode 1 until an episode has been highlighted.
        const firstEp = list.querySelector('.ep');
        if (firstEp && !$('ss-download').getAttribute('data-nav-right')) {
            $('ss-play').setAttribute('data-nav-right', '#' + firstEp.id);
            $('ss-download').setAttribute('data-nav-right', '#' + firstEp.id);
        }
        const playable = sv.eps.filter(e => e.plex);
        const next = playable.filter(e => !e.plex.watched)[0] || playable[0];
        sv.next = next || null;
        $('ss-play').classList.toggle('hidden', !next);
        if (next) { $('ss-play').textContent = (next.plex.offset && !next.plex.watched ? '▶ Resume E' : '▶ Play E') + next.number; }
        const aired = sv.eps.filter(e => !e.future), have = aired.filter(e => e.onDisk);
        const complete = aired.length && have.length === aired.length;
        $('ss-download').classList.toggle('hidden', !!complete);
        if (!complete) { $('ss-download').textContent = sv.season.future ? 'Download when it airs' : have.length ? 'Download the missing ' + (aired.length - have.length) : 'Download season'; }
        $('ss-meta').textContent = [sv.season.premiere ? sv.season.premiere.slice(0, 4) : '', sv.eps.length + (sv.eps.length === 1 ? ' episode' : ' episodes'),
            have.length ? have.length + ' on disk' : ''].filter(Boolean).join('  ·  ');
        // Land on Play (or the next episode) once the list is in; otherwise keep the place you were at.
        const back = keep ? $('ss-ep-' + keep) : null;
        if (back) { Nav.focus(back); }
        else if (first || !Nav.current() || Nav.current().classList.contains('hidden')) {
            Nav.focus(next ? $('ss-play') : complete ? list.querySelector('.ep') : $('ss-download'));
        }
    }

    function paintEp(row) {
        const st = epStatus(row._ep);
        const s = row.querySelector('.ep-state');
        s.className = 'ep-state ' + st.cls;
        s.textContent = st.label;
    }

    function episodeOk(row) {
        const sv = state.season, ep = row._ep;
        if (!sv || !ep) { return; }
        if (ep.plex) {
            Player.openKey(ep.plex.ratingKey).then(() => rememberPlayed('tv', sv.info.item), err => toast(err.message, 'err'));
            return;
        }
        if (ep.sonarr && ep.sonarr.hasFile) { toast('Downloaded. Plex hasn’t added it yet, so it can’t play here'); return; }
        if (ep.future) { toast('Episode ' + ep.number + ' hasn’t aired yet'); return; }
        if (ep._searching) { return; }
        if (!Api.configured('tv')) { toast('Sonarr isn’t connected', 'err'); return; }
        if (!armed(row, () => { const s = row.querySelector('.ep-state'); s.className = 'ep-state warn'; s.textContent = 'OK again to download this episode'; }, () => paintEp(row))) { return; }
        ep._searching = true;
        paintEp(row);
        Api.downloadEpisodes(sv.info.real, sv.season.number, [ep.number]).then(() => {
            trackRequest('tv', sv.info.item);
            toast('Sonarr is finding S' + sv.season.number + 'E' + ep.number + (ep.title ? ' “' + ep.title + '”' : ''), 'ok');
            schedulePoll(3000);
        }, err => { ep._searching = false; paintEp(row); toast(err.message, 'err'); });
    }

    function downloadSeason() {
        const sv = state.season;
        if (!sv) { return; }
        if (!Api.configured('tv')) { toast('Sonarr isn’t connected', 'err'); return; }
        const btn = $('ss-download'), label = btn.textContent;
        if (!armed(btn, () => { btn.textContent = 'OK again to download'; btn.classList.add('confirming'); },
            () => { btn.textContent = label; btn.classList.remove('confirming'); })) { return; }
        btn.textContent = 'Starting…';
        const missing = sv.eps.filter(e => !e.future && !e.onDisk).map(e => e.number);
        // A partly downloaded season only searches for what's missing.
        const which = sv.eps.length && missing.length && missing.length < sv.eps.filter(e => !e.future).length ? missing : null;
        Api.downloadEpisodes(sv.info.real, sv.season.number, which).then(r => {
            trackRequest('tv', sv.info.item);
            sv.eps.forEach(e => { if (!e.future && !e.onDisk && (!which || which.indexOf(e.number) !== -1)) { e._searching = true; } });
            Array.prototype.forEach.call($('ss-list').children, paintEp);
            btn.textContent = 'Searching…';
            toast('Sonarr is finding ' + r.count + (r.count === 1 ? ' episode' : ' episodes') + ' of ' + sv.season.name, 'ok');
            schedulePoll(3000);
        }, err => { btn.textContent = label; toast(err.message, 'err'); });
    }

    function playSeason() {
        const sv = state.season;
        if (sv && sv.next) { Player.openKey(sv.next.plex.ratingKey).then(() => rememberPlayed('tv', sv.info.item), err => toast(err.message, 'err')); }
    }

    // Keep the highlighted episode in view: the list slides up with a transform.
    function scrollEpisodes(row) {
        const list = row.parentNode, view = list.parentNode;
        // The highlighted episode sits second from the top, with the one before it fully in view.
        const prev = row.previousElementSibling;
        const y = Math.max(0, Math.min(prev ? prev.offsetTop - 8 : 0, list.scrollHeight - view.clientHeight));
        list.style.transform = 'translate3d(0,' + (-y) + 'px,0)';
        // Right from the buttons comes back to this episode.
        $('ss-play').setAttribute('data-nav-right', '#' + row.id);
        $('ss-download').setAttribute('data-nav-right', '#' + row.id);
    }

    function closeSeason() {
        if (!state.season) { return false; }
        const card = state.season.card;
        state.season = null;
        disarmSeason();
        $('ss-sheet').classList.remove('open');
        $('ss-sheet').setAttribute('aria-hidden', 'true');
        $('ss-play').removeAttribute('data-nav-right');
        $('ss-download').removeAttribute('data-nav-right');
        if (card && card.parentNode) { Nav.focus(card); } else if (state.info) { Nav.focus($('in-download')); }
        return true;
    }

    /* ---- Long names: a highlighted label that's cut off ("…") scrolls slowly back and forth, pausing at each
       end, and goes back to normal when you move on. Only the text moves (a transform), so it stays smooth. ---- */
    let marquee = null;
    function stopMarquee() {
        if (!marquee) { return; }
        try { marquee.anim.cancel(); } catch (e) { /* ignore */ }
        marquee.box.textContent = marquee.text;
        marquee.box.classList.remove('marquee');
        marquee = null;
    }
    function startMarquee(box) {
        stopMarquee();
        if (!box) { return; }
        const over = box.scrollWidth - box.clientWidth;
        if (over <= 2) { return; }
        const text = box.textContent;
        box.classList.add('marquee');
        box.innerHTML = '<span>' + esc(text) + '</span>';
        const inner = box.firstChild;
        if (!inner.animate) { box.textContent = text; box.classList.remove('marquee'); return; }
        const move = Math.max(2000, over / 45 * 1000);          // about 45 px a second
        const total = move + 2400;                              // with 1.2 s pauses at each end
        const pause = 1200 / total;
        const anim = inner.animate([
            { transform: 'translate3d(0,0,0)', offset: 0 },
            { transform: 'translate3d(0,0,0)', offset: pause },
            { transform: 'translate3d(-' + over + 'px,0,0)', offset: 1 - pause },
            { transform: 'translate3d(-' + over + 'px,0,0)', offset: 1 }
        ], { duration: total, iterations: Infinity, direction: 'alternate', easing: 'linear' });
        marquee = { box, text, anim };
    }

    /* ---- Chosen pictures: a show's poster picked from TVmaze's images (the picture button in its details),
       remembered per title and used for its cards and details. ---- */
    const ART_KEY = 'medialoader.art';
    const artChoice = (() => { try { return JSON.parse(localStorage.getItem(ART_KEY) || '{}') || {}; } catch (e) { return {}; } })();
    const artKeyOf = (kind, item) => (item._feed && item.key) ? item.key
        : kind === 'tv' && item.tvdbId ? 'tvdb:' + item.tvdbId : kind === 'movie' && item.tmdbId ? 'tmdb:' + item.tmdbId : null;
    const chosenArt = (kind, item) => { const k = artKeyOf(kind, item); return (k && artChoice[k]) || ''; };

    // After the details load: offer the picture button when there's more than one poster to choose from.
    function loadArtChoices(info, real) {
        const id = (info.item && info.item.tvmaze) || real.tvMazeId;
        if (info.kind !== 'tv' || !id) { return; }
        Feeds.images(id).then(list => {
            const posters = list.filter(i => i.type === 'poster');
            if (state.info !== info || posters.length < 2) { return; }
            info.posters = posters;
            info.artKey = artKeyOf('tv', info.item) || ('tvdb:' + real.tvdbId);
            $('in-art').classList.remove('hidden');
        }, () => {});
    }

    function openArt() {
        const info = state.info;
        if (!info || !info.posters) { return; }
        state.art = { info, returnTo: $('in-art') };
        $('art-title').textContent = viewOf(info.kind, info.item).title;
        // The title's own poster comes first as "Original" (it's often from TheTVDB or the feed, not TVmaze), so a
        // choice can always be undone.
        const original = viewOf(info.kind, info.item).poster;
        const choices = (original ? [{ medium: original, original, isOriginal: true }] : [])
            .concat(info.posters.filter(p => p.medium !== original && p.original !== original));
        const track = $('art-track'), current = artChoice[info.artKey] || original;
        track.innerHTML = '';
        track.style.transform = 'translate3d(0,0,0)';
        let focusCard = null;
        choices.forEach((img, i) => {
            const c = el('button', 'art-card focusable');
            c._img = img;
            c.style.backgroundImage = cssUrl(img.medium);
            if (img.isOriginal) { c.innerHTML = '<span class="art-label">Original</span>'; }
            if (img.medium === current || img.original === current) { c.classList.add('chosen'); focusCard = c; }
            c.addEventListener('click', () => chooseArt(img));
            track.appendChild(c);
            if (i === 0) { c.setAttribute('data-nav-left', '#' + (c.id = 'art-first')); }
        });
        track.lastChild.id = track.lastChild.id || 'art-last';
        track.lastChild.setAttribute('data-nav-right', '#' + track.lastChild.id);
        $('art-sheet').classList.add('open');
        $('art-sheet').setAttribute('aria-hidden', 'false');
        Nav.focus(focusCard || track.firstChild);
    }

    function chooseArt(img) {
        const a = state.art;
        if (!a) { return; }
        const info = a.info;
        // The choice is kept separately (chosenArt); the title's own poster stays as it is, for "Original".
        if (img.isOriginal) { delete artChoice[info.artKey]; } else { artChoice[info.artKey] = img.medium; }
        try { localStorage.setItem(ART_KEY, JSON.stringify(artChoice)); } catch (e) { /* not saved */ }
        $('in-poster').style.backgroundImage = cssUrl(img.original || img.medium);
        Array.prototype.forEach.call($('results-rows').querySelectorAll('.card'), c => {
            if (c._item && (c._item === info.item || (c._item.key && c._item.key === info.artKey))) {
                c._poster = img.medium; c._posterShown = null; showPoster(c);
            }
        });
        toast(img.isOriginal ? 'Original picture back' : 'Picture changed', 'ok');
        closeArt();
    }

    function closeArt() {
        if (!state.art) { return false; }
        const back = state.art.returnTo;
        state.art = null;
        $('art-sheet').classList.remove('open');
        $('art-sheet').setAttribute('aria-hidden', 'true');
        if (back && state.info) { Nav.focus(back); }
        return true;
    }

    /* ---- Genre / Publisher: every genre (or network / studio / label) among the titles on this screen; OK
       shows a page with only that one's titles, in the screen's own rows. Back returns to the list. ---- */
    const PUB_TITLE = { tv: 'Networks & streaming services', movie: 'Studios', music: 'Record labels' };
    const browseOn = () => state.screen === 'search' && !state.dlMode && RECENT_KINDS.indexOf(state.kind) !== -1 &&
        !state.search[state.kind].similar && !state.search[state.kind].term && !!(state.search[state.kind].feed || []).length;

    function updateBrowseButtons() {
        const on = browseOn();
        $('hero-genre').classList.toggle('hidden', !on);
        $('hero-pub').classList.toggle('hidden', !on || !browseGroups('pub').length);
    }

    // Names of an item's groups: genres in the names the genre rows use, or its publisher.
    const groupsOf = (type, kind, item) => (type === 'genre'
        ? (item.genres || []).map(g => Feeds.genreName(kind, g)).filter(Boolean)
        : (item.pub ? [item.pub] : []));

    function browseGroups(type) {
        const kind = state.kind, seen = [], groups = {};
        (state.search[kind].feed || []).forEach(r => r.items.forEach(it => {
            if (seen.indexOf(it) !== -1) { return; }
            seen.push(it);
            groupsOf(type, kind, it).filter((g, i, a) => a.indexOf(g) === i).forEach(g => { (groups[g] = groups[g] || []).push(it); });
        }));
        let names = Object.keys(groups);
        // Publishers with a single title are mostly noise, unless there are only a few publishers anyway.
        if (type === 'pub' && names.filter(n => groups[n].length >= 2).length >= 8) { names = names.filter(n => groups[n].length >= 2); }
        return names.sort((a, b) => groups[b].length - groups[a].length || a.localeCompare(b)).map(n => ({ name: n, items: groups[n] }));
    }

    function openBrowse(type, focusName) {
        const kind = state.kind, list = browseGroups(type);
        if (!list.length) { toast('Nothing to group yet', 'err'); return; }
        state.browse = { type, returnTo: $(type === 'genre' ? 'hero-genre' : 'hero-pub') };
        $('gp-eyebrow').textContent = kindLabel(kind);
        $('gp-title').textContent = type === 'genre' ? 'Genres' : PUB_TITLE[kind];
        const grid = $('gp-grid');
        grid.innerHTML = '';
        grid.style.transform = 'translate3d(0,0,0)';
        let focusTile = null;
        list.forEach((g, i) => {
            const t = el('button', 'gp-tile focusable');
            t.id = 'gp-' + i;
            t.innerHTML = '<b></b><small></small><span class="gp-posters"></span>';
            t.querySelector('b').textContent = g.name;
            t.querySelector('small').textContent = g.items.length + (g.items.length === 1 ? ' title' : ' titles');
            const posters = t.querySelector('.gp-posters');
            g.items.filter(it => viewOf(kindOf(it), it).poster).slice(0, 3).reverse().forEach(it => {
                const p = el('i');
                p.style.backgroundImage = cssUrl(viewOf(kindOf(it), it).poster);
                posters.appendChild(p);
            });
            t.addEventListener('click', () => chooseBrowse(type, g.name));
            grid.appendChild(t);
            if (g.name === focusName) { focusTile = t; }
        });
        $('gp-sheet').classList.add('open');
        $('gp-sheet').setAttribute('aria-hidden', 'false');
        Nav.focus(focusTile || grid.firstChild);
    }

    function scrollBrowse(node) {
        const grid = node.parentNode, view = grid.parentNode;
        const room = view.clientHeight - 40;
        const y = Math.max(0, Math.min(node.offsetTop - (room - node.offsetHeight) / 2, grid.scrollHeight - room + 14));
        grid.style.transform = 'translate3d(0,' + (-Math.max(0, y)) + 'px,0)';
    }

    function chooseBrowse(type, name) {
        const kind = state.kind, s = state.search[kind];
        const used = [], rows = [];
        (s.feed || []).forEach(r => {
            const items = r.items.filter(it => used.indexOf(it) === -1 && groupsOf(type, kind, it).indexOf(name) !== -1);
            if (!items.length) { return; }
            items.forEach(it => used.push(it));
            rows.push({ title: r.title === name ? 'More ' + name : r.title, items });
        });
        closeBrowse(true);
        pushPage({ title: name, sub: used.length + (used.length === 1 ? ' title' : ' titles'), rows, from: null,
            reopen: 'browse', browse: { type, name } });
    }

    // quiet: closing to show the chosen page (focus goes there instead of back to the button).
    function closeBrowse(quiet) {
        if (!state.browse) { return false; }
        const back = state.browse.returnTo;
        state.browse = null;
        $('gp-sheet').classList.remove('open');
        $('gp-sheet').setAttribute('aria-hidden', 'true');
        if (!quiet && back) { Nav.focus(!back.classList.contains('hidden') ? back : (firstCard() || $('search-input'))); }
        return true;
    }

    /* ---- Theme music (as in Plex): a title's theme plays softly while its details are open. It loops, each time
       round easing 10% lower (90%, 80%... of its starting level), and stops once it's silent. ---- */
    const themeAudio = new Audio();
    let themeFor = null, themeFade = null, themeLoops = 0;
    const THEME_STEP = 0.1;                       // each loop is this much (of the starting level) quieter
    themeAudio.addEventListener('ended', () => {
        if (!themeFor) { return; }
        themeLoops++;
        const level = themeLevel() * Math.max(0, 1 - THEME_STEP * themeLoops);
        if (level <= 0.001) { stopTheme(true); return; }
        themeAudio.currentTime = 0;
        const p = themeAudio.play();
        if (p && p.catch) { p.catch(() => {}); }
        fadeTheme(level, 2000);
    });
    function fadeTheme(target, ms, done) {
        clearInterval(themeFade);
        const from = themeAudio.volume, steps = Math.max(1, Math.round(ms / 50));
        let i = 0;
        themeFade = setInterval(() => {
            i++;
            themeAudio.volume = Math.max(0, Math.min(1, from + (target - from) * i / steps));
            if (i >= steps) { clearInterval(themeFade); if (done) { done(); } }
        }, 50);
    }
    function playTheme(info, real) {
        if (!ui.themeMusic || !Plex.configured() || (info.kind !== 'tv' && info.kind !== 'movie')) { return; }
        Plex.findItem(info.kind, real).then(m => {
            if (!m || !m.theme || state.info !== info || Player.isOpen()) { return; }
            themeFor = info;
            themeLoops = 0;
            themeAudio.src = Plex.base() + m.theme + '?X-Plex-Token=' + encodeURIComponent(Plex.token());
            themeAudio.volume = 0;
            const p = themeAudio.play();
            if (p && p.catch) { p.catch(() => {}); }
            fadeTheme(themeLevel(), 1500);
        }, () => {});
    }
    // Settings › Theme music volume: 100% = the original level (0.45), default 50%.
    const themeLevel = () => 0.45 * (ui.themeVolume || 50) / 100;

    function stopTheme(fast) {
        if (!themeFor) { return; }
        themeFor = null;
        fadeTheme(0, fast ? 150 : 700, () => {
            if (themeFor) { return; }                 // another title's theme has started meanwhile
            themeAudio.pause();
            themeAudio.removeAttribute('src');
            try { themeAudio.load(); } catch (e) { /* ignore */ }
        });
    }

    /* ---- Play inside MediaLoader (js/player.js) ---- */

    /* TV: the episode Play starts (Plex.target), remembered on the show for this session. */
    function findTarget(item, real) {
        if (!item._targetP) {
            item._targetP = Plex.findItem('tv', real).then(show => (show ? Plex.target('tv', show) : null)).then(t => { item._target = t; return t; });
            item._targetP.catch(() => { item._targetP = null; });
        }
        return item._targetP;
    }
    function loadTarget(info, real) {
        if (!Plex.configured() || info.target) { return; }
        if (info.item._target) { info.target = info.item._target; renderInfoStatus(); return; }
        info.targetPending = true;
        renderInfoStatus();
        findTarget(info.item, real).then(t => { if (state.info === info) { info.target = t; } }, () => {})
            .then(() => { if (state.info === info) { info.targetPending = false; renderInfoStatus(); } });
    }

    function playHere(info) {
        const title = viewOf(info.kind, info.item).title;
        const btn = $('in-download');
        btn.textContent = 'Starting…';
        // TV: the exact episode the button names; otherwise let the player find it.
        const start = info.kind === 'tv' && info.target && info.target.ratingKey
            ? Player.openKey(info.target.ratingKey, info.target.resume) : lookupOf(info.item).then(real => Player.open(info.kind, real, title));
        start.then(() => { rememberPlayed(info.kind, info.item); info.item._target = null; info.item._targetP = null; })
            .catch(err => toast(err.message, 'err'))
            .then(() => { if (state.info && state.info.item === info.item) { renderInfoStatus(); } });
    }

    /* ---- Trailers, played inside MediaLoader ---- */

    // Only Plex's trailers are offered (YouTube refuses to play inside apps like this one), and only after
    // a quick check that the video really loads, so the Trailer button never leads to an error.
    function findTrailer(info, real) {
        Plex.trailer('movie', real).then(url => (url ? probeVideo(url).then(ok => (ok ? url : null)) : null)).then(url => {
            if (!url || state.info !== info) { return; }
            info.trailer = { type: 'plex', url };
            $('in-trailer').classList.remove('hidden');
        });
    }

    function probeVideo(url) {
        return new Promise(resolve => {
            const v = document.createElement('video');
            let done = false;
            const finish = ok => {
                if (done) { return; }
                done = true;
                v.removeAttribute('src');
                try { v.load(); } catch (e) { /* ignore */ }
                resolve(ok);
            };
            v.preload = 'metadata';
            v.muted = true;
            v.onloadedmetadata = () => finish(v.duration > 0);
            v.onerror = () => finish(false);
            setTimeout(() => finish(false), 10000);
            v.src = url;
        });
    }

    // Trailers play in the main player, with the same controls (scrubbing, pause, Back).
    function playTrailer() {
        const info = state.info;
        if (!info || !info.trailer) { return; }
        Player.openUrl(info.trailer.url, viewOf(info.kind, info.item).title, 'Trailer');
    }


    /* ---- "Similar" pages: same rows layout, titled "Shows similar to <title>" ---- */

    const SIMILAR_TITLE = { tv: 'Shows similar to ', movie: 'Movies similar to ', music: 'Music similar to ' };

    function openSimilar() {
        const info = state.info;
        if (!info || info.busy) { return; }          // already finding: ignore repeated OKs
        info.busy = true;
        const btn = $('in-similar');
        btn.textContent = 'Finding…';
        const kind = info.kind, item = info.item, v = viewOf(kind, item);
        const pool = [];
        (state.search[kind].feed || []).forEach(r => r.items.forEach(it => { if (pool.indexOf(it) === -1) { pool.push(it); } }));
        let base = v.title;
        lookupOf(item).then(real => {
            // Music pages are about the artist, not the album that led here.
            if (kind === 'music' && real.artistName) { base = real.artistName; }
            return Feeds.similar(kind, real, item, pool);
        }).then(rows => {
            if (state.info !== info) { return; }
            pushPage({ title: SIMILAR_TITLE[kind] + base, sub: rows.length + (rows.length === 1 ? ' row' : ' rows') + ' of suggestions', rows, from: item, reopen: 'info', button: 'in-similar' });
        }, err => {
            info.busy = false;
            if (state.info === info) { btn.textContent = 'Similar'; }
            toast(/Network|timed out|HTTP/i.test(err && err.message) ? 'Couldn\u2019t reach the recommendations service, try again' : 'No similar titles found for \u201c' + base + '\u201d', 'err');
        });
    }

    /* Pages opened from a title or person (Similar, Cast, an actor's movies & shows) stack up;
       Back returns through them one at a time, to the card that opened each. */
    function pushPage(page) {
        const s = state.search[state.kind];
        page.prev = s.similar || null;
        s.similar = page;
        closeInfo(true);
        closePerson(true);
        state.heroCard = null;
        renderRows();
        Nav.focus(firstCard() || $('search-input'));
    }

    function exitSimilar() {
        const s = state.search[state.kind];
        const page = s.similar;
        const from = page && page.from;
        s.similar = page ? page.prev : null;
        state.heroCard = null;
        renderRows(true);
        const back = Array.prototype.filter.call($('results-rows').querySelectorAll('.card'), c => c._item === from)[0];
        Nav.focus(back || firstCard() || $('search-input'));
        // Pages opened from a pop-up return to that pop-up.
        if (back && page && page.reopen === 'info') { openInfo(back); if (page.button) { Nav.focus($(page.button)); } }
        else if (back && page && page.reopen === 'person') { openPerson(back); }
        else if (page && page.reopen === 'browse') { openBrowse(page.browse.type, page.browse.name); }
    }

    /* ---- Cast and people ---- */

    function openCast() {
        const info = state.info;
        if (!info || info.busy) { return; }
        info.busy = true;
        const btn = $('in-cast');
        btn.textContent = 'Finding…';
        const kind = info.kind, item = info.item, title = viewOf(kind, item).title;
        lookupOf(item).then(real => People.cast(kind, real, item)).then(people => {
            if (state.info !== info) { return; }
            if (!people.length) { throw new Error('No cast list found for “' + title + '”'); }
            // Recast / revival-only actors (see People: annotateRecasts) get their own row after the main cast.
            const main = people.filter(c => !c._person.note), later = people.filter(c => c._person.note);
            const rows = [{ title: 'Starring', items: main.slice(0, 10) }];
            if (main.length > 10) { rows.push({ title: 'Also starring', items: main.slice(10) }); }
            if (later.length) {
                const n = later[0]._person.note;
                rows.push({ title: n === 'recast' ? 'Also played these roles' : 'In the ' + n, items: later });
            }
            pushPage({ title: 'Cast of ' + title, sub: people.length + ' people', rows, from: item, reopen: 'info', button: 'in-cast' });
        }).catch(err => {
            info.busy = false;
            if (state.info === info) { btn.textContent = 'Cast'; }
            toast(err && err.message ? err.message : 'No cast list found', 'err');
        });
    }

    const curPage = () => state.search[state.kind].similar;

    // OK on a person: an actor-search result goes straight to their movies & shows; anywhere else
    // (a cast list, the person's own page) opens their photo and biography.
    function openPersonCard(card, returnTo) {
        const item = itemOf(card);
        if (state.kind === 'people' && !curPage()) { openWorks(item); return; }
        openPerson(card, returnTo);
    }

    function openPerson(card, returnTo) {
        const item = itemOf(card), p = item._person;
        state.person = { card, item, returnTo };
        $('ps-photo').style.backgroundImage = cssUrl(p.photoFull || p.photo);
        $('ps-name').textContent = p.name;
        $('ps-sub').textContent = p.character ? 'as ' + p.character + (p.note ? ' (' + p.note + ')' : '') : (p.description || '');
        $('ps-bio').textContent = p.bio || '';
        $('ps-facts').innerHTML = '';
        $('ps-body').scrollTop = 0;
        const page = curPage();
        const onOwnPage = !!(page && page.person === item);
        $('ps-works').textContent = 'Movies & TV shows';
        $('ps-works').classList.toggle('hidden', onOwnPage);
        $('ps-sheet').classList.add('open');
        $('ps-scrim').classList.add('open');
        $('ps-sheet').setAttribute('aria-hidden', 'false');
        Nav.focus(onOwnPage ? $('ps-close') : $('ps-works'));
        updateSheetScroll();

        const live = () => state.person && state.person.item === item;
        People.details(item).then(full => {
            if (!live()) { return; }
            if (full.photoFull) { $('ps-photo').style.backgroundImage = cssUrl(full.photoFull); }
            $('ps-bio').textContent = full.bio || 'No biography available.';
            if (!p.character && full.description) { $('ps-sub').textContent = full.description; }
            updateSheetScroll();
            return People.works(item).then(rows => {
                if (!live()) { return; }
                const yearOf = it => (it.view.meta || []).filter(m => /^\d{4}$/.test(String(m)))[0];
                const facts = rows.map(r => [r.title, r.items.slice(0, 12).map(it => it.view.title + (yearOf(it) ? ' (' + yearOf(it) + ')' : '')).join(', ') +
                    (r.items.length > 12 ? ' and ' + (r.items.length - 12) + ' more' : '')]);
                $('ps-facts').innerHTML = facts.map(f => '<dt>' + esc(f[0]) + '</dt><dd>' + esc(f[1]) + '</dd>').join('');
                const n = rows.reduce((t, r) => t + r.items.length, 0);
                if (!n) { $('ps-works').classList.add('hidden'); if (Nav.current() === $('ps-works')) { Nav.focus($('ps-close')); } }
                else if (!onOwnPage) { $('ps-works').textContent = 'Movies & TV shows (' + n + ')'; }
                updateSheetScroll();
            });
        }).catch(() => { if (live() && !$('ps-bio').textContent) { $('ps-bio').textContent = 'Couldn’t load a biography.'; } });
    }

    // Their movies and shows as rows, with the person first so their biography is a highlight away.
    function openWorks(item) {
        if (item._worksBusy) { return; }
        item._worksBusy = true;
        const fromSheet = !!(state.person && state.person.item === item);
        const name = item._person.name;
        if (state.person && state.person.item === item) { $('ps-works').textContent = 'Finding…'; }
        else { toast('Finding movies and TV shows for ' + name); }
        People.works(item).then(rows => {
            if (!rows.length) { throw new Error('No movies or TV shows found for ' + name); }
            item._worksBusy = false;
            const counts = rows.map(r => r.items.length + ' ' + (r.title === 'Movies' ? (r.items.length === 1 ? 'movie' : 'movies') : (r.items.length === 1 ? 'TV show' : 'TV shows')));
            pushPage({ title: name, sub: counts.join(' \u00b7 '), rows: [{ title: 'About', items: [item] }].concat(rows), from: item, person: item, reopen: fromSheet ? 'person' : '' });
        }).catch(err => {
            item._worksBusy = false;
            if (state.person && state.person.item === item) { $('ps-works').textContent = 'Movies & TV shows'; }
            toast(err && err.message ? err.message : 'Couldn’t find their movies and shows', 'err');
        });
    }

    function closePerson(noFocus) {
        if (!state.person) { return false; }
        const card = state.person.returnTo || state.person.card;
        state.person = null;
        $('ps-sheet').classList.remove('open');
        $('ps-scrim').classList.remove('open');
        $('ps-sheet').setAttribute('aria-hidden', 'true');
        if (noFocus === true) { return true; }
        if (card && card.parentNode) { Nav.focus(card); } else { Nav.focusFirst(); }
        return true;
    }

    function closeInfo(noFocus) {
        if (!state.info) { return false; }
        stopTheme();
        const card = state.info.returnTo || state.info.card;
        state.info = null;
        $('info-sheet').classList.remove('open');
        $('info-scrim').classList.remove('open');
        $('info-sheet').setAttribute('aria-hidden', 'true');
        if (noFocus === true) { return true; }
        if (card && card.parentNode) { Nav.focus(card); } else { Nav.focusFirst(); }
        return true;
    }

    function download(card) {
        const kind = card._kind || kindOf(itemOf(card));
        const item = itemOf(card);
        const title = viewOf(kind, item).title;
        item._searching = true;
        updateAllCards();

        let existing = false;
        lookupOf(item).then(real => {
            existing = inLibrary(real);
            if (existing) { item.id = real.id; return Api.searchExisting(kind, real.id).then(() => real); }
            return Api.add(kind, real, item.addOptions);
        }).then(saved => {
            if (saved && saved.id) { item.id = saved.id; }
            if (item._feed && item.key) { delete libCache[kind + '|' + item.key]; }
            trackRequest(kind, item);
            toast((existing ? 'Already in your library — searching for “' : 'Added “') + title + '”. ' + svc(kind).app + ' is finding a download', 'ok');
            schedulePoll(3000);
        }, err => {
            item._searching = false;
            toast(title + ': ' + err.message, 'err');
        }).then(updateAllCards);
    }

    /* ===================== downloads (same browsing layout as the other screens) ===================== */

    // Rows of download cards, grouped by what needs your attention first.
    function downloadRows() {
        const q = dlItems();
        const group = (title, states) => ({ title, items: q.filter(x => states.indexOf(x.state) !== -1) });
        return [
            group('Needs attention', ['attention', 'failed']),
            group('Not found yet', ['notfound']),
            group('Downloading', ['downloading']),
            group('Importing', ['importing']),
            group('Searching', ['searching']),
            group('Waiting', ['queued']),
            group('Not downloaded yet', ['pending']),
            group('Recently downloaded', ['recent'])
        ].filter(r => r.items.length);
    }

    /* ---- requested titles: anything you download is remembered, so a search that finds nothing
       still shows on the Downloads page ("Not found yet") instead of silently disappearing ---- */

    const REQ_KEY = 'medialoader.requests';
    const DAY_MS = 86400000;
    let requests = (() => { try { return JSON.parse(localStorage.getItem(REQ_KEY) || '[]') || []; } catch (e) { return []; } })();
    const saveRequests = () => { try { localStorage.setItem(REQ_KEY, JSON.stringify(requests)); } catch (e) { /* storage unavailable */ } };

    function trackRequest(kind, item) {
        if (!(item.id > 0)) { return; }
        const v = viewOf(kind, item);
        const key = kind + ':' + item.id;
        requests = [{ key, kind, mediaId: item.id, title: v.title, poster: v.poster || '', overview: v.overview || '', at: Date.now(), state: 'searching' }]
            .concat(requests.filter(r => r.key !== key)).slice(0, 40);
        saveRequests();
    }

    const inQueue = r => state.queue.some(q => q.kind === r.kind && q.mediaId === r.mediaId);

    // Requests shown as cards: only those not already represented by a real queue item.
    function requestItems() {
        return requests.filter(r => !inQueue(r) && (r.state === 'searching' || r.state === 'notfound')).map(r => {
            const app = svc(r.kind).app;
            const notFound = r.state === 'notfound';
            return {
                key: 'req:' + r.key, _request: r, kind: r.kind, mediaId: r.mediaId,
                title: r.title, poster: r.poster, overview: r.overview, app,
                sub: notFound ? 'No release found yet' : 'Looking for a release',
                state: r.state, label: notFound ? 'Not found yet' : 'Searching…', progress: 0, sizeText: '',
                message: notFound ? app + ' searched but found no release that matches your quality profile. It keeps checking automatically as new releases appear, or choose Search again.' : ''
            };
        });
    }

    function extraItems() {
        const reqs = requestItems();
        const busy = (kind, id) => state.queue.some(q => q.kind === kind && q.mediaId === id) || reqs.some(r => r.kind === kind && r.mediaId === id);
        return (state.wanted || []).filter(x => !busy(x.kind, x.mediaId)).concat(state.recent || []);
    }
    const dlItems = () => state.queue.concat(requestItems(), extraItems());

    /* Pending + recently downloaded: fetched when Downloads opens and every 2 minutes while it's open. */
    let lastExtras = 0;
    function refreshExtras(force) {
        if (!force && Date.now() - lastExtras < 120000) { return; }
        lastExtras = Date.now();
        return Promise.all([Api.wanted(), Api.recent()]).then(r => {
            state.wanted = r[0]; state.recent = r[1];
            if (state.dlMode && state.screen === 'search') { renderDownloadRows(); }
            // At start-up, fetch the posters too, so the Downloads page opens with its artwork in place.
            if (state.booting) { return warmDownloads(); }
        }, () => {}).then(() => { state.extrasDone = true; });
    }

    // Loads the posters of the Downloads page's first cards; resolves when they're in (or after 6 s).
    function warmDownloads() {
        const urls = [];
        downloadRows().forEach((row, r) => row.items.slice(0, r < 3 ? ROW_FIRST : 0).forEach(q => {
            if (q.poster && urls.indexOf(q.poster) === -1) { urls.push(q.poster); }
        }));
        if (!urls.length) { return Promise.resolve(); }
        return new Promise(resolve => {
            let left = urls.length;
            const one = () => { if (--left <= 0) { resolve(); } };
            urls.forEach(u => { const img = new Image(); img.onload = one; img.onerror = one; img.src = u; });
            setTimeout(resolve, 6000);
        });
    }

    /* Every minute (and when Downloads opens): requests that reached the disk are cleared with a
       "ready" message; ones still missing after 3 minutes, and not downloading, become "Not found yet". */
    let lastRequestCheck = 0;
    function checkRequests(force) {
        const now = Date.now();
        if (!requests.length || (!force && now - lastRequestCheck < 60000)) { return; }
        lastRequestCheck = now;
        requests = requests.filter(r => now - r.at < 14 * DAY_MS);
        Promise.all(requests.map(r => {
            if (!Api.configured(r.kind)) { return null; }
            if (inQueue(r)) { r.state = 'downloading'; return null; }
            return Api.libraryStatus(r.kind, r.mediaId).then(st => {
                if (st.available) { r.state = 'done'; toast('“' + r.title + '” is ready to watch', 'ok'); }
                else { r.state = now - r.at > 3 * 60000 ? 'notfound' : 'searching'; }
            }, err => { if (err && err.status === 404) { r.state = 'done'; } });   // removed from the app
        })).then(() => {
            requests = requests.filter(r => r.state !== 'done');
            saveRequests();
            if (state.dlMode && state.screen === 'search') { renderDownloadRows(); }
            updateBadge();
        });
    }

    function downloadsSummary() {
        const q = dlItems();
        if (!state.queueLoaded) { return ''; }
        const count = s => q.filter(x => x.state === s).length;
        const bad = count('attention') + count('failed');
        const parts = [];
        if (count('downloading')) { parts.push('<b>' + count('downloading') + '</b> downloading'); }
        if (count('importing')) { parts.push('<b>' + count('importing') + '</b> importing'); }
        if (count('queued')) { parts.push('<b>' + count('queued') + '</b> waiting'); }
        if (bad) { parts.push('<span class="warn">' + bad + ' need' + (bad === 1 ? 's' : '') + ' attention</span>'); }
        if (count('notfound')) { parts.push('<span class="warn">' + count('notfound') + ' not found yet</span>'); }
        if (count('searching')) { parts.push('<b>' + count('searching') + '</b> searching'); }
        if (count('pending')) { parts.push('<b>' + count('pending') + '</b> not downloaded yet'); }
        if (count('recent')) { parts.push('<b>' + count('recent') + '</b> downloaded recently'); }
        const left = q.reduce((sum, x) => sum + (x.state === 'downloading' || x.state === 'queued' ? x.sizeLeft : 0), 0);
        if (left > 0) { parts.push(formatBytes(left) + ' to go'); }
        state.queueErrors.forEach(e => parts.push('<span class="warn">' + esc(e) + '</span>'));
        return parts.join(' · ');
    }

    function openDownloads(focusKey) {
        state.dlMode = true;
        state.heroCard = null;
        checkRequests(true);
        refreshExtras(!state.wanted);          // loaded at start-up; refreshed here when over 2 minutes old
        show('search', null, 'downloads');
        renderDownloadRows(true);
        const target = focusKey ? cardForKey(focusKey) : null;
        if (target || firstCard()) { Nav.focus(target || firstCard()); }
        else { setHero(introHero()); Nav.focus($('hero-browse')); }
    }

    const cardForKey = key => Array.prototype.filter.call($('results-rows').querySelectorAll('.card'), c => c._q && c._q.key === key)[0] || null;

    // Cards are narrow, so use short labels there (the hero shows the full one).
    function cardStatus(q) {
        const s = queueStatus(q);
        if (s.state === 'attention') { s.label = 'Attention'; }
        if (s.state === 'notfound') { s.label = 'Not found'; }
        if (s.state === 'recent') { s.state = 'ondisk'; s.label = 'Downloaded ' + ago(q.date); }
        return s;
    }

    function updateQueueCard(card) {
        const q = card._q;
        // Posters load row by row as you reach them (like the other screens); rows already shown update in place.
        card._poster = q.poster || '';
        if (!q.poster) { card.style.backgroundImage = ''; card._posterShown = ''; }
        else if (card._posterShown) { showPoster(card); }       // already showing: keep it current
        // "Not downloaded yet" cards need no chip: the row heading already says it.
        card.innerHTML = (q.poster ? '' : placeholder(q.kind, q.title)) +
            '<div class="st">' + (q.state === 'pending' ? '' : statusHtml(cardStatus(q))) + '</div>';
    }

    // Rebuilds the rows only when downloads appear, move between groups or finish; otherwise just
    // refreshes progress in place, so polling never moves your focus.
    let dlSignature = '';
    function renderDownloadRows(force) {
        applyMode();
        const rows = downloadRows();
        const sig = rows.map(r => r.title + ':' + r.items.map(i => i.key).join(',')).join('|');
        const cur = Nav.current();

        if (!force && sig === dlSignature) {
            const all = dlItems();
            Array.prototype.forEach.call($('results-rows').querySelectorAll('.card'), card => {
                const q = all.filter(x => x.key === card._q.key)[0];
                if (q) { card._q = q; updateQueueCard(card); }
            });
            if (isCard(cur) || cur === $('hero-more')) { setHero(heroForSearchBox(), true); }
            return;
        }
        dlSignature = sig;
        const focusedKey = isCard(cur) && cur._q ? cur._q.key : null;
        const hadFocus = isCard(cur) || cur === $('hero-more') || cur === $('hero-browse');

        const inner = $('results-rows');
        inner.innerHTML = '';
        inner.style.transform = 'translate3d(0,0,0)';
        inner.setAttribute('data-y', '0');
        $('results-empty').classList.add('hidden');

        rows.forEach((row, r) => {
            const rowEl = el('div', 'row', '<h3 class="row-title"></h3><div class="row-viewport"><div class="row-track"></div></div>');
            rowEl.querySelector('.row-title').textContent = row.title + ' (' + row.items.length + ')';
            rowEl.style.animationDelay = Math.min(r, 4) * 70 + 'ms';
            const track = rowEl.querySelector('.row-track');
            row.items.forEach((q, i) => {
                const card = el('button', 'card in focusable');
                card._q = q;
                card.style.animationDelay = (Math.min(r, 3) * 70 + Math.min(i, 8) * 45) + 'ms';
                card.addEventListener('click', () => {
                    if (card._q.item) { card._item = card._q.item; card._kind = card._q.kind; openInfo(card); }
                    else { openDetails(card._q.key); }
                });
                track.appendChild(card);
                updateQueueCard(card);
            });
            inner.appendChild(rowEl);
        });
        Array.prototype.slice.call(inner.children, 0, 3).forEach(loadRowArt);   // the rest load as you scroll to them

        if (hadFocus) {
            const target = (focusedKey && cardForKey(focusedKey)) || firstCard();
            if (!target) { setHero(introHero()); }
            Nav.focus(target || $('hero-browse'));
        }
        if (!firstCard()) { setHero(introHero()); }
        else if (!isCard(Nav.current())) { setHero(heroForSearchBox()); }
    }

    function heroForQueue(card) {
        const q = card._q;
        return {
            card,
            title: q.title,
            meta: [q.sub, q.app, q.state === 'downloading' ? q.eta : '', q.sizeText,
                q._request ? 'Requested ' + longDate(q._request.at) : '',
                q.state === 'recent' ? 'Downloaded ' + ago(q.date) : ''].filter(Boolean),
            status: queueStatus(q),
            overview: q.message || q.overview || '',
            backdrop: q.poster
        };
    }

    /* ---- download details panel ---- */

    let sheetKey = null, sheetReturn = null, cancelArmed = null, cancelTimer = null;
    const CANCEL_TEXT = { 'ds-cancel': 'Cancel download', 'ds-blocklist': 'Find another release', 'settings-reset': 'Reset to defaults' };
    const REQUEST_TEXT = { 'ds-cancel': 'Remove from list', 'ds-blocklist': 'Search again' };
    const sheetItem = () => dlItems().filter(x => x.key === sheetKey)[0];
    const buttonText = btn => {
        const it = sheetKey && sheetItem();
        return (it && it._request && REQUEST_TEXT[btn.id]) || CANCEL_TEXT[btn.id];
    };

    function openDetails(key, returnTo) {
        sheetKey = key;
        sheetReturn = returnTo || null;
        if (!renderDetails()) { return; }
        $('dl-scrim').classList.add('open');
        $('dl-sheet').setAttribute('aria-hidden', 'false');
        // Start on "Close" so a stray OK never cancels anything; Cancel is one step left.
        Nav.focus($('ds-close'));
    }

    function closeDetails() {
        if (!sheetKey) { return false; }
        const key = sheetKey;
        sheetKey = null;
        disarmCancel();
        $('dl-sheet').classList.remove('open');
        $('dl-scrim').classList.remove('open');
        $('dl-sheet').setAttribute('aria-hidden', 'true');
        const target = (sheetReturn && document.body.contains(sheetReturn) && !sheetReturn.classList.contains('hidden') ? sheetReturn : null) || cardForKey(key) || firstCard();
        sheetReturn = null;
        if (!target) { setHero(introHero()); }
        Nav.focus(target || $('hero-browse'));
        return true;
    }

    function renderDetails() {
        const it = sheetItem();
        if (!it) {
            closeDetails();
            toast('That download has finished or was removed');
            return false;
        }
        const sheet = $('dl-sheet');
        sheet.className = 'sheet open ' + it.state;
        $('ds-thumb').style.backgroundImage = cssUrl(it.poster);
        $('ds-app').textContent = it.app + ' · ' + svc(it.kind).label;
        $('ds-title').textContent = it.title;
        $('ds-sub').textContent = it.sub || '';
        $('ds-desc').textContent = it.overview || 'No description available for this ' + (it.kind === 'tv' ? 'episode' : it.kind === 'movie' ? 'movie' : 'album') + '.';
        $('ds-desc').classList.toggle('none', !it.overview);
        $('ds-state').textContent = it.label;
        $('ds-pct').textContent = pct(it.state === 'importing' ? 1 : it.progress);
        $('ds-bar').style.width = pct(it.state === 'importing' ? 1 : it.progress);
        $('ds-eta').textContent = [it.state === 'downloading' ? it.eta : '', it.sizeText].filter(Boolean).join(' · ');
        const msg = (it.messages || []).join(' ');
        $('ds-msg').textContent = msg;
        $('ds-msg').classList.toggle('hidden', !msg);

        const facts = [
            ['File', it.release],
            ['Quality', it.quality + (it.languages ? ' · ' + it.languages : '')],
            ['Source', it.protocol + (it.indexer ? ' · ' + it.indexer : '')],
            ['Downloader', it.client],
            ['Saving to', it.outputPath],
            ['Added', it.added ? new Date(it.added).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '']
        ].filter(f => f[1] && String(f[1]).trim());
        $('ds-facts').innerHTML = facts.map(f => '<dt>' + f[0] + '</dt><dd>' + esc(f[1]) + '</dd>').join('');

        // A requested title that hasn't reached the queue: explain, and offer Search again / Remove.
        if (it._request) {
            $('ds-pct').textContent = '';
            $('ds-eta').textContent = 'Requested ' + longDate(it._request.at);
            const qp = (Api.settings()[it.kind] || {}).qualityProfile;
            $('ds-facts').innerHTML = [['Status', it.state === 'notfound' ? 'No release found yet · checking automatically' : 'Searching'],
                ['Quality', qp || 'App default'], ['App', it.app]]
                .map(f => '<dt>' + f[0] + '</dt><dd>' + esc(f[1]) + '</dd>').join('');
        }
        if (!cancelArmed) { $('ds-cancel').textContent = buttonText($('ds-cancel')); $('ds-blocklist').textContent = buttonText($('ds-blocklist')); }
        return true;
    }

    // Cancelling needs a second OK, like downloading does.
    function onCancelOk(btn, blocklist) {
        const req = sheetItem() && sheetItem()._request;
        if (req && blocklist) {                     // "Search again": harmless, no confirmation needed
            Api.searchExisting(req.kind, req.mediaId).then(() => {
                req.at = Date.now(); req.state = 'searching'; saveRequests();
                toast('Searching again for “' + req.title + '”', 'ok');
                closeDetails(); renderDownloadRows();
            }, err => toast('Couldn’t search: ' + err.message, 'err'));
            return;
        }
        if (cancelArmed !== btn) {
            disarmCancel();
            cancelArmed = btn;
            btn.classList.add('confirming');
            btn.textContent = 'OK again to confirm';
            cancelTimer = setTimeout(disarmCancel, 5000);
            return;
        }
        disarmCancel();
        const it = sheetItem();
        if (!it) { closeDetails(); return; }
        if (it._request) {                          // "Remove from list": stops tracking; the title stays in the app
            requests = requests.filter(r => r !== it._request); saveRequests();
            toast('Removed “' + it.title + '” from the list', 'ok');
            closeDetails(); renderDownloadRows(); updateBadge();
            return;
        }
        btn.textContent = 'Cancelling…';
        Api.removeQueue(it.kind, it.id, blocklist).then(() => {
            toast(blocklist ? 'Cancelled — ' + it.app + ' will look for a different release' : 'Cancelled “' + it.title + '”', 'ok');
            state.queue = state.queue.filter(x => x.key !== it.key);
            closeDetails();
            renderDownloadRows();
            afterQueue();
            schedulePoll(blocklist ? 4000 : 1500);
        }, err => {
            btn.textContent = buttonText(btn);
            toast('Couldn’t cancel: ' + err.message, 'err');
        });
    }

    function disarmCancel() {
        clearTimeout(cancelTimer);
        if (cancelArmed) {
            cancelArmed.classList.remove('confirming');
            cancelArmed.textContent = buttonText(cancelArmed);
        }
        cancelArmed = null;
    }

    function formatBytes(n) {
        const u = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
        return (n / Math.pow(1024, i)).toFixed(i >= 3 ? 1 : 0) + ' ' + u[i];
    }

    /* ---- polling: fast on the Downloads page, relaxed elsewhere ---- */

    function schedulePoll(delay) {
        clearTimeout(state.pollTimer);
        state.pollTimer = setTimeout(refreshQueue, delay);
    }

    function refreshQueue() {
        if (!Api.KINDS.some(Api.configured)) { state.queueLoaded = true; afterQueue(); return; }
        Api.queues().then(r => {
            state.queue = r.items;
            state.queueErrors = r.errors;
            state.queueLoaded = true;
            // Once a search turns into a real download, the queue takes over the card status.
            Api.KINDS.forEach(kind => state.search[kind].results.forEach(item => {
                if (item._searching && state.queue.some(q => q.kind === kind && q.mediaId === item.id)) { item._searching = false; }
            }));
            afterQueue();
        });
    }

    function updateBadge() {
        const n = state.queue.length + requestItems().filter(r => r.state === 'notfound').length;
        const badge = $('rail-badge');
        badge.textContent = n > 99 ? '99+' : String(n);
        badge.classList.toggle('hidden', n === 0);
    }

    function afterQueue() {
        updateBadge();
        checkRequests();
        if (state.dlMode && state.screen === 'search') { renderDownloadRows(); refreshExtras(); if (sheetKey) { renderDetails(); } }
        updateAllCards();
        schedulePoll(state.dlMode ? 4000 : 15000);
    }

    /* ===================== settings ===================== */

    function openSettings(focusKind) {
        state.dlMode = false;
        renderSettings();
        show('settings');
        Nav.focusFirst(focusKind ? '#' + focusKind + '-key' : '#sound-toggle');
        testAll();
    }

    function renderSettings() {
        const form = $('settings-form');
        const s = Api.settings();
        form.innerHTML = '';
        Api.KINDS.forEach(kind => {
            const box = el('div', 'svc',
                '<div class="svc-name"><b>' + svc(kind).app + '</b><span class="svc-state" id="' + kind + '-state">' + svc(kind).label + '</span></div>' +
                '<div class="svc-fields">' +
                '<div class="svc-field"><label>Server address</label><input class="focusable" type="text" id="' + kind + '-url" spellcheck="false" autocomplete="off"></div>' +
                '<div class="svc-field"><label>Download quality</label><button class="select focusable" id="' + kind + '-quality" type="button"><span class="select-value"></span>' +
                '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button></div>' +
                '<div class="svc-field wide"><label>API key</label><input class="focusable" type="text" id="' + kind + '-key" spellcheck="false" autocomplete="off" placeholder="Paste or type the key"></div>' +
                '</div>');
            form.appendChild(box);
            if (kind === Api.KINDS[Api.KINDS.length - 1]) {
                // Down from the last key goes to Save, never to Reset.
                $(kind + '-key').setAttribute('data-nav-down', '#settings-save');
            }
            $(kind + '-url').value = s[kind].url || '';
            $(kind + '-url').setAttribute('data-nav-down', '#' + kind + '-key');      // address → its own API key
            setupKeyField($(kind + '-key'), s[kind].apiKey || '');
            setupQualityField(kind, s[kind].qualityProfile || '');
        });

        // Preferences: apply and save straight away (no Save needed).
        const box = el('div', 'svc',
            '<div class="svc-name"><b>Preferences</b><span class="svc-state">Saved as soon as you change them</span></div>' +
            '<div class="svc-fields">' +
            '<div class="svc-field"><label>Remote sounds</label>' +
            '<button class="select toggle focusable" id="sound-toggle" type="button" data-nav-down="#libfirst-toggle"><span class="select-value"></span><i class="switch"></i></button></div>' +
            '<div class="svc-field"><label>Plex app button</label>' +
            '<button class="select toggle focusable" id="plexapp-toggle" type="button" data-nav-down="#theme-toggle"><span class="select-value"></span><i class="switch"></i></button></div>' +
            '<div class="svc-field"><label>In library first</label>' +
            '<button class="select toggle focusable" id="libfirst-toggle" type="button" data-nav-down="#themevol" data-nav-up="#sound-toggle"><span class="select-value"></span><i class="switch"></i></button></div>' +
            '<div class="svc-field"><label>Theme music</label>' +
            '<button class="select toggle focusable" id="theme-toggle" type="button" data-nav-down="#themevol" data-nav-up="#plexapp-toggle"><span class="select-value"></span><i class="switch"></i></button></div>' +
            '<div class="svc-field"><label>Theme music volume</label>' +
            '<button class="select focusable" id="themevol" type="button" data-nav-down="#tv-url" data-nav-up="#libfirst-toggle"><span class="select-value"></span>' +
            '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button></div>' +
            '</div>');
        form.insertBefore(box, form.firstChild);          // Preferences come first
        const toggle = (id, get, set, onLabel) => {
            const t = $(id);
            const paint = () => { t.classList.toggle('on', get()); t.querySelector('.select-value').textContent = get() ? onLabel : 'Off'; };
            t.addEventListener('click', () => { set(!get()); paint(); });
            paint();
        };
        toggle('sound-toggle', () => Sounds.enabled(), v => { Sounds.setEnabled(v); if (v) { Sounds.play('select'); } }, 'On');
        toggle('plexapp-toggle', () => ui.plexApp, v => { ui.plexApp = v; saveUi(); }, 'Shown in title details');
        toggle('libfirst-toggle', () => ui.libraryFirst, v => { ui.libraryFirst = v; saveUi(); }, 'Titles you have, then ones to download');
        toggle('theme-toggle', () => ui.themeMusic, v => { ui.themeMusic = v; saveUi(); if (!v) { stopTheme(true); } }, 'Plays in title details');
        // OK steps through the levels.
        const vol = $('themevol'), VOLS = [25, 50, 75, 100];
        const paintVol = () => { vol.querySelector('.select-value').textContent = (ui.themeVolume || 50) + '%'; };
        vol.addEventListener('click', () => {
            ui.themeVolume = VOLS[(VOLS.indexOf(ui.themeVolume || 50) + 1) % VOLS.length];
            saveUi(); paintVol();
        });
        paintVol();
    }

    /* API keys are never shown in full: only the last 4 characters are visible.
       Editing starts with an empty field; leaving it empty keeps the current key. */
    const maskKey = k => (k ? new Array(13).join('•') + k.slice(-4) : '');

    function setupKeyField(input, key) {
        input._real = key;
        input.value = maskKey(key);
        input.placeholder = 'Not set — press OK to enter';
        input.addEventListener('focus', () => {
            input.value = '';
            input.placeholder = input._real ? 'Type a new key, or leave empty to keep ' + maskKey(input._real) : 'Type or paste the API key';
        });
        input.addEventListener('blur', () => {
            const typed = input.value.trim();
            if (typed && typed.indexOf('•') === -1) { input._real = typed; }
            input.value = maskKey(input._real);
            input.placeholder = 'Not set — press OK to enter';
        });
    }

    /* Download quality: a button showing the chosen profile; OK opens a list of the app's real profiles.
       '' means the app default (Sonarr/Radarr: first profile; Lidarr: the root folder's default). */
    const DEFAULT_LABEL = { tv: 'Sonarr default (first profile)', movie: 'Radarr default (first profile)', music: 'Lidarr default (root folder setting)' };

    function setupQualityField(kind, value) {
        const btn = $(kind + '-quality');
        btn._value = value;
        btn._options = null;
        const label = () => { btn.querySelector('.select-value').textContent = btn._value || DEFAULT_LABEL[kind]; };
        label();
        btn._label = label;
        btn.addEventListener('click', () => openPicker(kind));
        if (Api.configured(kind)) {
            Api.qualityProfiles(kind).then(list => { btn._options = list; }, () => { btn._options = []; });
        }
    }

    function openPicker(kind) {
        const btn = $(kind + '-quality');
        if (!btn._options) {
            toast(Api.configured(kind) ? 'Still loading the quality profiles — try again in a moment' : 'Add the ' + svc(kind).app + ' API key and Save first', 'err');
            return;
        }
        const names = [''].concat(btn._options.map(o => o.name));
        $('qp-title').textContent = svc(kind).app + ' download quality';
        $('qp-sub').textContent = 'Used when Reelhouse adds a new ' + svc(kind).noun + '.';
        const list = $('qp-list');
        list.innerHTML = '';
        let current = null;
        names.forEach(name => {
            const item = el('button', 'picker-item focusable' + (name === btn._value ? ' selected' : ''), '<span></span>');
            item.type = 'button';
            item.querySelector('span').textContent = name || DEFAULT_LABEL[kind];
            item.addEventListener('click', () => {
                btn._value = name;
                btn._label();
                closePicker();
                toast('Press Save & test to keep this change');
            });
            if (name === btn._value) { current = item; }
            list.appendChild(item);
        });
        state.picker = kind;
        list.scrollTop = 0;
        $('qp-scrim').classList.add('open');
        $('qp-sheet').classList.add('open');
        $('qp-sheet').setAttribute('aria-hidden', 'false');
        Nav.focus(current || list.firstElementChild);
    }

    function closePicker() {
        if (!state.picker) { return false; }
        const kind = state.picker;
        state.picker = null;
        $('qp-scrim').classList.remove('open');
        $('qp-sheet').classList.remove('open');
        $('qp-sheet').setAttribute('aria-hidden', 'true');
        Nav.focus($(kind + '-quality'));
        return true;
    }

    function readSettingsForm() {
        const s = {};
        Api.KINDS.forEach(kind => {
            const keyInput = $(kind + '-key');
            const typed = document.activeElement === keyInput ? keyInput.value.trim() : '';
            s[kind] = { url: $(kind + '-url').value.trim(), apiKey: typed || keyInput._real || '', qualityProfile: $(kind + '-quality')._value || '' };
        });
        return s;
    }

    function testAll() {
        return Promise.all(Api.KINDS.map(kind => {
            const st = $(kind + '-state');
            if (!Api.configured(kind)) { st.className = 'svc-state err'; st.textContent = 'API key needed'; return false; }
            st.className = 'svc-state'; st.textContent = 'Checking…';
            return Api.test(kind).then(info => {
                st.className = 'svc-state ok'; st.textContent = '● Connected' + (info && info.version ? ' · v' + info.version : '');
                return true;
            }, err => { st.className = 'svc-state err'; st.textContent = err.message; return false; });
        }));
    }

    function saveSettings() {
        Api.saveSettings(readSettingsForm());
        testAll().then(ok => {
            const good = ok.filter(Boolean).length;
            toast(good === 3 ? 'All three servers connected' : good + ' of 3 servers connected', good === 3 ? 'ok' : 'err');
            schedulePoll(0);
        });
    }

    /* ===================== loading screen ===================== */

    /* Stays up until the first screen's rows exist and their first posters (plus the banner image) have
       loaded, so the app appears complete. Gives up after 12 s so a slow image never blocks the app. */
    function runSplash() {
        const splash = $('splash'), bar = $('splash-bar'), text = $('splash-text');
        const started = Date.now();
        const MIN_SHOWN = 800;                // long enough that the name doesn't just flash past
        let shownAt = 0, rowsAt = 0, finished = false, closeTimer = null;

        // The name and the bar fade in straight away.
        const reveal = () => {
            if (shownAt) { return; }
            shownAt = Date.now();
            splash.classList.add('ready');
            if (finished) { scheduleClose(); }
        };
        reveal();

        const scheduleClose = () => {
            clearTimeout(closeTimer);
            const from = Math.max(shownAt, rowsAt || shownAt);
            closeTimer = setTimeout(() => {
                // The loading screen fades out as the interface fades in, with the start-up chime.
                splash.classList.add('done');
                $('app').classList.remove('intro');
                Sounds.play('intro');
                setTimeout(() => { splash.parentNode && splash.parentNode.removeChild(splash); afterBoot(); }, 700);
            }, Math.max(0, MIN_SHOWN - (Date.now() - from)));
        };
        const finish = () => {
            if (finished) { return; }
            finished = true;
            bar.style.width = '100%';
            if (shownAt) { scheduleClose(); }
        };
        setTimeout(finish, 12000);

        // Wait for the rows (instant from the saved copy; a few seconds on the very first launch).
        const waitRows = () => {
            if (finished) { return; }
            const cards = Array.prototype.slice.call($('results-rows').querySelectorAll('.card'));
            if (!cards.length) {
                // No server set up: nothing to wait for.
                if (state.screen !== 'search') { rowsAt = Date.now(); finish(); return; }
                bar.style.width = Math.min(30, 5 + (Date.now() - started) / 200) + '%';
                setTimeout(waitRows, 150);
                return;
            }
            rowsAt = rowsAt || Date.now();
            const urls = [];
            cards.slice(0, 10).forEach(c => {
                const m = /url\("?(.*?)"?\)/.exec(c.style.backgroundImage || '');
                if (m && m[1] && urls.indexOf(m[1]) === -1) { urls.push(m[1]); }
            });
            const first = itemOf(cards[0]);
            const backdrop = first && viewOf(state.kind, first).backdrop;
            if (backdrop) { urls.push(heroImage(backdrop)); }
            // Also wait for the Downloads page's data (and the queue), up to 10 s from start.
            const ready = () => {
                if ((state.extrasDone && state.queueLoaded) || Date.now() - started > 10000) { finish(); } else { setTimeout(ready, 150); }
            };
            if (!urls.length) { ready(); return; }
            let done = 0;
            const step = () => {
                done++;
                bar.style.width = (30 + 70 * done / urls.length) + '%';
                if (done >= urls.length) { ready(); }
            };
            urls.forEach(u => { const img = new Image(); img.onload = step; img.onerror = step; img.src = u; });
        };
        waitRows();
    }

    /* ===================== wiring ===================== */

    function onFocus(node) {
        if (cancelArmed && node !== cancelArmed) { disarmCancel(); }
        if (node && node.classList && node.classList.contains('picker-item')) {
            const list = $('qp-list');
            if (node.offsetTop < list.scrollTop) { list.scrollTop = node.offsetTop; }
            else if (node.offsetTop + node.offsetHeight > list.scrollTop + list.clientHeight) { list.scrollTop = node.offsetTop + node.offsetHeight - list.clientHeight; }
        }
        stopMarquee();
        if (node && node.classList && node.classList.contains('season-card')) { scrollSeasons(node); infoNav.season = node.id; updateInfoNav(); startMarquee(node.querySelector('b')); }
        if (node && node.classList && node.classList.contains('ep')) { startMarquee(node.querySelector('.ep-text h3')); }
        if (node && node.classList && node.classList.contains('gp-tile')) { scrollBrowse(node); }
        if (node && node.classList && node.classList.contains('art-card')) {
            const track = node.parentNode, view = track.parentNode;
            const x = Math.max(0, Math.min(node.offsetLeft - (view.clientWidth - node.offsetWidth) / 2, track.scrollWidth - view.clientWidth));
            track.style.transform = 'translate3d(' + (-x) + 'px,0,0)';
        }
        if (node && node.parentNode && node.parentNode.classList && node.parentNode.classList.contains('sheet-actions') && node.closest('#info-sheet')) {
            infoNav.btn = node.id; updateInfoNav();
        }
        if (node && node.classList && node.classList.contains('ep')) { scrollEpisodes(node); }
        if (seasonArm && node !== seasonArm) { disarmSeason(); }
        const inKb = !!(node && node.classList && node.classList.contains('kb-key'));
        if (state.keyboard && !inKb && node !== $('search-input')) { closeKeyboard(false); }
        const line = document.querySelector('.search-line');
        line.classList.toggle('has-focus', node === $('search-input') || inKb);
        line.classList.toggle('is-editing', node === $('search-input') && Nav.isEditing());
        if (state.screen === 'search' && isCard(node)) {
            state.heroCard = node; setHero(heroFor(node));
            // Load this row's and the next two rows' posters ahead of time.
            let r = node.closest('.row');
            for (let i = 0; i < 3 && r; i++, r = r.nextElementSibling) { loadRowArt(r); }
            loadAhead(node);
        }
        else if (state.screen === 'search' && (node === $('search-input') || node === $('hero-more'))) { setHero(heroForSearchBox()); }
        // Once you move somewhere yourself, stop waiting to jump to the first poster.
        if (node && node !== $('search-input')) { state.autoFocus = null; }
    }

    function init() {
        state.booting = true;
        document.addEventListener('keydown', () => { lastKeyAt = Date.now(); }, true);
        $('app').classList.add('intro');          // hidden behind the loading screen; fades in when it closes
        // Rail
        const railItems = document.querySelectorAll('.rail-item');
        for (let i = 0; i < railItems.length; i++) {
            const it = railItems[i];
            it.addEventListener('click', () => {
                const nav = it.getAttribute('data-nav');
                if (nav === 'search') { openSearch(it.getAttribute('data-kind')); }
                else if (nav === 'downloads') { openDownloads(); }
                else if (nav === 'settings') { openSettings(); }
            });
        }

        $('search-input').addEventListener('input', liveSearch);
        buildKeyboard();
        // Desktop: typing on a real keyboard while the letter grid is open types into the search.
        document.addEventListener('keydown', e => {
            if (!state.keyboard || state.screen !== 'search') { return; }
            if (e.keyCode === 8) { e.preventDefault(); e.stopPropagation(); typeKey('del'); return; }
            if (e.key && e.key.length === 1 && /[a-z0-9 ]/i.test(e.key)) { e.preventDefault(); e.stopPropagation(); typeKey(e.key.toLowerCase()); }
        }, true);
        $('ds-cancel').addEventListener('click', () => onCancelOk($('ds-cancel'), false));
        $('ds-blocklist').addEventListener('click', () => onCancelOk($('ds-blocklist'), true));
        $('ds-close').addEventListener('click', closeDetails);
        $('in-close').addEventListener('click', closeInfo);
        $('hero-more').addEventListener('click', () => {
            const c = previewCard();
            if (!c) { return; }
            if (c._q && c._q.item) { c._item = c._q.item; c._kind = c._q.kind; openInfo(c, $('hero-more')); }
            else if (c._q) { openDetails(c._q.key, $('hero-more')); }
            else { openInfo(c, $('hero-more')); }
        });
        $('in-similar').addEventListener('click', openSimilar);
        $('in-cast').addEventListener('click', openCast);
        $('in-art').addEventListener('click', openArt);
        $('in-overview').addEventListener('click', openInfoText);
        $('ps-bio').addEventListener('click', openPersonText);
        $('tx-close').addEventListener('click', closeText);
        $('ss-download').addEventListener('click', downloadSeason);
        $('ss-play').addEventListener('click', playSeason);
        $('in-plexapp').addEventListener('click', () => { if (state.info) { playInPlex(state.info); } });
        Player.onError = msg => toast(msg, 'err');
        Player.onStart = () => stopTheme(true);
        document.addEventListener('visibilitychange', () => { if (document.hidden) { stopTheme(true); } });
        Player.onClose = () => {
            const c = Nav.current();
            if (c) { Nav.focus(c); }
            if (state.season) { loadEpisodes(state.season, false); }      // watched marks / resume points
        };
        $('ps-works').addEventListener('click', () => { if (state.person) { openWorks(state.person.item); } });
        $('ps-close').addEventListener('click', closePerson);
        $('ps-scrim').addEventListener('click', closePerson);
        $('in-trailer').addEventListener('click', playTrailer);
        $('hero-browse').addEventListener('click', () => openSearch('tv'));
        $('hero-genre').addEventListener('click', () => openBrowse('genre'));
        $('hero-pub').addEventListener('click', () => openBrowse('pub'));
        $('info-scrim').addEventListener('click', closeInfo);
        $('in-download').addEventListener('click', () => {
            const info = state.info;
            if (!info) { return; }
            if (info.item._disk && info.item._disk.available) { if (info.kind === 'music') { playInPlex(info); } else { playHere(info); } return; }
            closeInfo();
            download(info.card);
        });
        $('qp-scrim').addEventListener('click', closePicker);
        $('dl-scrim').addEventListener('click', closeDetails);
        $('settings-save').addEventListener('click', saveSettings);
        $('settings-reset').addEventListener('click', () => {
            // Wipes saved keys, so it needs a second OK like the other destructive actions.
            const btn = $('settings-reset');
            if (cancelArmed !== btn) {
                disarmCancel();
                cancelArmed = btn;
                btn.classList.add('confirming');
                btn.textContent = 'OK again to reset';
                cancelTimer = setTimeout(disarmCancel, 5000);
                return;
            }
            disarmCancel();
            Api.resetSettings();
            renderSettings();
            Nav.focusFirst('.svc-field input');
            testAll();
            toast('Restored defaults from config.js');
        });

        setupVoice();
        Nav.init({
            back,
            onEdit: input => { if (input.id !== 'search-input') { return false; } openKeyboard(); return true; },
            sound: Sounds.play,
            onFocus,
            submit: input => { if (input.id === 'search-input') { runSearch(true); } },
            onUnhandled: dir => { if (state.text && (dir === 'up' || dir === 'down')) { scrollInfo(dir); } }
        });

        loadRecent();         // saved Recently played rows now; Plex's history is merged in when it arrives
        goStart();
        loadActors();        // Actors is ready by the time the loading screen closes (saved for 12 h, so usually instant)
        // Downloads too: the queue loads with the first poll; "not downloaded yet" and "recently downloaded" here.
        if (Api.KINDS.some(Api.configured)) { refreshExtras(true); checkRequests(true); } else { state.extrasDone = true; }
        runSplash();
        setTimeout(afterBoot, 20000);   // safety net if the loading screen never closes
    }

    /* Background work that would starve the loading animation on the TV (feed downloads and parsing,
       library checks) waits until the loading screen has closed. */
    function afterBoot() {
        if (!state.booting) { return; }
        state.booting = false;
        // Load the other screens' rows (and refresh stale ones) so they're ready before you open them,
        // one at a time and only while the remote is quiet.
        const kinds = Api.KINDS.filter(Api.configured);
        const nextKind = () => { const k = kinds.shift(); if (k) { whenIdle(() => { loadFeed(k); setTimeout(nextKind, 1500); }); } };
        nextKind();
        whenIdle(pumpLibrary);
        whenIdle(preloadAllArt, 2000);
    }

    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); } else { init(); }
}());
