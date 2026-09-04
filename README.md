# Streamiško

A Stremio addon designed for Vercel that searches SKTorrent results, checks TorBox cache availability, and exposes cached results as playable streams.

## Current behavior

Streamiško supports both **movies** and **series episodes** from Stremio/Cinemeta IMDb IDs.

For each request, the addon:

1. Resolves the movie or series metadata from Cinemeta.
2. Searches `sktorrent.eu` across all returned result pages.
3. Keeps the first Stremio stream as the **Hello Streamiško 👋** summary entry.
4. Shows TorBox API connection status in the Hello stream.
5. Adds one additional Stremio stream for each unique SKTorrent result.
6. Authenticates to the SKTorrent download endpoint when credentials are configured and reads the `.torrent` metadata.
7. Extracts the real torrent filename and info hash.
8. Checks whether each torrent is cached on TorBox.
9. Sorts results with cached torrents first, then uncached, then unknown; each group is sorted by size from largest to smallest.
10. For cached torrents, exposes a playable Stremio stream URL that is resolved lazily only after you click it.

### Movies

Movie requests use the IMDb ID directly, for example `tt6723592`.

The Hello stream looks similar to:

```text
Hello Streamiško 👋
Tenet (2020) • IMDb: tt6723592
Found torrents on sktorrent.eu: 27
TorBox: Connected ✅
```

### Series

Stremio/Cinemeta identifies a series episode as:

```text
<IMDb series ID>:<season>:<episode>
```

For example:

```text
tt0898266:9:17
```

Streamiško resolves the base series IMDb ID through Cinemeta and searches SKTorrent using the episode marker, primarily `S09E17`, with a `9x17` fallback when necessary.

A series Hello stream looks similar to:

```text
Hello Streamiško 👋
Example Series (2010) • S09E17 • Episode title
IMDb: tt0898266 • Video: tt0898266:9:17
Found torrents on sktorrent.eu: 4
TorBox: Connected ✅
```

For cached multi-file torrents or season packs, the series playback resolver prefers a video filename matching the requested `SxxExx` or `1x02` episode marker before falling back to the largest video file.

## Torrent stream information

Torrent entries show:

- SKTorrent listing title
- Episode marker for series results
- Torrent file name
- TorBox cache status (`Yes`, `No`, or `Unknown`)
- Size
- Seeders / leechers
- Added date
- SKTorrent ID

When `Cached on TorBox: Yes ✅`, selecting the stream calls a server-side Streamiško play route. Streamiško re-checks the cache, finds or adds the cached torrent to the configured TorBox account with `add_only_if_cached=true`, selects the appropriate video file, requests a TorBox direct link, and redirects Stremio to that link.

Uncached or unknown-cache results remain non-playable and open the SKTorrent detail page instead.

## Endpoints

- `/manifest.json` — Stremio addon manifest for `movie` and `series`
- `/stream/movie/:id.json` — movie stream results
- `/stream/series/:videoId.json` — series episode results, e.g. `/stream/series/tt0898266:9:17.json`
- `/api/index?route=play&torrent=<SKTORRENT_ID>` — internal movie playback resolver
- `/api/series?route=play&torrent=<SKTORRENT_ID>&season=<S>&episode=<E>` — internal series playback resolver
- `/` — landing page

## Environment variables

Do **not** hardcode credentials or API keys in this repository. The repository is public, so committed secrets would be visible in the source and Git history.

The addon reads these server-side environment variables:

```text
SKTORRENT_UID=your_sktorrent_uid
SKTORRENT_PASS=your_sktorrent_pass
TORBOX_API_KEY=your_torbox_api_key
```

A safe placeholder-only `.env.example` is included in the repository.

### SKTorrent credentials

`SKTORRENT_UID` and `SKTORRENT_PASS` are used server-side to send SKTorrent authentication cookies (`uid` and `pass`) to the torrent download endpoint.

If the credentials are missing or SKTorrent rejects a download, search results can still appear, but torrent metadata such as the real filename and info hash may be unavailable.

### TorBox API key

`TORBOX_API_KEY` is used server-side to:

- verify that the TorBox API key is valid;
- show `TorBox: Connected ✅` or an error status in the Hello stream;
- check each found torrent's info hash against TorBox's cache API;
- show `Cached on TorBox: Yes ✅`, `No ❌`, or `Unknown ⚠️`;
- add a cached torrent to the configured TorBox account only when playback is requested;
- request a direct TorBox file URL and redirect Stremio to it.

The API key is never included in the Stremio stream-list response and should only be stored as a private environment variable.

## Configure on Vercel

In the Streamiško Vercel project, add these private environment variables under **Settings → Environment Variables**:

```text
SKTORRENT_UID
SKTORRENT_PASS
TORBOX_API_KEY
```

Apply them to the environments you use (normally Production, and Preview if needed), then redeploy so the serverless functions receive the values.

## Deploy to Vercel

1. Import this GitHub repository into Vercel.
2. Configure `SKTORRENT_UID`, `SKTORRENT_PASS`, and `TORBOX_API_KEY` as private environment variables.
3. Deploy or redeploy.
4. In Stremio, install the addon using:

   `https://YOUR-VERCEL-DOMAIN.vercel.app/manifest.json`

If the addon was already installed before series support was added, reinstalling or refreshing the addon may be needed so Stremio reads the updated manifest containing both `movie` and `series` types.

## Local development

Create a local `.env` file (it is ignored by Git):

```text
SKTORRENT_UID=your_sktorrent_uid
SKTORRENT_PASS=your_sktorrent_pass
TORBOX_API_KEY=your_torbox_api_key
```

Then install dependencies and start Vercel's local development server:

```bash
npm install
npm run dev
```

Use:

`http://localhost:3000/manifest.json`

## Planned direction

Later iterations can add:

1. More SKTorrent search fallbacks for localized series names and season packs.
2. More precise episode matching for unusual release naming conventions.
3. Caching repeated SKTorrent/TorBox lookups for faster stream responses.
4. More explicit playback diagnostics in Stremio when TorBox cannot resolve a file.
