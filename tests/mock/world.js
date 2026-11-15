/*
 * A small, entirely fictional media world used by the unit tests, the end-to-end tests and the README
 * screenshots. Every outside service Reelhouse talks to is answered from here:
 *   Radarr's metadata service, iTunes RSS, Apple Music RSS, Deezer, TVmaze, Wikidata, Wikipedia,
 *   Sonarr / Radarr / Lidarr (your servers) and Plex.
 * Titles, people and artwork are made up; images are generated SVG placeholders.
 *
 * route(method, url, body) -> { status, type, body } | null (null = not handled -> 404)
 */
'use strict';

const DAY = 86400000;
const NOW = Date.now();
const iso = days => new Date(NOW + days * DAY).toISOString();
const isoDay = days => iso(days).slice(0, 10);
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/* ---------------- people ---------------- */

const PEOPLE = [
    { id: 1, name: 'Ada Quinn', tmdb: 9001, tvmaze: 7001, qid: 'Q900001', desc: 'English actress (born 1984)' },
    { id: 2, name: 'Bruno Calder', tmdb: 9002, tvmaze: 7002, qid: 'Q900002', desc: 'Scottish actor (born 1979)' },
    { id: 3, name: 'Clara Weston', tmdb: 9003, tvmaze: 7003, qid: 'Q900003', desc: 'Australian actress (born 1991)' },
    { id: 4, name: 'Dev Patel-Rowe', tmdb: 9004, tvmaze: 7004, qid: 'Q900004', desc: 'British actor (born 1988)' },
    { id: 5, name: 'Elena Marsh', tmdb: 9005, tvmaze: 7005, qid: 'Q900005', desc: 'American actress (born 1975)' },
    { id: 6, name: 'Felix Orme', tmdb: 9006, tvmaze: 7006, qid: 'Q900006', desc: 'Irish actor (born 1969)' },
    // Played Captain Rook in the 2025 revival special only (recast / revival tests)
    { id: 7, name: 'Gus Hallam', tmdb: 9007, tvmaze: 7007, qid: 'Q900007', desc: 'English actor (born 1990)' },
    // No photo anywhere, no Wikipedia article (fallback tests)
    { id: 8, name: 'Hal Nobody', tmdb: 9008, tvmaze: 7008, qid: null, desc: '' }
];
const person = name => PEOPLE.filter(p => p.name === name)[0];
const personPhoto = p => 'https://image.tmdb.org/t/p/original/person-' + slug(p.name) + '.jpg';

/* ---------------- movies (Radarr's TMDb lists) ---------------- */

const MOVIES = [
    { tmdb: 1001, title: 'Northern Lights', year: 2026, genres: ['Drama', 'Romance'], runtime: 118, cinema: -20, digital: 25, radarr: 501, hasFile: true, plex: 6001, cast: ['Ada Quinn', 'Bruno Calder', 'Hal Nobody'] },
    { tmdb: 1002, title: 'The Quiet Orbit', year: 2026, genres: ['Science Fiction', 'Thriller'], runtime: 131, cinema: -10, digital: 40, radarr: 502, hasFile: false, cast: ['Clara Weston', 'Dev Patel-Rowe'] },
    { tmdb: 1003, title: 'Saltwater Summer', year: 2026, genres: ['Comedy', 'Family'], runtime: 97, cinema: -60, digital: -5, cast: ['Elena Marsh', 'Felix Orme'] },
    { tmdb: 1004, title: 'Glass Harbour', year: 2026, genres: ['Thriller', 'Crime'], runtime: 109, cinema: 12, digital: 70, cast: ['Ada Quinn', 'Felix Orme'] },
    { tmdb: 1005, title: 'Paper Kingdoms', year: 2025, genres: ['Animation', 'Family', 'Adventure'], runtime: 92, cinema: -120, digital: -30, radarr: 505, hasFile: true, cast: ['Clara Weston'] },
    { tmdb: 1006, title: 'Midnight Ferry', year: 2026, genres: ['Horror', 'Thriller'], runtime: 101, cinema: 30, digital: 90, cast: ['Bruno Calder'] },
    { tmdb: 1007, title: 'The Long Field', year: 2025, genres: ['Drama', 'History'], runtime: 142, cinema: -90, digital: -20, cast: ['Dev Patel-Rowe', 'Elena Marsh'] },
    { tmdb: 1008, title: 'Copper Sky', year: 2026, genres: ['Action', 'Adventure', 'Science Fiction'], runtime: 126, cinema: -3, digital: 60, cast: ['Ada Quinn', 'Gus Hallam'] }
];
const movieByTmdb = id => MOVIES.filter(m => m.tmdb === +id)[0];
const tmdbPoster = t => 'https://image.tmdb.org/t/p/original/poster-' + slug(t) + '.jpg';
const tmdbFanart = t => 'https://image.tmdb.org/t/p/original/fanart-' + slug(t) + '.jpg';

function metadataMovie(m) {
    return {
        TmdbId: m.tmdb, ImdbId: 'tt' + (9000000 + m.tmdb), Title: m.title, OriginalTitle: m.title, Year: m.year,
        Overview: m.title + ' is a made-up film used to test Reelhouse. It follows a small group of people through one long, strange season.',
        InCinema: iso(m.cinema), DigitalRelease: iso(m.digital), Genres: m.genres, Studio: m.tmdb % 2 ? 'Lighthouse Pictures' : 'Tidewater Films', Runtime: m.runtime, Status: 'released',
        Images: [{ CoverType: 'Poster', Url: tmdbPoster(m.title) }, { CoverType: 'Fanart', Url: tmdbFanart(m.title) }],
        Credits: { Cast: m.cast.map((n, i) => ({ Name: n, Character: 'Role ' + (i + 1), TmdbId: person(n).tmdb,
            Images: person(n).name === 'Hal Nobody' ? [] : [{ CoverType: 'Headshot', Url: personPhoto(person(n)) }] })) },
        Recommendations: MOVIES.filter(x => x !== m).slice(0, 4).map(x => ({ TmdbId: x.tmdb, Title: x.title })),
        YoutubeTrailerId: 'trailer' + m.tmdb, Popularity: 100 - m.tmdb % 100
    };
}

function radarrMovie(m, withId) {
    const o = {
        title: m.title, year: m.year, tmdbId: m.tmdb, imdbId: 'tt' + (9000000 + m.tmdb), runtime: m.runtime, studio: 'Placeholder Pictures',
        overview: m.title + ' is a made-up film used to test Reelhouse.', genres: m.genres, certification: 'M',
        inCinemas: iso(m.cinema), digitalRelease: iso(m.digital), youTubeTrailerId: 'trailer' + m.tmdb,
        ratings: { imdb: { value: 7.4 }, tmdb: { value: 7.1 }, rottenTomatoes: { value: 88 }, metacritic: { value: 71 } },
        images: [{ coverType: 'poster', remoteUrl: tmdbPoster(m.title) }, { coverType: 'fanart', remoteUrl: tmdbFanart(m.title) }],
        isAvailable: m.cinema < 0, monitored: true
    };
    if (withId && m.radarr) {
        o.id = m.radarr; o.hasFile = !!m.hasFile; o.added = iso(-2);
        if (m.hasFile) { o.movieFile = { quality: { quality: { name: 'Bluray-1080p' } } }; }
    }
    return o;
}

/* ---------------- TV (TVmaze schedule) ---------------- */

const SHOWS = [
    { tvdb: 2001, tvmaze: 3001, title: 'Harbour Lights', premiered: '2026-01-10', season: 1, airs: 0, web: true, genres: ['Drama', 'Crime'], net: 'Northstream', sonarr: 11, files: 8, total: 8, plex: 5001, weight: 99, seasons: 2,
        cast: [['Ada Quinn', 'Inspector Mara Vale'], ['Bruno Calder', 'Tom Vale'], ['Clara Weston', 'Jess Marlow']], theme: true },
    { tvdb: 2002, tvmaze: 3002, title: 'The Lantern Room', premiered: isoDay(-2), season: 1, airs: -2, web: true, genres: ['Mystery', 'Thriller'], net: 'Northstream', weight: 90, seasons: 1,
        cast: [['Dev Patel-Rowe', 'Arlo Penn'], ['Elena Marsh', 'Ruth Penn']] },
    { tvdb: 2003, tvmaze: 3003, title: 'Fern Gully Road', premiered: '2024-03-01', season: 3, airs: -1, genres: ['Comedy'], net: 'Northstream', web: true, weight: 80, seasons: 3, sonarr: 12, files: 0, total: 20,
        cast: [['Felix Orme', 'Mick Fern']] },
    { tvdb: 2004, tvmaze: 3004, title: 'Starboard', premiered: isoDay(2), season: 1, airs: 2, genres: ['Science-Fiction', 'Drama'], net: 'Orbit+', weight: 85, seasons: 1,
        cast: [['Clara Weston', 'Cmdr. Ines Sato']] },
    // A 1980s sitcom with a 2025 revival special: two actors share "Captain Rook" (recast tests)
    { tvdb: 2005, tvmaze: 3005, title: 'All Aboard!', premiered: '1981-09-01', season: 5, airs: -3, genres: ['Comedy'], net: 'BBC One', weight: 70, seasons: 5, plex: 5005,
        cast: [['Felix Orme', 'Captain Rook'], ['Gus Hallam', 'Captain Rook'], ['Hal Nobody', 'Steward']], revival: true },
    // No poster anywhere, only a wide background (artwork fallback tests)
    { tvdb: 2006, tvmaze: 3006, title: 'The Well House', premiered: isoDay(-4), season: 1, airs: -4, web: true, genres: ['Crime', 'Documentary'], net: 'Northstream', weight: 60, seasons: 1, noPoster: true,
        cast: [['Elena Marsh', 'Narrator']] }
];
const showByMaze = id => SHOWS.filter(s => s.tvmaze === +id)[0];
const showByTvdb = id => SHOWS.filter(s => s.tvdb === +id)[0];
const mazeImg = (t, kind) => 'https://static.tvmaze.com/uploads/images/medium_portrait/' + kind + '-' + slug(t) + '.jpg';

function mazeShow(s) {
    return {
        id: s.tvmaze, name: s.title, type: s.revival ? 'Scripted' : 'Scripted', language: 'English', genres: s.genres, status: 'Running',
        premiered: s.premiered, weight: s.weight,
        // Streaming shows have a "web channel" (feeds the per-service rows); the rest a TV network.
        network: s.web ? null : { name: s.net }, webChannel: s.web ? { name: s.net } : null,
        externals: { thetvdb: s.tvdb, imdb: 'tt' + (8000000 + s.tvdb) },
        image: s.noPoster ? null : { medium: mazeImg(s.title, 'poster'), original: mazeImg(s.title, 'poster') },
        summary: '<p>' + s.title + ' is a made-up show used to test Reelhouse. Every week brings a new problem to the same small town.</p>'
    };
}

function mazeEpisodes(s) {
    const out = [];
    for (let season = 1; season <= s.seasons; season++) {
        const count = season === s.seasons && s.revival ? 1 : 6;
        for (let n = 1; n <= count; n++) {
            const year = s.revival && season === s.seasons ? 2025 : (s.revival ? 1981 + season : 2026);
            out.push({ id: s.tvmaze * 1000 + season * 100 + n, name: 'Episode ' + n + (n === 1 ? ': Arrivals' : ''), season, number: n,
                airdate: s.revival && season === s.seasons ? '2025-12-25' : (s.revival ? year + '-0' + Math.min(9, n) + '-01' : isoDay(-40 + season * 7 + n)),
                runtime: 45, image: { medium: mazeImg(s.title + '-s' + season + 'e' + n, 'still'), original: mazeImg(s.title + '-s' + season + 'e' + n, 'still') },
                summary: '<p>Things go wrong in episode ' + n + '.</p>', type: 'regular' });
        }
    }
    return out;
}

function scheduleFor(date) {
    const out = [];
    SHOWS.forEach(s => {
        if (isoDay(s.airs) !== date) { return; }
        out.push({ id: s.tvmaze * 10, name: 'Premiere', season: s.season, number: 1, airdate: date, airstamp: date + 'T09:00:00+00:00', _embedded: { show: mazeShow(s) } });
    });
    return out;
}

/* ---------------- music ---------------- */

const ARTISTS = [
    { name: 'Velvet Harbour', album: 'Low Tide', lidarr: 21, tracks: 12, genres: ['Alternative'] },
    { name: 'Neon Orchard', album: 'Static Bloom', genres: ['Pop'] },
    { name: 'The Paper Lanterns', album: 'Fold', genres: ['Rock'] },
    { name: 'Mira Sol', album: 'Daybreak Radio', genres: ['Dance'] },
    { name: 'Quiet Engines', album: 'Second Gear', lidarr: 22, tracks: 0, genres: ['Electronic'] },
    { name: 'Juniper & Smoke', album: 'Hollow Pines', genres: ['Country'] }
];
const artistByName = n => ARTISTS.filter(a => a.name.toLowerCase() === String(n).toLowerCase())[0];
const coverArt = t => 'https://is1-ssl.mzstatic.com/image/thumb/Music/' + slug(t) + '/100x100bb.jpg';

/* ---------------- Sonarr / Radarr / Lidarr ---------------- */

function sonarrSeries(s, withId) {
    const o = {
        title: s.title, year: +String(s.premiered).slice(0, 4), tvdbId: s.tvdb, tvMazeId: s.tvmaze, imdbId: 'tt' + (8000000 + s.tvdb),
        network: s.net, overview: s.title + ' is a made-up show used to test Reelhouse.', genres: s.genres, status: 'continuing', certification: 'TV-MA',
        runtime: 45, firstAired: s.premiered + 'T00:00:00Z', ratings: { value: 8.1, votes: 1234 },
        images: s.noPoster ? [{ coverType: 'fanart', remoteUrl: mazeImg(s.title, 'background') }]
            : [{ coverType: 'poster', remoteUrl: mazeImg(s.title, 'poster') }, { coverType: 'fanart', remoteUrl: mazeImg(s.title, 'background') }],
        seasons: Array.from({ length: s.seasons }, (x, i) => ({ seasonNumber: i + 1, monitored: true,
            statistics: s.sonarr ? { episodeFileCount: i === 0 ? s.files : 0, episodeCount: 6, totalEpisodeCount: 6 } : undefined }))
    };
    if (withId && s.sonarr) { o.id = s.sonarr; o.statistics = { episodeFileCount: s.files, episodeCount: s.total }; o.added = iso(-30); }
    return o;
}

function lidarrArtist(a, withId) {
    const o = { artistName: a.name, artistType: 'Group', genres: a.genres, overview: a.name + ' is a made-up band.', disambiguation: '',
        images: [{ coverType: 'poster', remoteUrl: coverArt(a.name) }], ratings: { value: 8, votes: 12 }, status: 'continuing' };
    if (withId && a.lidarr) { o.id = a.lidarr; o.statistics = { trackFileCount: a.tracks, trackCount: 12 }; }
    return o;
}

function arrQueue(kind) {
    if (kind === 'tv') {
        const s = SHOWS[0], series = sonarrSeries(s, true);
        return { records: [
            { id: 101, seriesId: s.sonarr, series, episode: { seasonNumber: 2, episodeNumber: 1, title: 'Return', overview: 'They come back.' },
                title: 'Harbour.Lights.S02E01.1080p', size: 2e9, sizeleft: 1e9, timeleft: '00:12:00', status: 'downloading',
                trackedDownloadState: 'downloading', trackedDownloadStatus: 'ok', protocol: 'usenet', downloadClient: 'SABnzbd', indexer: 'Placeholder', quality: { quality: { name: 'WEBDL-1080p' } } },
            { id: 102, seriesId: s.sonarr, series, episode: { seasonNumber: 2, episodeNumber: 2, title: 'Storm' }, title: 'Harbour.Lights.S02E02', size: 2e9, sizeleft: 0,
                status: 'completed', trackedDownloadState: 'importPending', trackedDownloadStatus: 'warning',
                statusMessages: [{ messages: ['No files found are eligible for import'] }], protocol: 'torrent', downloadClient: 'qBittorrent' }
        ] };
    }
    if (kind === 'movie') {
        const m = MOVIES[1];
        return { records: [
            { id: 201, movieId: m.radarr, movie: radarrMovie(m, true), title: 'The.Quiet.Orbit.2026.1080p', size: 8e9, sizeleft: 6e9, timeleft: '1:02:03',
                status: 'downloading', trackedDownloadState: 'downloading', trackedDownloadStatus: 'ok', protocol: 'usenet', downloadClient: 'SABnzbd', quality: { quality: { name: 'Bluray-1080p' } } },
            { id: 202, movieId: 999, movie: radarrMovie(MOVIES[6]), title: 'The.Long.Field.2025', size: 4e9, sizeleft: 4e9, status: 'queued', trackedDownloadState: 'downloading' },
            { id: 203, movieId: 998, movie: radarrMovie(MOVIES[5]), title: 'Midnight.Ferry.2026', size: 4e9, sizeleft: 4e9, status: 'failed', trackedDownloadState: 'failed', errorMessage: 'Download failed' }
        ] };
    }
    return { records: [
        { id: 301, artistId: 22, artist: lidarrArtist(ARTISTS[4], true), album: { title: 'Second Gear', images: [{ coverType: 'cover', remoteUrl: coverArt('Second Gear') }] },
            title: 'Quiet Engines - Second Gear', size: 5e8, sizeleft: 0, status: 'completed', trackedDownloadState: 'importing' }
    ] };
}

/* ---------------- Plex ---------------- */

const PLEX_SHOW = SHOWS[0];
function plexEpisodes(s) {
    const out = [];
    for (let season = 1; season <= s.seasons; season++) {
        for (let n = 1; n <= 6; n++) {
            out.push({ ratingKey: String(s.plex * 100 + season * 10 + n), key: '/library/metadata/' + (s.plex * 100 + season * 10 + n), type: 'episode',
                title: 'Episode ' + n, index: n, parentIndex: season, grandparentTitle: s.title, grandparentRatingKey: String(s.plex),
                viewCount: season === 1 && n <= 3 ? 1 : 0, viewOffset: season === 1 && n === 4 ? 600000 : 0, duration: 2700000, thumb: '/library/metadata/ep' + n + '/thumb' });
        }
    }
    return out;
}

function plexMeta(rk) {
    rk = String(rk);
    if (rk === '6001') {
        const m = MOVIES[0];
        return { ratingKey: '6001', key: '/library/metadata/6001', type: 'movie', title: m.title, year: m.year, viewOffset: 1200000, duration: 7080000,
            Guid: [{ id: 'tmdb://' + m.tmdb }], thumb: '/library/metadata/6001/thumb', art: '/library/metadata/6001/art',
            Marker: [{ type: 'credits', startTimeOffset: 6900000, endTimeOffset: 7080000 }],
            Extras: { Metadata: [{ subtype: 'trailer', Media: [{ Part: [{ key: '/library/parts/8001/trailer.mp4?bitrate=2000' }] }] }] },
            Role: [{ tag: 'Ada Quinn', role: 'Role 1' }],
            Media: [{ container: 'mkv', videoCodec: 'hevc', audioCodec: 'eac3', videoResolution: '1080', Part: [{ id: 7001, key: '/library/parts/7001/file.mkv', duration: 7080000, container: 'mkv', indexes: 'sd',
                Stream: [{ id: 1, streamType: 1, index: 0, codec: 'hevc', displayTitle: '1080p' },
                    { id: 2, streamType: 2, index: 1, codec: 'eac3', displayTitle: 'English (EAC3 5.1)', selected: true },
                    { id: 3, streamType: 2, index: 2, codec: 'dts', displayTitle: 'Commentary (DTS)' },
                    { id: 4, streamType: 3, index: 3, codec: 'srt', displayTitle: 'English' },
                    { id: 5, streamType: 3, codec: 'srt', displayTitle: 'English (file)', key: '/library/streams/5' },
                    { id: 6, streamType: 3, index: 4, codec: 'pgs', displayTitle: 'English SDH' }] }] }] };
    }
    if (rk === String(PLEX_SHOW.plex)) {
        const eps = plexEpisodes(PLEX_SHOW);
        return { ratingKey: rk, key: '/library/metadata/' + rk + '/children', type: 'show', title: PLEX_SHOW.title, year: 2026, theme: '/library/metadata/' + rk + '/theme/1',
            Guid: [{ id: 'tvdb://' + PLEX_SHOW.tvdb }], Role: PLEX_SHOW.cast.map(c => ({ tag: c[0], role: c[1] })), OnDeck: { Metadata: [eps[3]] } };
    }
    if (rk === '5005') {
        return { ratingKey: rk, type: 'show', title: 'All Aboard!', Guid: [{ id: 'tvdb://2005' }], Role: [{ tag: 'Felix Orme', role: 'Captain Rook' }, { tag: 'Hal Nobody', role: 'Steward' }] };
    }
    const ep = plexEpisodes(PLEX_SHOW).filter(e => e.ratingKey === rk)[0];
    if (ep) {
        return Object.assign({}, ep, {
            Marker: [{ type: 'intro', startTimeOffset: 30000, endTimeOffset: 90000 }, { type: 'credits', startTimeOffset: 2600000, endTimeOffset: 2700000 }],
            Media: [{ container: 'mkv', videoCodec: 'h264', audioCodec: 'aac', videoResolution: '720', Part: [{ id: 7100 + +ep.index, key: '/library/parts/' + (7100 + +ep.index) + '/file.mkv', duration: 2700000,
                Stream: [{ id: 11, streamType: 2, index: 1, codec: 'aac', displayTitle: 'English (AAC Stereo)', selected: true }] }] }]
        });
    }
    return null;
}

const SRT = '1\n00:00:50,000 --> 00:00:54,000\nWe should <i>never</i> have come here.\n\n2\n00:00:56,000 --> 00:01:00,000\nToo late now.\n';

function plexRoute(path, method, query) {
    if (path === '/identity') { return { MediaContainer: { machineIdentifier: 'test-server-id' } }; }
    if (path === '/hubs/search') {
        const q = String(query.query || '').toLowerCase();
        const md = [];
        if ('northern lights'.indexOf(q) === 0 || q.indexOf('northern') === 0) { md.push({ type: 'movie', ratingKey: '6001', key: '/library/metadata/6001', title: 'Northern Lights', year: 2026, Guid: [{ id: 'tmdb://1001' }], viewOffset: 1200000, thumb: '/library/metadata/6001/thumb' }); }
        if (q.indexOf('harbour') === 0) { md.push({ type: 'show', ratingKey: String(PLEX_SHOW.plex), title: PLEX_SHOW.title, year: 2026, Guid: [{ id: 'tvdb://2001' }], theme: '/library/metadata/5001/theme/1', thumb: '/library/metadata/5001/thumb' }); }
        if (q.indexOf('all aboard') === 0) { md.push({ type: 'show', ratingKey: '5005', title: 'All Aboard!', year: 1981, Guid: [{ id: 'tvdb://2005' }] }); }
        if (q.indexOf('velvet') === 0) { md.push({ type: 'artist', ratingKey: '5101', key: '/library/metadata/5101', title: 'Velvet Harbour' }); }
        return { MediaContainer: { Hub: md.length ? [{ Metadata: md }] : [] } };
    }
    let m = /^\/library\/metadata\/(\d+)\/children$/.exec(path);
    if (m) {
        if (m[1] === String(PLEX_SHOW.plex)) {
            return { MediaContainer: { Metadata: Array.from({ length: PLEX_SHOW.seasons }, (x, i) => ({ ratingKey: String(9100 + i + 1), index: i + 1, thumb: '/library/metadata/s' + (i + 1) + '/thumb' })) } };
        }
        if (/^91\d\d$/.test(m[1])) {
            const season = +m[1] - 9100;
            return { MediaContainer: { Metadata: plexEpisodes(PLEX_SHOW).filter(e => e.parentIndex === season) } };
        }
        return { MediaContainer: { Metadata: [] } };
    }
    m = /^\/library\/metadata\/(\d+)\/allLeaves$/.exec(path);
    if (m) { return { MediaContainer: { Metadata: m[1] === String(PLEX_SHOW.plex) ? plexEpisodes(PLEX_SHOW) : [] } }; }
    m = /^\/library\/metadata\/(\d+)$/.exec(path);
    if (m) { const md = plexMeta(m[1]); return md ? { MediaContainer: { Metadata: [md] } } : null; }
    if (path === '/library/sections') {
        return { MediaContainer: { Directory: [{ key: '1', type: 'movie', title: 'Movies' }, { key: '2', type: 'show', title: 'TV Shows' },
            { key: '3', type: 'artist', title: 'Music' }, { key: '4', type: 'movie', title: 'Home Videos' }] } };
    }
    m = /^\/library\/sections\/(\d)\/all$/.exec(path);
    if (m) {
        const at = Math.floor(NOW / 1000);
        if (m[1] === '1') { return { MediaContainer: { Metadata: [{ title: 'Northern Lights', year: 2026, lastViewedAt: at - 3600, Guid: [{ id: 'tmdb://1001' }], thumb: '/t/1', art: '/a/1', summary: 'A made-up film.' }] } }; }
        if (m[1] === '2') { return { MediaContainer: { Metadata: [{ title: 'Harbour Lights', year: 2026, lastViewedAt: at - 7200, Guid: [{ id: 'tvdb://2001' }], thumb: '/t/2', art: '/a/2' }] } }; }
        if (m[1] === '3') { return { MediaContainer: { Metadata: [{ title: 'Velvet Harbour', lastViewedAt: at - 100, thumb: '/t/3' }, { title: 'Various', lastViewedAt: at }] } }; }
        return { MediaContainer: { Metadata: [] } };
    }
    if (/^\/library\/streams\/\d+$/.test(path)) { return { __text: SRT }; }
    if (path === '/:/timeline' || /^\/video\/:\/transcode\/universal\/(stop|ping)$/.test(path)) { return { MediaContainer: {} }; }
    if (/^\/library\/parts\/\d+$/.test(path) && method === 'PUT') { return { MediaContainer: {} }; }
    if (path === '/clients') { return { MediaContainer: { Server: [{ name: 'Test TV', machineIdentifier: 'test-tv', product: 'Plex for Samsung', platform: 'Tizen' }] } }; }
    if (path === '/resources') { return { MediaContainer: { Player: [{ title: 'Test TV', machineIdentifier: 'test-tv', product: 'Plex for Samsung', platform: 'Tizen' }] } }; }
    if (path === '/playQueues' && method === 'POST') { return { MediaContainer: { playQueueID: 42 } }; }
    if (path === '/player/playback/playMedia') { return { __text: '<Response code="200" status="OK"/>' }; }
    if (path === '/status/sessions') { return { MediaContainer: { Metadata: [{ key: '/library/metadata/6001', Player: { machineIdentifier: 'test-tv' } }] } }; }
    return null;
}

/* ---------------- Wikidata / Wikipedia ---------------- */

function entity(p) {
    const claims = {
        P106: [{ mainsnak: { datavalue: { value: { id: 'Q33999' } } } }],
        P18: p.name === 'Hal Nobody' ? undefined : [{ mainsnak: { datavalue: { value: slug(p.name) + '.jpg' } } }],
        P4985: [{ mainsnak: { datavalue: { value: String(p.tmdb) } } }]
    };
    // Ada Quinn has a second portrait and a Commons category (the banner's filmstrip)
    if (p.name === 'Ada Quinn') {
        claims.P18.push({ mainsnak: { datavalue: { value: 'Ada Quinn 2019.jpg' } } });
        claims.P373 = [{ mainsnak: { datavalue: { value: 'Ada Quinn' } } }];
    }
    if (!claims.P18) { delete claims.P18; }
    return { id: p.qid, labels: { en: { value: p.name } }, descriptions: { en: { value: p.desc } }, claims, sitelinks: { enwiki: { title: p.name } } };
}

/* ---------------- images ---------------- */

const PALETTE = ['#3b6ea8', '#a8553b', '#3ba87a', '#8a3ba8', '#a89a3b', '#3b9aa8', '#a83b6e', '#5b3ba8'];
function svgImage(url) {
    const file = decodeURIComponent(String(url).split('?')[0].split('/').pop() || 'image').replace(/\.(jpg|png|jpeg|svg)$/i, '');
    const label = file.replace(/^(poster|fanart|background|still|person|cover)-/, '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).slice(0, 28);
    let h = 0;
    for (let i = 0; i < file.length; i++) { h = (h * 31 + file.charCodeAt(i)) >>> 0; }
    const c1 = PALETTE[h % PALETTE.length], c2 = PALETTE[(h >> 3) % PALETTE.length];
    const wide = /fanart|background|still|art|1280|w1280|1200x1200/.test(url) && !/person/.test(url);
    const w = wide ? 1280 : 400, hgt = wide ? 720 : 600;
    const isPerson = /person|headshot|commons|wikipedia\.org.*upload/.test(url);
    const body = isPerson
        ? '<circle cx="200" cy="230" r="90" fill="rgba(255,255,255,.35)"/><rect x="80" y="340" width="240" height="260" rx="120" fill="rgba(255,255,255,.35)"/>'
        : '<text x="50%" y="52%" font-family="Segoe UI, Arial" font-size="' + (wide ? 72 : 40) + '" font-weight="700" fill="#fff" text-anchor="middle">' +
          label.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</text>';
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + hgt + '" viewBox="0 0 ' + w + ' ' + hgt + '">' +
        '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="' + c1 + '"/><stop offset="1" stop-color="' + c2 + '"/></linearGradient></defs>' +
        '<rect width="100%" height="100%" fill="url(#g)"/>' + body + '</svg>';
}
const isImage = url => /image\.tmdb\.org|static\.tvmaze\.com|mzstatic\.com|dzcdn\.net|commons\.wikimedia\.org\/wiki\/|upload\.wikimedia\.org|thetvdb\.com\/banners|\/photo\/:\/transcode|\/thumb$|\/art$|MediaCover/.test(url);

/* ---------------- the router ---------------- */

function parse(url) {
    const u = new URL(url, 'http://localhost');
    const query = {};
    u.searchParams.forEach((v, k) => { query[k] = v; });
    return { host: u.host, path: u.pathname, query };
}

const json = body => ({ status: 200, type: 'application/json', body: JSON.stringify(body) });
const text = (body, type) => ({ status: 200, type: type || 'text/plain', body });

/* Mutable server state for write tests (adds, deletes, commands). */
const calls = [];

function route(method, url, body) {
    method = (method || 'GET').toUpperCase();
    calls.push({ method, url, body });
    if (isImage(url)) { return text(svgImage(url), 'image/svg+xml'); }
    const { host, path, query } = parse(url);

    // Radarr's public metadata service (directly, or through the Docker proxy at /feeds/radarr)
    const radarrMeta = /api\.radarr\.video$/.test(host) ? path : (path.indexOf('/feeds/radarr') === 0 ? path.slice('/feeds/radarr'.length) : null);
    if (radarrMeta !== null) {
        if (radarrMeta === '/v1/list/tmdb/trending') { return json(MOVIES.slice(0, 6).map(metadataMovie)); }
        if (radarrMeta === '/v1/list/tmdb/popular') { return json(MOVIES.slice(2).map(metadataMovie)); }
        if (radarrMeta === '/v1/movie/bulk') { const ids = JSON.parse(body || '[]'); return json(ids.map(movieByTmdb).filter(Boolean).map(metadataMovie)); }
        const m = /^\/v1\/movie\/(\d+)$/.exec(radarrMeta);
        if (m) { const mv = movieByTmdb(m[1]); return mv ? json(metadataMovie(mv)) : { status: 404, type: 'application/json', body: '{}' }; }
    }

    // iTunes RSS charts
    if (/itunes\.apple\.com$/.test(host)) {
        const genre = /genre=(\d+)/.exec(path);
        if (/topmovies/.test(path)) {
            const list = genre && genre[1] !== '4406' ? [] : MOVIES.slice(4, 8);
            return json({ feed: { entry: list.map(m => ({ 'im:name': { label: m.title + ' (' + m.year + ')' }, 'im:releaseDate': { label: iso(m.digital) },
                'im:image': [{ label: 'https://is1-ssl.mzstatic.com/image/thumb/Video/' + slug(m.title) + '/170x170bb.png' }], category: { attributes: { label: 'Drama' } }, summary: { label: 'A made-up film.' } })) } });
        }
        if (/toptvseasons/.test(path)) {
            const list = genre && genre[1] !== '4001' ? [] : SHOWS.slice(0, 4);
            return json({ feed: { entry: list.map(s => ({ 'im:name': { label: s.title + ', Season 1' }, 'im:image': [{ label: 'https://is1-ssl.mzstatic.com/image/thumb/Video/' + slug(s.title) + '/170x170bb.png' }],
                category: { attributes: { label: 'Drama' } }, summary: { label: 'A made-up show.' } })) } });
        }
        if (/topalbums/.test(path)) {
            const list = genre && genre[1] !== '14' ? [] : ARTISTS;
            return json({ feed: { entry: list.map((a, i) => ({ id: { attributes: { 'im:id': String(4000 + i) } }, 'im:name': { label: a.album }, 'im:artist': { label: a.name },
                'im:releaseDate': { label: iso(-10 * i) }, 'im:image': [{ label: coverArt(a.album) }], category: { attributes: { label: a.genres[0] } } })) } });
        }
    }
    // Apple Music RSS v2
    if (/rss\.marketingtools\.apple\.com$/.test(host) || path.indexOf('/feeds/apple') === 0) {
        return json({ feed: { results: ARTISTS.map((a, i) => ({ id: String(5000 + i), name: a.album, artistName: a.name, releaseDate: isoDay(-7 * i),
            artworkUrl100: coverArt(a.album), genres: [{ name: a.genres[0] }, { name: 'Music' }] })) } });
    }
    // Deezer
    if (/api\.deezer\.com$/.test(host) || path.indexOf('/feeds/deezer') === 0) {
        const p = path.replace(/^\/feeds\/deezer/, '');
        if (p === '/search/playlist') { return json({ data: [{ id: 77, title: String(query.q || '').replace(/ hits$/, '') + ' Hits', nb_tracks: 50 }] }); }
        if (/^\/playlist\/\d+\/tracks$/.test(p)) { return json({ data: ARTISTS.map((a, i) => ({ title: 'Song ' + (i + 1), artist: { id: 600 + i, name: a.name }, album: { title: a.album, cover_big: coverArt(a.album), cover_xl: coverArt(a.album) } })) }); }
        if (p === '/search/artist') { const a = artistByName(query.q) || ARTISTS[0]; return json({ data: [{ id: 600 + ARTISTS.indexOf(a), name: a.name }] }); }
        if (/^\/artist\/\d+\/related$/.test(p)) { return json({ data: ARTISTS.slice(1, 4).map((a, i) => ({ id: 601 + i, name: a.name, nb_fan: 1000 * (i + 1), picture_xl: coverArt(a.name) })) }); }
    }
    // TVmaze
    if (/api\.tvmaze\.com$/.test(host)) {
        if (path === '/schedule/web' || path === '/schedule') { return json(path === '/schedule' ? [] : scheduleFor(query.date)); }
        if (path === '/lookup/shows') { const s = showByTvdb(query.thetvdb); return s ? json(mazeShow(s)) : { status: 404, type: 'application/json', body: 'null' }; }
        if (path === '/search/people') {
            const q = String(query.q || '').toLowerCase();
            return json(PEOPLE.filter(p => p.name.toLowerCase().indexOf(q.split(' ')[0]) === 0).map(p => ({ person: { id: p.tvmaze, name: p.name,
                image: p.name === 'Hal Nobody' ? null : { medium: personPhoto(p), original: personPhoto(p) } } })));
        }
        let m = /^\/shows\/(\d+)\/(images|cast|seasons|episodes)$/.exec(path);
        if (m) {
            const s = showByMaze(m[1]);
            if (!s) { return json([]); }
            if (m[2] === 'images') {
                const imgs = [{ type: 'background', main: true, resolutions: { original: { url: mazeImg(s.title, 'background'), width: 1920 } } }];
                // Harbour Lights has three posters to choose from (the picture picker)
                if (s.tvmaze === 3001) { ['poster', 'poster-alt', 'poster-season-two'].forEach(n => imgs.push({ type: 'poster', resolutions: { medium: { url: mazeImg(s.title + '-' + n, 'poster') }, original: { url: mazeImg(s.title + '-' + n, 'poster') } } })); }
                return json(imgs);
            }
            if (m[2] === 'cast') {
                return json(s.cast.map(c => ({ person: { id: person(c[0]).tvmaze, name: c[0], image: c[0] === 'Hal Nobody' ? null : { medium: personPhoto(person(c[0])), original: personPhoto(person(c[0])) } }, character: { name: c[1] } })));
            }
            if (m[2] === 'seasons') {
                return json(Array.from({ length: s.seasons }, (x, i) => ({ id: s.tvmaze * 10 + i + 1, number: i + 1, name: i === 1 ? 'The Storm Season Part Two Special Edition' : '',
                    episodeOrder: 6, premiereDate: i + 1 === s.seasons && s.airs > 0 ? isoDay(s.airs) : (s.revival ? (1981 + i) + '-09-01' : '2026-0' + (i + 1) + '-01'),
                    image: s.noPoster ? null : { medium: mazeImg(s.title + '-season-' + (i + 1), 'poster'), original: mazeImg(s.title + '-season-' + (i + 1), 'poster') }, summary: '<p>Season ' + (i + 1) + ' summary.</p>' })));
            }
            return json(mazeEpisodes(s));
        }
        m = /^\/seasons\/(\d+)\/episodes$/.exec(path);
        if (m) { const s = showByMaze(Math.floor(+m[1] / 10)); const season = +m[1] % 10; return json(s ? mazeEpisodes(s).filter(e => e.season === season) : []); }
        m = /^\/shows\/(\d+)$/.exec(path);
        if (m) { const s = showByMaze(m[1]); return s ? json(mazeShow(s)) : null; }
        m = /^\/people\/(\d+)\/castcredits$/.exec(path);
        if (m) {
            const p = PEOPLE.filter(x => x.tvmaze === +m[1])[0];
            return json(SHOWS.filter(s => p && s.cast.some(c => c[0] === p.name)).map(s => {
                const role = s.cast.filter(c => c[0] === p.name)[0][1];
                return { _embedded: { show: mazeShow(s), character: { name: role, image: { medium: mazeImg(p.name + '-as-' + role, 'character'), original: mazeImg(p.name + '-as-' + role, 'character') } } } };
            }));
        }
    }
    // Wikidata
    if (/wikidata\.org$/.test(host)) {
        if (path === '/sparql') {
            const q = String(query.query || '');
            let m = /wdt:P4985 "(\d+)"/.exec(q);
            if (m) { const p = PEOPLE.filter(x => x.tmdb === +m[1] && x.qid)[0]; return json({ results: { bindings: p ? [{ p: { value: 'http://www.wikidata.org/entity/' + p.qid } }] : [] } }); }
            m = /wdt:P161 wd:(Q\d+)/.exec(q);
            if (m) {
                const p = PEOPLE.filter(x => x.qid === m[1])[0];
                const b = [];
                MOVIES.forEach(mv => { if (p && mv.cast.indexOf(p.name) !== -1) { b.push({ w: { value: 'x' }, tmdbMovie: { value: String(mv.tmdb) }, date: { value: iso(mv.cinema) } }); } });
                SHOWS.forEach(s => { if (p && s.cast.some(c => c[0] === p.name)) { b.push({ w: { value: 'y' }, tvdb: { value: String(s.tvdb) } }); } });
                return json({ results: { bindings: b } });
            }
            return json({ results: { bindings: [] } });
        }
        if (path === '/w/api.php' && query.list === 'search') {
            const m = /haswbstatement:P4985=(\d+)/.exec(String(query.srsearch || ''));
            const p = m && PEOPLE.filter(x => x.tmdb === +m[1] && x.qid)[0];
            return json({ query: { search: p ? [{ title: p.qid }] : [] } });
        }
        if (path === '/w/api.php' && query.action === 'wbsearchentities') {
            const q = String(query.search || '').toLowerCase();
            return json({ search: PEOPLE.filter(p => p.qid && p.name.toLowerCase().indexOf(q) !== -1).map(p => ({ id: p.qid })) });
        }
        if (path === '/w/api.php' && query.action === 'wbgetentities') {
            const ents = {};
            String(query.ids || '').split('|').forEach(id => { const p = PEOPLE.filter(x => x.qid === id)[0]; if (p) { ents[id] = entity(p); } });
            return json({ entities: ents });
        }
    }
    // Wikimedia Commons: a person's category (portraits, plus files the filmstrip must skip)
    const thumb = title => 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/' + title.replace(/ /g, '_') + '/500px-' + title.replace(/ /g, '_');
    if (/commons\.wikimedia\.org$/.test(host) && path === '/w/api.php' && query.titles) {
        const pages = {};
        String(query.titles).split('|').forEach((t, i) => { pages[-(i + 1)] = { title: t, imageinfo: [{ thumburl: thumb(t.replace(/^File:/, '')) }] }; });
        return json({ query: { pages } });
    }
    if (/commons\.wikimedia\.org$/.test(host) && path === '/w/api.php' && query.generator === 'categorymembers') {
        const file = (title, width, height, mime) => ({ title: 'File:' + title, imageinfo: [{ width, height, mime: mime || 'image/jpeg', thumburl: thumb(title) }] });
        const files = query.gcmtitle === 'Category:Ada Quinn' ? [
            file('Ada Quinn at the Harbour Lights premiere.jpg', 800, 1200),
            file('Ada Quinn 2019.jpg', 900, 1200),                                   // already on Wikidata
            file('Ada Quinn signature.svg', 400, 200, 'image/svg+xml'),
            file('Ada Quinn and Bruno Calder.jpg', 800, 1100),                       // a group shot
            file('Glass Harbour cast panorama Quinn.jpg', 3000, 900),                // landscape
            file('Festival crowd.jpg', 800, 1200)                                    // not her
        ] : [];
        const pages = {};
        files.forEach((f, i) => { pages[-(i + 1)] = f; });
        return json({ query: { pages } });
    }
    // Wikipedia
    if (/en\.wikipedia\.org$/.test(host)) {
        const media = /^\/api\/rest_v1\/page\/media-list\/(.+)$/.exec(path);
        if (media) {
            const title = decodeURIComponent(media[1]).replace(/_/g, ' ');
            const items = title === 'Ada Quinn' ? [
                { type: 'image', title: 'File:Ada Quinn as Mara.jpg', srcset: [{ src: '//upload.wikimedia.org/wikipedia/en/thumb/a/ab/Ada_Quinn_as_Mara.jpg/640px-Ada_Quinn_as_Mara.jpg' }] },
                { type: 'image', title: 'File:Harbour Lights logo.svg', srcset: [{ src: '//upload.wikimedia.org/wikipedia/en/c/cd/Harbour_Lights_logo.svg' }] }
            ] : [];
            return json({ items });
        }
        let m = /^\/api\/rest_v1\/page\/summary\/(.+)$/.exec(path);
        if (m) {
            const title = decodeURIComponent(m[1]).replace(/_/g, ' ');
            const p = PEOPLE.filter(x => x.name === title && x.qid)[0];
            if (!p) { return { status: 404, type: 'application/json', body: '{"type":"not_found"}' }; }
            return json({ type: 'standard', title, description: p.desc, extract: p.name + ' is a fictional ' + (/actress/.test(p.desc) ? 'actress' : 'actor') + ' made up for Reelhouse\'s tests. They appear in several of the placeholder titles.',
                originalimage: { source: 'https://upload.wikimedia.org/wikipedia/commons/person-' + slug(p.name) + '.jpg' } });
        }
        if (path === '/w/api.php' && query.list === 'search') {
            const q = String(query.srsearch || '').replace(/ actor$/, '');
            return json({ query: { search: PEOPLE.filter(p => p.qid && p.name === q).map(p => ({ title: p.name })), searchinfo: {} } });
        }
    }
    // Sonarr / Radarr / Lidarr
    const arr = /:(8989|7878|8686)$/.exec(host);
    if (arr) {
        const kind = arr[1] === '8989' ? 'tv' : arr[1] === '7878' ? 'movie' : 'music';
        const p = path.replace(/^\/api\/v[13]/, '');
        if (p === '/system/status') { return json({ version: kind === 'tv' ? '4.0.0' : '5.0.0' }); }
        if (p === '/rootfolder') { return json([{ path: '/media/' + kind, defaultQualityProfileId: 2, defaultMetadataProfileId: 1 }]); }
        if (p === '/qualityprofile') { return json([{ id: 1, name: 'Any' }, { id: 4, name: 'HD-1080p' }, { id: 8, name: 'Low Quality 1080' }]); }
        if (p === '/metadataprofile') { return json([{ id: 1, name: 'Standard' }]); }
        if (p === '/languageprofile') { return { status: 404, type: 'application/json', body: '{"message":"Not found"}' }; }
        if (p === '/queue') { return json(arrQueue(kind)); }
        if (/^\/queue\/\d+$/.test(p) && method === 'DELETE') { return json({}); }
        if (p === '/command' && method === 'POST') { return json({ id: 1, name: (JSON.parse(body || '{}')).name }); }
        if (kind === 'tv') {
            if (p === '/series' && method === 'GET') {
                if (query.tvdbId) { const s = showByTvdb(query.tvdbId); return json(s && s.sonarr ? [sonarrSeries(s, true)] : []); }
                return json(SHOWS.filter(s => s.sonarr).map(s => sonarrSeries(s, true)));
            }
            if (p === '/series' && method === 'POST') { const o = JSON.parse(body); o.id = 99; return json(o); }
            if (p === '/series/lookup') {
                const term = String(query.term || '');
                const m = /^tvdb:(\d+)$/.exec(term);
                const list = m ? [showByTvdb(m[1])].filter(Boolean) : SHOWS.filter(s => s.title.toLowerCase().indexOf(term.toLowerCase()) !== -1);
                return json(list.map(s => sonarrSeries(s, true)));
            }
            let m = /^\/series\/(\d+)$/.exec(p);
            if (m && method === 'PUT') { return json(JSON.parse(body)); }
            if (m) { const s = SHOWS.filter(x => x.sonarr === +m[1])[0] || (+m[1] === 99 ? SHOWS[1] : null); return s ? json(Object.assign(sonarrSeries(s, true), { id: +m[1] })) : { status: 404, type: 'application/json', body: '{}' }; }
            if (p === '/episode') {
                const s = SHOWS.filter(x => x.sonarr === +query.seriesId)[0] || SHOWS[1];
                return json(mazeEpisodes(s).filter(e => query.seasonNumber == null || e.season === +query.seasonNumber)
                    .map(e => ({ id: e.id, seriesId: +query.seriesId, seasonNumber: e.season, episodeNumber: e.number, title: e.name, airDate: e.airdate, hasFile: !!(s.files && e.season === 1), monitored: true })));
            }
            if (p === '/episode/monitor' && method === 'PUT') { return json([]); }
            if (p === '/wanted/missing') { const s = SHOWS[2]; return json({ records: [1, 2].map(n => ({ seriesId: s.sonarr, series: sonarrSeries(s, true), seasonNumber: 3, episodeNumber: n, airDateUtc: iso(-n) })) }); }
            if (p === '/history') { const s = SHOWS[0]; return json({ records: [{ seriesId: s.sonarr, series: sonarrSeries(s, true), episode: { seasonNumber: 1, episodeNumber: 8, title: 'Last Light' }, date: iso(-1) }] }); }
        }
        if (kind === 'movie') {
            if (p === '/movie' && method === 'GET' && query.tmdbId) { const mv = movieByTmdb(query.tmdbId); return json(mv && mv.radarr ? [radarrMovie(mv, true)] : []); }
            if (p === '/movie' && method === 'POST') { const o = JSON.parse(body); o.id = 98; return json(o); }
            if (p === '/movie/lookup/tmdb') { const mv = movieByTmdb(query.tmdbId); return mv ? json(radarrMovie(mv)) : json([]); }
            if (p === '/movie/lookup') { const t = String(query.term || '').toLowerCase(); return json(MOVIES.filter(m => t.indexOf(m.title.toLowerCase()) !== -1 || m.title.toLowerCase().indexOf(t) !== -1).map(m => radarrMovie(m, true))); }
            const m = /^\/movie\/(\d+)$/.exec(p);
            if (m) { const mv = MOVIES.filter(x => x.radarr === +m[1])[0]; return mv ? json(radarrMovie(mv, true)) : { status: 404, type: 'application/json', body: '{}' }; }
            if (p === '/wanted/missing') { return json({ records: [radarrMovie(MOVIES[1], true), Object.assign(radarrMovie(MOVIES[5]), { id: 506, isAvailable: false })] }); }
            if (p === '/history') { return json({ records: [{ movieId: 505, movie: radarrMovie(MOVIES[4], true), date: iso(-2) }] }); }
        }
        if (kind === 'music') {
            if (p === '/artist' && method === 'GET') { return json(ARTISTS.filter(a => a.lidarr).map(a => lidarrArtist(a, true))); }
            if (p === '/artist' && method === 'POST') { const o = JSON.parse(body); o.id = 97; return json(o); }
            if (p === '/artist/lookup') { const a = artistByName(query.term) || ARTISTS.filter(x => x.name.toLowerCase().indexOf(String(query.term).toLowerCase()) !== -1)[0]; return json(a ? [lidarrArtist(a, true)] : []); }
            const m = /^\/artist\/(\d+)$/.exec(p);
            if (m) { const a = ARTISTS.filter(x => x.lidarr === +m[1])[0]; return a ? json(lidarrArtist(a, true)) : { status: 404, type: 'application/json', body: '{}' }; }
            if (p === '/wanted/missing') { return json({ records: [{ artistId: 22, artist: lidarrArtist(ARTISTS[4], true), title: 'Second Gear', releaseDate: iso(-30) }] }); }
            if (p === '/history') { return json({ records: [{ artistId: 21, artist: lidarrArtist(ARTISTS[0], true), album: { title: 'Low Tide' }, date: iso(-3) }] }); }
        }
        return { status: 404, type: 'application/json', body: '{"message":"Not found"}' };
    }
    // Plex (the configured server, and plex.tv's resource list)
    if (/plex\.tv$/.test(host)) { return json([{ clientIdentifier: 'test-server-id', connections: [{ local: true, relay: false, protocol: 'https', uri: 'https://10-0-0-2.test.plex.direct:32400' }] }]); }
    if (/:32400$/.test(host)) {
        const r = plexRoute(path, method, query);
        if (r && r.__text) { return text(r.__text, /<Response/.test(r.__text) ? 'text/xml' : 'text/plain'); }
        return r ? json(r) : { status: 404, type: 'text/plain', body: 'not found' };
    }
    return null;
}

module.exports = { route, calls, MOVIES, SHOWS, ARTISTS, PEOPLE, svgImage, SRT, NOW };
