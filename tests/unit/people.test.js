'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, CONFIG } = require('./sandbox');

const plain = x => JSON.parse(JSON.stringify(x));
const make = more => load(Object.assign({ scripts: ['js/api.js', 'js/feeds.js', 'js/plex.js', 'js/people.js'], globals: plain(CONFIG) }, more || {}));
const personCard = name => ({ _feed: true, _person: { name }, kind: 'people', view: { title: name, meta: [], poster: '', backdrop: '', overview: '' } });

test('actor search keeps people (TMDb id or acting job) and caches the answer', async () => {
    const { ctx, requests } = make();
    const found = await ctx.People.search('ada');
    assert.deepEqual(plain(found.map(c => c.view.title)), ['Ada Quinn']);
    assert.equal(found[0].kind, 'people');
    assert.match(found[0].view.poster, /commons\.wikimedia\.org\/wiki\/Special:FilePath\/ada-quinn\.jpg/);
    const n = requests.length;
    await ctx.People.search('ADA ');
    assert.equal(requests.length, n, 'the same search is answered from the saved copy');
});

test('cast lists: a movie (TMDb credits) and a show (TVmaze)', async () => {
    const { ctx } = make();
    const movie = await ctx.People.cast('movie', { tmdbId: 1001 }, {});
    assert.deepEqual(plain(movie.map(c => c.view.title)), ['Ada Quinn', 'Bruno Calder', 'Hal Nobody']);
    assert.match(movie[0].view.poster, /\/t\/p\/w342\//);
    assert.equal(movie[2].view.poster, '', 'no headshot');
    const show = await ctx.People.cast('tv', { tvdbId: 2002 }, {});
    assert.deepEqual(plain(show.map(c => c._person.character)), ['Arlo Penn', 'Ruth Penn']);
    assert.equal((await ctx.People.cast('music', {}, {})).length, 0);
});

test('recast / revival cast: actors only in the revival special are marked and listed last', async () => {
    const { ctx } = make();
    const cast = await ctx.People.cast('tv', { title: 'All Aboard!', tvdbId: 2005, tvMazeId: 3005 }, { tvmaze: 3005 });
    const rows = cast.map(c => c._person.name + (c._person.note ? ' [' + c._person.note + ']' : ''));
    assert.deepEqual(plain(rows), ['Felix Orme', 'Hal Nobody', 'Gus Hallam [2025 special]']);
    assert.match(cast[2].view.meta[0], /\(2025 special\)/);
});

test('biography: the linked Wikipedia article, else a search, else the short description', async () => {
    const { ctx } = make();
    const ada = await ctx.People.details(personCard('Ada Quinn'));
    assert.match(ada.bio, /^Ada Quinn is a fictional actress/);
    assert.equal(ada.qid, 'Q900001');
    const nobody = await ctx.People.details(personCard('Hal Nobody'));
    assert.equal(nobody.bio, '');
    const misspelt = make({ handler: (m, u) => {
        if (/wikipedia\.org\/w\/api\.php/.test(u) && /Ada%20Quin%20actor/.test(u)) { return { status: 200, body: JSON.stringify({ query: { search: [], searchinfo: { suggestion: 'ada quinn actor' } } }) }; }
        if (/wbsearchentities/.test(u) && /search=Ada%20Quin(&|$)/.test(u)) { return { status: 200, body: '{"search":[]}' }; }
        return undefined;
    } });
    const fixed = await misspelt.ctx.People.details(personCard('Ada Quin'));
    assert.match(fixed.bio, /^Ada Quinn is a fictional actress/, "Wikipedia's spelling suggestion is used");
});

test('photo fallbacks: the cast photo, TVmaze people search, Wikipedia, none', async () => {
    const { ctx } = make();
    assert.equal((await ctx.People.photo({ name: 'X', photo: 'p.jpg' })).photo, 'p.jpg');
    assert.match((await ctx.People.photo({ name: 'Bruno Calder' })).photo, /person-bruno-calder/);
    assert.equal((await ctx.People.photo({ name: 'Hal Nobody' })).photo, '');
});

test('gallery: main photo first, then Wikidata, TVmaze and Commons portraits, no repeats or non-portraits', async () => {
    const { ctx } = make();
    const card = personCard('Ada Quinn');
    card.view.poster = card.view.backdrop = 'https://image.tmdb.org/t/p/h632/ada-main.jpg';
    const urls = plain(await ctx.People.gallery(card));
    assert.equal(urls[0], 'https://image.tmdb.org/t/p/h632/ada-main.jpg');
    assert.deepEqual(urls.slice(1).map(u => decodeURIComponent(u).replace(/^.*\//, '').replace(/\?.*$/, '')),
        ['ada-quinn.jpg', 'Ada Quinn 2019.jpg', 'person-ada-quinn.jpg', 'Ada Quinn at the Harbour Lights premiere.jpg']);
    assert.ok(urls.length <= 6);
    // Nobody has nothing extra
    const none = plain(await ctx.People.gallery(personCard('Hal Nobody')));
    assert.ok(none.length <= 1);
});

test('works: an actor\'s movies (newest first) and TV shows as rows', async () => {
    const { ctx } = make();
    const rows = await ctx.People.works(personCard('Ada Quinn'));
    assert.deepEqual(plain(rows.map(r => r.title)), ['Movies', 'TV shows']);
    assert.deepEqual(plain(rows[0].items.map(i => i.view.title)), ['Glass Harbour', 'Copper Sky', 'Northern Lights']);
    assert.equal(rows[0].items[0].kind, 'movie');
    assert.deepEqual(plain(rows[1].items.map(i => i.view.title)), ['Harbour Lights']);
    assert.equal(rows[1].items[0].kind, 'tv');
});

test('Actors start page: top-billed leads of new titles, mixed, no duplicates', async () => {
    const { ctx } = make();
    const rows = await ctx.People.recent();
    assert.ok(rows.length > 0);
    const names = rows.reduce((a, r) => a.concat(r.items.map(c => c.view.title)), []);
    assert.equal(new Set(names).size, names.length);
    assert.ok(rows[0].items[0]._person.known, 'each card says where they\'re from');
});
