/*
 * Default connection settings, baked into the package.
 * Paste your API keys here before packaging so you don't have to type them
 * with the remote (Settings > General > Security > API Key in each app).
 * Anything changed on the in-app Settings screen overrides these values.
 *
 * Note: some Samsung TVs can't resolve ".local" (mDNS) names. If the app
 * reports "Cannot reach server", use the IP instead: http://<media-server-ip>:8989
 */
// qualityProfile: the profile *name* new titles are added with ('' = the app's first profile;
// for Lidarr '' = the root folder's default profile).
var MEDIALOADER_DEFAULTS = {
    tv:    { url: 'http://media-server:8989', apiKey: '', qualityProfile: 'HD-1080p' },          // Sonarr
    movie: { url: 'http://media-server:7878', apiKey: '', qualityProfile: 'Low Quality 1080' },  // Radarr
    music: { url: 'http://media-server:8686', apiKey: '', qualityProfile: '' }                   // Lidarr
};

// Plex server for "Play In Plex". token = the Plex Home admin / server owner's token; leave empty and
// Play In Plex just opens the Plex app.
var MEDIALOADER_PLEX = { url: 'http://<plex-server-ip>:32400', token: '' };
