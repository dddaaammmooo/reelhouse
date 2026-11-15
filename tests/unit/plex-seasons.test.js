'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, CONFIG } = require('./sandbox');

const plain = x => JSON.parse(JSON.stringify(x));
const make = more => load(Object.assign({ scripts: ['js/api.js', 'js/feeds.js', 'js/plex.js', 'js/seasons.js'], globals: plain(CONFIG) }, more || {}));

test('Plex: finds titles by their TMDb / TVDB ids, else by name and year', async () => {
    const { ctx } = make();
    assert.equal((await ctx.Plex.findItem('movie', { title: 'Northern Lights', tmdbId: 1001 })).ratingKey, '6001');
    assert.equal((await ctx.Plex.findItem('tv', { title: 'Harbour Lights', tvdbId: 2001 })).ratingKey, '5001');
    assert.equal((await ctx.Plex.findItem('music', { artistName: 'Velvet Harbour' })).ratingKey, '5101');
    assert.equal(await ctx.Plex.findItem('movie', { title: 'Copper Sky', tmdbId: 1008 }), null);
});

test('Plex: what Play starts (movie resume, the show\'s On Deck episode, music) and its errors', async () => {
    const { ctx } = make();
    const movie = await ctx.Plex.target('movie', { key: '/library/metadata/6001', viewOffset: 5, title: 'N' });
    assert.equal(movie.offset, 5);
    const show = await ctx.Plex.target('tv', { ratingKey: '5001', title: 'Harbour Lights' });
    assert.equal(show.season, 1);
    assert.equal(show.episode, 4);
    assert.equal(show.resume, true);
    assert.equal((await ctx.Plex.target('music', { key: '/k', title: 'A' })).type, 'music');
    await assert.rejects(ctx.Plex.target('tv', { ratingKey: '5005', title: 'All Aboard!' }), /No episodes/);
});

test('Plex: without On Deck, the unfinished episode, else the one after the last watched', async () => {
    const eps = list => ({ status: 200, body: JSON.stringify({ MediaContainer: { Metadata: list } }) });
    const ep = (i, extra) => Object.assign({ ratingKey: String(i), key: '/k/' + i, parentIndex: 1, index: i }, extra || {});
    const after = make({ handler: (m, u) => (/metadata\/5001\?includeOnDeck/.test(u) ? eps([{}])
        : /allLeaves/.test(u) ? eps([ep(1, { viewCount: 1 }), ep(2, { viewCount: 1 }), ep(3), ep(4)]) : undefined) });
    assert.equal((await after.ctx.Plex.target('tv', { ratingKey: '5001', title: 'T' })).episode, 3);
    const unfinished = make({ handler: (m, u) => (/metadata\/5001\?includeOnDeck/.test(u) ? eps([{}])
        : /allLeaves/.test(u) ? eps([ep(1, { viewCount: 1 }), ep(2, { viewOffset: 100 }), ep(3)]) : undefined) });
    const t = await unfinished.ctx.Plex.target('tv', { ratingKey: '5001', title: 'T' });
    assert.equal(t.episode, 2);
    assert.equal(t.resume, true);
});

test('Plex: recently played skips home videos and "Various"; trailers; resized images', async () => {
    const { ctx } = make();
    assert.deepEqual(plain((await ctx.Plex.recentlyPlayed('music')).map(m => m.title)), ['Velvet Harbour']);
    assert.deepEqual(plain((await ctx.Plex.recentlyPlayed('movie')).map(m => m.title)), ['Northern Lights']);
    const trailer = await ctx.Plex.trailer('movie', { title: 'Northern Lights', tmdbId: 1001 });
    assert.match(trailer, /^http:\/\/plex-server:32400\/library\/parts\/8001\/trailer\.mp4\?bitrate=5000&X-Plex-Token=test-plex-token$/);
    assert.equal(await ctx.Plex.trailer('tv', {}), null);
    assert.match(ctx.Plex.photo('/x/thumb', 342, 513), /\/photo\/:\/transcode\?width=342&height=513/);
    assert.equal(ctx.Plex.photo('', 1, 1), '');
    const off = make({ globals: Object.assign(plain(CONFIG), { MEDIALOADER_PLEX: { url: '', token: '' } }) });
    assert.equal(off.ctx.Plex.configured(), false);
    assert.equal((await off.ctx.Plex.recentlyPlayed('tv')).length, 0);
});

test('Play In Plex (on the TV): opens the Plex app, makes a play queue as the TV, starts playback', async () => {
    const launched = [];
    const tizen = { application: { launch: (id, ok) => { launched.push(id); ok(); } } };
    const { ctx, requests } = make({ globals: Object.assign(plain(CONFIG), { tizen }) });
    const r = await ctx.Plex.play('movie', { title: 'Northern Lights', tmdbId: 1001 });
    assert.equal(r.played, true);
    assert.deepEqual(launched, ['kIciSQlYEM.plex']);
    const queue = requests.filter(x => /\/playQueues/.test(x.url))[0];
    assert.equal(queue.headers['X-Plex-Client-Identifier'], 'test-tv', 'the queue belongs to the TV\'s player');
    const playMedia = requests.filter(x => /playMedia/.test(x.url))[0];
    assert.match(playMedia.url, /protocol=https&address=10-0-0-2\.test\.plex\.direct&port=32400/);
    const notInPlex = await ctx.Plex.play('movie', { title: 'Copper Sky', tmdbId: 1008 });
    assert.equal(notInPlex.played, false);
    const off = make({ globals: Object.assign(plain(CONFIG), { MEDIALOADER_PLEX: { url: '', token: '' }, tizen }) });
    assert.match((await off.ctx.Plex.play('movie', {})).reason, /isn’t set up/);
});

test('Seasons: art from Plex, counts from Sonarr, names and dates from TVmaze', async () => {
    const { ctx } = make();
    const real = await ctx.Api.lookupSeries(2001);
    const seasons = await ctx.Seasons.forShow({ tvmaze: 3001 }, real);
    assert.equal(seasons.length, 2);
    assert.equal(seasons[0].files, 8);
    assert.match(seasons[0].image, /\/photo\/:\/transcode/, 'Plex\'s season poster wins');
    assert.equal(seasons[1].name, 'The Storm Season Part Two Special Edition');
    const noArt = make({ globals: Object.assign(plain(CONFIG), { MEDIALOADER_PLEX: { url: '', token: '' } }) });
    const s2 = await noArt.ctx.Seasons.forShow({ tvmaze: 3001 }, real);
    assert.match(s2[0].image, /tvmaze/, 'else TVmaze\'s');
    const lookedUp = await ctx.Seasons.forShow({}, { tvdbId: 2002 });
    assert.equal(lookedUp.length, 1, 'TVmaze id found from the TVDB id');
    const none = await ctx.Seasons.forShow({}, { seasons: [{ seasonNumber: 0 }, { seasonNumber: 1 }] });
    assert.deepEqual(plain(none.map(s => s.name)), ['Season 1'], 'no TVmaze: Sonarr\'s season numbers');
});

test('Seasons: episodes merged from TVmaze, Sonarr and Plex', async () => {
    const { ctx } = make();
    const real = await ctx.Api.lookupSeries(2001);
    const [s1] = await ctx.Seasons.forShow({ tvmaze: 3001 }, real);
    const eps = await ctx.Seasons.episodes({ tvmaze: 3001 }, real, s1);
    assert.equal(eps.length, 6);
    assert.equal(eps[0].title, 'Episode 1: Arrivals');
    assert.equal(eps[0].plex.watched, true);
    assert.equal(eps[3].plex.offset, 600000);
    assert.equal(eps[0].sonarr.hasFile, true);
    assert.equal(eps[0].onDisk, true);
});
