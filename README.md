# Streamiško

A minimal Stremio addon designed to be deployed on Vercel and extended incrementally.

## Current behavior

For every movie, the addon:

1. Resolves the movie title and year from its IMDb ID.
2. Searches `sktorrent.eu` across all returned result pages.
3. Keeps the first Stremio stream as the **Hello Streamiško 👋** summary entry.
4. Shows TorBox API connection status in the Hello stream.
5. Adds one additional Stremio stream for each unique SKTorrent result.
6. When SKTorrent credentials are configured, authenticates to the torrent download endpoint, reads the `.torrent` metadata, and shows a meaningful torrent filename.
7. Extracts the torrent info hash and checks whether that torrent is cached on TorBox.
8. For torrents reported as cached on TorBox, exposes a playable Stremio stream URL. Playback is resolved lazily only after you click that stream.

The Hello stream includes information such as:

```text
Hello Streamiško 👋
Tenet (2020) • IMDb: tt6723592
Found torrents on sktorrent.eu: 27
TorBox: Connected ✅
```

Torrent entries currently show:

- SKTorrent listing title
- Torrent file name
- TorBox cache status (`Yes`, `No`, or `Unknown`)
- Size
- Seeders / leechers
- Added date
- SKTorrent ID

When `Cached on TorBox: Yes ✅`, selecting the stream calls Streamiško's server-side play route. Streamiško re-checks the cache, finds or adds the cached torrent to the configured TorBox account with `add_only_if_cached=true`, selects the largest likely video file, requests a TorBox direct link, and redirects Stremio to that link.

Uncached or unknown-cache results remain non-playable and open the SKTorrent detail page instead.

## Endpoints

- `/manifest.json` — Stremio addon manifest
- `/stream/movie/:id.json` — movie stream results
- `/api/index?route=play&torrent=<SKTORRENT_ID>` — internal lazy playback resolver for cached TorBox torrents
- `/` — tiny landing page

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

If the credentials are missing or SKTorrent rejects a download, search results can still appear, but torrent metadata such as the real torrent filename and info hash may be unavailable.

### TorBox API key

`TORBOX_API_KEY` is used server-side with TorBox's API.

The addon currently uses it to:

- verify that the TorBox API key is valid;
- show `TorBox: Connected ✅` or an error status in the Hello stream;
- check each found torrent's info hash against TorBox's cache API;
- show `Cached on TorBox: Yes ✅`, `No ❌`, or `Unknown ⚠️` in each torrent stream entry;
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

Apply them to the environments you use (normally Production, and Preview if needed), then redeploy so the serverless function receives the values.

## Deploy to Vercel

1. Import this GitHub repository into Vercel.
2. Configure `SKTORRENT_UID`, `SKTORRENT_PASS`, and `TORBOX_API_KEY` as private environment variables.
3. Deploy or redeploy.
4. In Stremio, install the addon using:

   `https://YOUR-VERCEL-DOMAIN.vercel.app/manifest.json`

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

1. Better torrent metadata parsing and ranking.
2. Better file selection for multi-file torrents and episode packs.
3. Caching repeated SKTorrent/TorBox lookups for faster stream responses.
4. More explicit playback diagnostics in Stremio when TorBox cannot resolve a file.
