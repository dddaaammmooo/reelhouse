'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, CONFIG } = require('./sandbox');

const plain = x => JSON.parse(JSON.stringify(x));
const make = more => load(Object.assign({ scripts: ['js/api.js', 'js/feeds.js'], globals: plain(CONFIG) }, more || {}));
const titles = rows => rows.map(r => r.title);

test('Movies: cinema, coming soon, iTunes and popular rows, plus genre rows; no "to buy" rows', async () => {
    const { ctx, storage } = make();
    const rows = await ctx.Feeds.load('movie');
    const t = titles(rows);
    assert.equal(t[0], 'In cinemas & new releases');
    assert.ok(t.indexOf('Coming soon to cinemas') !== -1);
    assert.ok(t.indexOf('Top movies on iTunes') !== -1);
    assert.ok(t.indexOf('Popular right now') !== -1);
    assert.ok(!t.some(x => /buy/i.test(x)));
    const cinema = rows[0].items.map(i => i.view.title);
    assert.ok(cinema.indexOf('Northern Lights') !== -1);
    assert.ok(cinema.indexOf('Glass Harbour') === -1, 'not out yet');
    const soon = rows.filter(r => r.title === 'Coming soon to cinemas')[0].items.map(i => i.view.title);
    assert.deepEqual(plain(soon), ['Glass Harbour', 'Midnight Ferry'], 'soonest first');
    const nl = rows[0].items.filter(i => i.view.title === 'Northern Lights')[0];
    assert.match(nl.view.poster, /\/t\/p\/w342\//);
    assert.match(nl.view.backdrop, /\/t\/p\/w1280\//);
    assert.equal(typeof nl.resolve, 'function');
    assert.ok(storage.getItem('medialoader.feed.movie'), 'saved for the next launch');
    const cached = ctx.Feeds.cached('movie');
    assert.deepEqual(plain(titles(cached.rows)), plain(t));
});

test('TV: premieres, returning, premiering soon, popular, streaming-service rows', async () => {
    const { ctx } = make();
    const rows = await ctx.Feeds.load('tv');
    const t = titles(rows);
    assert.ok(t.indexOf('New series this week') !== -1);
    assert.ok(t.indexOf('Returning this week') !== -1);
    assert.ok(t.indexOf('Premiering soon') !== -1);
    assert.ok(t.indexOf('Popular this week') !== -1);
    assert.ok(t.indexOf('Northstream') !== -1, 'a row per streaming service with 4+ shows');
    assert.ok(!t.some(x => /buy/i.test(x)));
    const returning = rows.filter(r => r.title === 'Returning this week')[0].items.map(i => i.view.title);
    assert.ok(returning.indexOf('Fern Gully Road') !== -1);
    const soon = rows.filter(r => r.title === 'Premiering soon')[0].items[0];
    assert.match(soon.view.meta[0], /^New series · starts /);
    const hl = rows[0].items.filter(i => i.view.title === 'Harbour Lights')[0];
    assert.equal(hl.tvmaze, 3001);
    const bg = await hl.loadBackdrop();
    assert.match(bg, /background-harbour-lights/);
});

test('Music: popular new albums, most played, decade rows; falls back to iTunes when Apple Music fails', async () => {
    const { ctx } = make();
    const rows = await ctx.Feeds.load('music');
    const t = titles(rows);
    assert.equal(t[0], 'Popular new albums');
    assert.ok(t.indexOf('Most played right now') !== -1);
    assert.ok(t.indexOf('Hits of the 1980s') !== -1);
    const fallback = make({ handler: (m, u) => (/marketingtools|\/feeds\/apple/.test(u) ? { status: 500, body: '' } : undefined) });
    const rows2 = await fallback.ctx.Feeds.load('music');
    assert.ok(rows2[0].items.length > 0);
});

test('a source failing does not empty the page; everything failing reports an error', async () => {
    const some = make({ handler: (m, u) => (/api\.radarr\.video/.test(u) ? 'error' : undefined) });
    const rows = await some.ctx.Feeds.load('movie');
    assert.ok(titles(rows).indexOf('Top movies on iTunes') !== -1);
    const none = make({ handler: () => 'error' });
    await assert.rejects(none.ctx.Feeds.load('movie'), /No movie lists available/);
    await assert.rejects(none.ctx.Feeds.load('tv'), /No TV lists available/);
});

test('hydrate: one object per title, each source resolves through the right lookup, kind is kept', async () => {
    const { ctx } = make();
    const d = (key, src, ref, extra) => Object.assign({ key, src, ref, view: { title: key, meta: [], poster: '', backdrop: '' } }, extra || {});
    const rows = ctx.Feeds.hydrate([{ title: 'A', items: [d('tmdb:1003', 'tmdb', 1003), d('tvdb:2002', 'tvdb', 2002, { kind: 'tv' })] },
        { title: 'B', items: [d('tmdb:1003', 'tmdb', 1003), d('m:t', 'movieTitle', 'Glass Harbour', { year: 2026 }), d('s:t', 'seriesTitle', 'Starboard'), d('a', 'artist', 'Neon Orchard')] }]);
    assert.equal(rows[0].items[0], rows[1].items[0], 'the same title is one shared object');
    assert.equal(rows[0].items[1].kind, 'tv');
    assert.equal((await rows[0].items[0].resolve()).title, 'Saltwater Summer');
    assert.equal((await rows[0].items[1].resolve()).title, 'The Lantern Room');
    assert.equal((await rows[1].items[1].resolve()).title, 'Glass Harbour');
    assert.equal((await rows[1].items[2].resolve()).title, 'Starboard');
    assert.equal((await rows[1].items[3].resolve()).artistName, 'Neon Orchard');
});

test('cached: missing, old versions and corrupt data are ignored', () => {
    assert.equal(make().ctx.Feeds.cached('tv'), null);
    assert.equal(make({ storage: { 'medialoader.feed.tv': JSON.stringify({ v: 1, rows: [{ title: 'x', items: [] }] }) } }).ctx.Feeds.cached('tv'), null);
    assert.equal(make({ storage: { 'medialoader.feed.tv': '{bad' } }).ctx.Feeds.cached('tv'), null);
});

test('Similar pages: movie recommendations, shows sharing actors, related artists, and "More <genre>" rows', async () => {
    const { ctx } = make();
    const movie = await ctx.Api.lookupMovie(1001);
    const pool = (await ctx.Feeds.load('movie')).reduce((a, r) => a.concat(r.items), []);
    const item = pool.filter(i => i.key === 'tmdb:1001')[0];
    const rows = await ctx.Feeds.similar('movie', movie, item, pool);
    assert.equal(rows[0].title, 'Recommended if you liked Northern Lights');
    assert.ok(rows.some(r => /^More /.test(r.title)));

    const show = await ctx.Api.lookupSeries(2001);
    const tvRows = await ctx.Feeds.similar('tv', show, { tvmaze: 3001, key: 'tvdb:2001' }, []);
    assert.ok(tvRows.some(r => /^Starring /.test(r.title)));

    const artist = await ctx.Api.lookupArtist('Velvet Harbour');
    const mRows = await ctx.Feeds.similar('music', artist, { view: { title: 'Velvet Harbour' } }, []);
    assert.deepEqual(plain(titles(mRows)), ['Artists like Velvet Harbour', 'Fans also like'].filter((x, i) => mRows[i]));

    await assert.rejects(ctx.Feeds.similar('movie', { tmdbId: 0, genres: [] }, {}, []), /No similar titles found/);
});

test('images: a show\'s TVmaze pictures; the Docker proxy is used when served over http', async () => {
    const { ctx } = make();
    const imgs = await ctx.Feeds.images(3001);
    assert.equal(imgs.filter(i => i.type === 'poster').length, 3);
    const viaProxy = make({ protocol: 'http:' });
    await viaProxy.ctx.Feeds.load('movie');
    assert.ok(viaProxy.requests.some(r => /^\/feeds\/radarr\/v1\/list\/tmdb\/trending$/.test(r.url)));
    assert.equal(ctx.Feeds.summary('tv').length > 0, true);
});

test('TVmaze rate limit: HTTP 429 is retried', async () => {
    let first = true;
    const { ctx } = make({ handler: (m, u) => { if (/shows\/3001\/images/.test(u) && first) { first = false; return { status: 429, body: '' }; } return undefined; } });
    const t0 = Date.now();
    const imgs = await ctx.Feeds.images(3001);
    assert.ok(imgs.length > 0);
    assert.ok(Date.now() - t0 >= 2000, 'waited before retrying');
});

test('publishers: networks, studios and labels; copyright lines are tidied', async () => {
    const { ctx } = make();
    const tv = await ctx.Feeds.load('tv');
    const hl = tv[0].items.filter(i => i.view.title === 'Harbour Lights')[0];
    assert.equal(hl.pub, 'Northstream');
    const movies = await ctx.Feeds.load('movie');
    assert.ok(movies.some(r => r.items.some(i => i.pub)), 'Radarr studios carried through');
    const r = ctx.Feeds.rightsHolder;
    assert.equal(r('© 2026 Paramount Pictures'), 'Paramount Pictures');
    assert.equal(r('LONG VERSION:© 2025 Warner Bros. Ent. All Rights Reserved.'), 'Warner Bros. Pictures');
    assert.equal(r('An Atlantic Records Release, ℗ 2026 Warner Music UK Limited'), 'Atlantic Records');
    assert.equal(r('℗ 2026 KQ Entertainment under license to Sony Music'), 'KQ Entertainment');
    assert.equal(r('℗ 2024 This Compilation Motown Records, a Division of UMG Recordings, Inc.'), 'Motown Records');
    assert.equal(r('& TM 2026'), '');
    assert.equal(r(''), '');
    assert.equal(ctx.Feeds.genreName('movie', 'Science Fiction'), 'Sci-Fi & Fantasy');
    assert.equal(ctx.Feeds.genreName('tv', 'Science-Fiction'), 'Sci-Fi & Fantasy');
    assert.equal(ctx.Feeds.genreName('music', 'Hip-Hop/Rap'), 'Hip Hop/Rap');
});
