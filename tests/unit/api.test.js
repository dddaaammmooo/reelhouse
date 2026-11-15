'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, CONFIG } = require('./sandbox');

const plain = x => JSON.parse(JSON.stringify(x));
const make = (more) => load(Object.assign({ scripts: ['js/api.js'], globals: plain(CONFIG) }, more || {}));

test('settings: defaults, saved overrides, save keeps quality profiles, reset', () => {
    const { ctx, storage } = make({ storage: { 'medialoader.settings': JSON.stringify({ tv: { url: 'http://other:8989', apiKey: 'saved-key' } }) } });
    const s = ctx.Api.settings();
    assert.equal(s.tv.url, 'http://other:8989');
    assert.equal(s.tv.apiKey, 'saved-key');
    assert.equal(s.tv.qualityProfile, 'HD-1080p');
    assert.equal(s.movie.apiKey, 'test-radarr-key');
    ctx.Api.saveSettings({ tv: { url: 'http://new:8989', apiKey: '', qualityProfile: 'Any' } });
    assert.equal(ctx.Api.settings().tv.url, 'http://new:8989');
    // The Settings form always sends the current key; an empty one falls back to the key built into the package.
    assert.equal(ctx.Api.settings().tv.apiKey, 'test-sonarr-key');
    assert.equal(ctx.Api.settings().tv.qualityProfile, 'Any');
    assert.ok(storage.getItem('medialoader.settings'));
    ctx.Api.resetSettings();
    assert.equal(storage.getItem('medialoader.settings'), null);
    assert.equal(ctx.Api.settings().tv.url, 'http://media-server:8989');
    assert.equal(ctx.Api.configured('tv'), true);
});

test('corrupt saved settings fall back to the defaults', () => {
    const { ctx } = make({ storage: { 'medialoader.settings': '{not json' } });
    assert.equal(ctx.Api.settings().music.url, 'http://media-server:8686');
});

test('requests send the API key; a missing key, 401, network errors and timeouts become readable errors', async () => {
    const { ctx, requests } = make();
    await ctx.Api.test('tv');
    assert.equal(requests[0].headers['X-Api-Key'], 'test-sonarr-key');
    assert.match(requests[0].url, /^http:\/\/media-server:8989\/api\/v3\/system\/status$/);

    const noKey = make({ globals: Object.assign(plain(CONFIG), { MEDIALOADER_DEFAULTS: Object.assign(plain(CONFIG.MEDIALOADER_DEFAULTS), { music: { url: 'http://x:8686', apiKey: '' } }) }) });
    await assert.rejects(noKey.ctx.Api.test('music'), /Lidarr API key not set/);
    assert.equal(noKey.ctx.Api.configured('music'), false);

    const bad = make({ handler: (m, u) => (/system\/status/.test(u) ? { status: 401, body: '{}' } : undefined) });
    await assert.rejects(bad.ctx.Api.test('tv'), /Invalid API key/);
    const msg = make({ handler: (m, u) => (/system\/status/.test(u) ? { status: 500, body: JSON.stringify([{ errorMessage: 'Disk full' }]) } : undefined) });
    await assert.rejects(msg.ctx.Api.test('tv'), /Disk full/);
    const msg2 = make({ handler: (m, u) => (/system\/status/.test(u) ? { status: 500, body: JSON.stringify({ message: 'Broken' }) } : undefined) });
    await assert.rejects(msg2.ctx.Api.test('tv'), /Broken/);
    const plainErr = make({ handler: (m, u) => (/system\/status/.test(u) ? { status: 503, body: 'down' } : undefined) });
    await assert.rejects(plainErr.ctx.Api.test('tv'), /Server error \(503\)/);
    const down = make({ handler: () => 'error' });
    await assert.rejects(down.ctx.Api.test('movie'), /Can't reach Radarr/);
    const slow = make({ handler: () => 'timeout' });
    await assert.rejects(slow.ctx.Api.test('movie'), /Radarr timed out/);
});

test('search and the exact lookups', async () => {
    const { ctx } = make();
    const found = await ctx.Api.search('tv', 'harbour');
    assert.equal(found[0].title, 'Harbour Lights');
    const owned = await ctx.Api.lookupMovie(1001);
    assert.equal(owned.id, 501, 'a movie in the library comes back with its library id');
    const notOwned = await ctx.Api.lookupMovie(1003);
    assert.equal(notOwned.title, 'Saltwater Summer');
    assert.equal(notOwned.id, undefined);
    await assert.rejects(ctx.Api.lookupMovie(4242), /couldn’t find/);
    assert.equal((await ctx.Api.lookupSeries(2002)).title, 'The Lantern Room');
    await assert.rejects(ctx.Api.lookupSeries(9999), /couldn’t find this show/);
    assert.equal((await ctx.Api.lookupMovieByTitle('Glass Harbour', 2026)).title, 'Glass Harbour');
    await assert.rejects(ctx.Api.lookupMovieByTitle('Nope', 2020), /couldn’t find Nope/);
    assert.equal((await ctx.Api.lookupSeriesByTitle('Starboard')).title, 'Starboard');
    await assert.rejects(ctx.Api.lookupSeriesByTitle('Nope'), /couldn’t find Nope/);
    assert.equal((await ctx.Api.lookupArtist('velvet harbour')).artistName, 'Velvet Harbour');
    await assert.rejects(ctx.Api.lookupArtist('Nobody At All'), /couldn’t find/);
});

test('add: payloads use the chosen quality profile and root folder', async () => {
    const { ctx, requests } = make();
    const real = await ctx.Api.lookupSeries(2002);
    const saved = await ctx.Api.add('tv', real);
    assert.equal(saved.id, 99);
    const post = JSON.parse(requests.filter(r => r.method === 'POST' && /\/series$/.test(r.url))[0].body);
    assert.equal(post.qualityProfileId, 4, 'HD-1080p');
    assert.equal(post.rootFolderPath, '/media/tv');
    assert.equal(post.addOptions.searchForMissingEpisodes, true);
    assert.ok(post.seasons.every(s => s.monitored === s.seasonNumber > 0));

    const movie = await ctx.Api.lookupMovie(1003);
    await ctx.Api.add('movie', movie);
    const mp = JSON.parse(requests.filter(r => r.method === 'POST' && /\/movie$/.test(r.url))[0].body);
    assert.equal(mp.qualityProfileId, 8, 'Low Quality 1080');
    assert.equal(mp.addOptions.searchForMovie, true);

    const artist = await ctx.Api.lookupArtist('Neon Orchard');
    await ctx.Api.add('music', artist, { monitor: 'latest' });
    const ap = JSON.parse(requests.filter(r => r.method === 'POST' && /\/artist$/.test(r.url))[0].body);
    assert.equal(ap.qualityProfileId, 2, "empty profile name = the root folder's default");
    assert.equal(ap.metadataProfileId, 1);
    assert.equal(ap.addOptions.monitor, 'latest');
});

test('add fails clearly without a root folder or quality profile', async () => {
    const noRoot = make({ handler: (m, u) => (/rootfolder/.test(u) ? { status: 200, body: '[]' } : undefined) });
    await assert.rejects(noRoot.ctx.Api.add('movie', { title: 'X' }), /No root folder/);
    const noProfile = make({ handler: (m, u) => (/qualityprofile/.test(u) ? { status: 200, body: '[]' } : undefined) });
    await assert.rejects(noProfile.ctx.Api.add('movie', { title: 'X' }), /No quality profile/);
});

test('queues: every state normalised, problems first, one failing app does not hide the others', async () => {
    const { ctx } = make();
    const q = await ctx.Api.queues();
    const by = {};
    q.items.forEach(i => { by[i.key] = i; });
    assert.equal(q.items[0].state, 'failed');
    assert.equal(by['movie:203'].label, 'Failed');
    assert.equal(by['movie:203'].message, 'Download failed');
    assert.equal(by['tv:102'].state, 'attention');
    assert.equal(by['tv:102'].message, 'No files found are eligible for import');
    assert.equal(by['tv:102'].protocol, 'Torrent');
    assert.equal(by['tv:101'].state, 'downloading');
    assert.equal(by['tv:101'].progress, 0.5);
    assert.equal(by['tv:101'].eta, '12m left');
    assert.equal(by['tv:101'].sub, 'S02E01 · Return');
    assert.equal(by['tv:101'].protocol, 'Usenet');
    assert.equal(by['movie:201'].eta, '1h 2m left');
    assert.equal(by['movie:201'].sizeText, '1.9 GB of 7.5 GB');
    assert.equal(by['movie:202'].state, 'queued');
    assert.equal(by['music:301'].state, 'importing');
    assert.equal(by['music:301'].sub, 'Second Gear');

    const partial = make({ handler: (m, u) => (/:8686\/api\/v1\/queue/.test(u) ? 'error' : undefined) });
    const p = await partial.ctx.Api.queues();
    assert.ok(p.items.length >= 4);
    assert.deepEqual(plain(p.errors), ["Lidarr: Can't reach Lidarr"]);
});

test('queue normalisation edge cases: paused, waiting, eta formats and sizes', async () => {
    const recs = [
        { id: 1, status: 'paused', size: 100, sizeleft: 100 },
        { id: 2, status: 'delay', size: 0 },
        { id: 3, status: 'downloading', size: 10, sizeleft: 5, timeleft: '2.03:04:05' },
        { id: 4, status: 'downloading', size: 10, sizeleft: 5, timeleft: '00:00:09' },
        { id: 5, status: 'downloading', size: 10, sizeleft: 5, timeleft: 'soon' }
    ];
    const { ctx } = make({ handler: (m, u) => (/:7878\/api\/v3\/queue/.test(u) ? { status: 200, body: JSON.stringify({ records: recs }) } : (/queue/.test(u) ? { status: 200, body: '[]' } : undefined)) });
    const q = await ctx.Api.queues();
    const by = {};
    q.items.forEach(i => { by[i.id] = i; });
    assert.equal(by[1].label, 'Paused');
    assert.equal(by[2].label, 'Waiting');
    assert.equal(by[2].sizeText, '0 B of 0 B');
    assert.equal(by[3].eta, '2d 3h left');
    assert.equal(by[4].eta, '9s left');
    assert.equal(by[5].eta, '');
});

test('removeQueue, searchExisting and qualityProfiles', async () => {
    const { ctx, requests } = make();
    await ctx.Api.removeQueue('tv', 101, true);
    assert.match(requests.pop().url, /\/queue\/101\?removeFromClient=true&blocklist=true&skipRedownload=false$/);
    await ctx.Api.removeQueue('movie', 201, false);
    assert.match(requests.pop().url, /blocklist=false&skipRedownload=true$/);
    await ctx.Api.searchExisting('movie', 501);
    assert.deepEqual(JSON.parse(requests.pop().body), { name: 'MoviesSearch', movieIds: [501] });
    await ctx.Api.searchExisting('tv', 11);
    assert.deepEqual(JSON.parse(requests.pop().body), { name: 'SeriesSearch', seriesId: 11 });
    await ctx.Api.searchExisting('music', 21);
    assert.deepEqual(JSON.parse(requests.pop().body), { name: 'ArtistSearch', artistId: 21 });
    const qp = await ctx.Api.qualityProfiles('tv');
    assert.deepEqual(plain(qp.map(p => p.name)), ['Any', 'HD-1080p', 'Low Quality 1080']);
});

test('libraryMatch for every kind of feed source', async () => {
    const { ctx } = make();
    assert.deepEqual(plain(await ctx.Api.libraryMatch('tmdb', 1001)), { id: 501, hasFile: true });
    assert.equal(await ctx.Api.libraryMatch('tmdb', 1003), null);
    assert.deepEqual(plain(await ctx.Api.libraryMatch('tvdb', 2001)), { id: 11, hasFile: true });
    assert.equal(await ctx.Api.libraryMatch('tvdb', 2002), null);
    assert.deepEqual(plain(await ctx.Api.libraryMatch('artist', 'Velvet Harbour')), { id: 21, hasFile: true });
    assert.equal(await ctx.Api.libraryMatch('artist', 'Neon Orchard'), null);
    assert.deepEqual(plain(await ctx.Api.libraryMatch('movieTitle', 'Paper Kingdoms', 2025)), { id: 505, hasFile: true });
    assert.equal(await ctx.Api.libraryMatch('movieTitle', 'Saltwater Summer', 2026), null);
    assert.deepEqual(plain(await ctx.Api.libraryMatch('seriesTitle', 'Harbour Lights')), { id: 11, hasFile: true });
    assert.equal(await ctx.Api.libraryMatch('other', 'x'), null);
});

test('libraryStatus labels for movies, shows and artists', async () => {
    const { ctx } = make();
    assert.deepEqual(plain(await ctx.Api.libraryStatus('movie', 501)), { available: true, label: 'On disk · Bluray-1080p' });
    assert.deepEqual(plain(await ctx.Api.libraryStatus('movie', 502)), { available: false, label: '' });
    const tv = await ctx.Api.libraryStatus('tv', 11);
    assert.equal(tv.label, 'On disk · 8 episodes');
    const none = await ctx.Api.libraryStatus('tv', 12);
    assert.equal(none.available, false);
    const music = await ctx.Api.libraryStatus('music', 21);
    assert.equal(music.label, 'On disk · 12 tracks');
});

test('Downloads extras: wanted (grouped, released only) and recently downloaded', async () => {
    const { ctx } = make();
    const wanted = await ctx.Api.wanted();
    const titles = wanted.map(w => w.title + ' / ' + w.sub);
    assert.ok(titles.indexOf('Fern Gully Road / 2 episodes missing') !== -1);
    assert.ok(titles.some(t => /^The Quiet Orbit/.test(t)));
    assert.ok(!titles.some(t => /^Midnight Ferry/.test(t)), 'unreleased movies are left out');
    assert.ok(titles.indexOf('Quiet Engines / Second Gear missing') !== -1);
    const recent = await ctx.Api.recent();
    assert.deepEqual(plain(recent.map(r => r.kind)).sort(), ['movie', 'music', 'tv']);
    assert.equal(recent.filter(r => r.kind === 'tv')[0].sub, 'S01E08 · Last Light');

    const off = make({ globals: Object.assign(plain(CONFIG), { MEDIALOADER_DEFAULTS: { tv: { url: 'x', apiKey: '' }, movie: { url: 'x', apiKey: '' }, music: { url: 'x', apiKey: '' } } }) });
    assert.equal((await off.ctx.Api.wanted()).length, 0);
    assert.equal((await off.ctx.Api.recent()).length, 0);
    assert.equal((await off.ctx.Api.queues()).items.length, 0);
});

test('downloadEpisodes: a whole season, chosen episodes, and a show not yet in Sonarr', async () => {
    const { ctx, requests } = make();
    const real = await ctx.Api.lookupSeries(2001);          // in Sonarr (id 11)
    const r = await ctx.Api.downloadEpisodes(real, 2, null);
    assert.equal(r.count, 6);
    const cmd = JSON.parse(requests.filter(x => /\/command$/.test(x.url)).pop().body);
    assert.deepEqual(cmd, { name: 'SeasonSearch', seriesId: 11, seasonNumber: 2 });
    assert.ok(requests.some(x => x.method === 'PUT' && /\/series\/11$/.test(x.url)), 'the season is monitored too');

    await ctx.Api.downloadEpisodes(real, 1, [2, 3]);
    const cmd2 = JSON.parse(requests.filter(x => /\/command$/.test(x.url)).pop().body);
    assert.equal(cmd2.name, 'EpisodeSearch');
    assert.equal(cmd2.episodeIds.length, 2);

    const fresh = await ctx.Api.lookupSeries(2002);         // not in Sonarr
    const r3 = await ctx.Api.downloadEpisodes(fresh, 1, [1]);
    assert.equal(r3.seriesId, 99);
    const added = JSON.parse(requests.filter(x => x.method === 'POST' && /\/series$/.test(x.url)).pop().body);
    assert.equal(added.addOptions.monitor, 'none', 'only what was asked for gets downloaded');
    assert.ok(added.seasons.every(s => s.monitored === false));
    await assert.rejects(ctx.Api.downloadEpisodes(real, 1, [99]), /doesn’t list those episodes/);
});

test('images: remote URLs first, then the server copy with the key', () => {
    const { ctx } = make();
    const view = ctx.Api.services.tv.view({ title: 'X', images: [{ coverType: 'poster', url: '/MediaCover/1/poster.jpg' }], seasons: [{ seasonNumber: 0 }, { seasonNumber: 1 }] });
    assert.equal(view.poster, 'http://media-server:8989/MediaCover/1/poster.jpg?apikey=test-sonarr-key');
    assert.deepEqual(plain(view.meta), ['1 season']);
    const v2 = ctx.Api.services.music.view({ artistName: 'A', images: [{ coverType: 'fanart', url: 'https://x/y.jpg' }] });
    assert.equal(v2.poster, 'https://x/y.jpg');
    const v3 = ctx.Api.services.movie.view({ title: 'M', remotePoster: 'https://p', runtime: 95 });
    assert.equal(v3.poster, 'https://p');
    assert.deepEqual(plain(v3.meta), ['1h 35m']);
});
