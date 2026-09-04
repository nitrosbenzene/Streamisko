# Streamiško

A minimal Stremio addon scaffold designed to be deployed on Vercel and extended incrementally.

## Current behavior

For every movie, the addon:

1. Resolves the movie title and year from its IMDb ID.
2. Searches `sktorrent.eu` across all returned result pages.
3. Keeps the first Stremio stream as the **Hello Streamiško 👋** summary entry.
4. Adds one additional Stremio stream for each unique SKTorrent result.
5. When SKTorrent credentials are configured, authenticates to the torrent download endpoint and shows the actual `.torrent` filename returned by SKTorrent.

Torrent entries currently show:

- SKTorrent listing title
- Torrent file name
- Size
- Seeders / leechers
- Added date
- SKTorrent ID

Selecting a torrent entry still opens its SKTorrent detail page. TorBox playback will be added later.

## Endpoints

- `/manifest.json` — Stremio addon manifest
- `/stream/movie/:id.json` — movie stream results
- `/` — tiny landing page

## SKTorrent credentials

Do **not** hardcode SKTorrent credentials in this repository. The repository is public, so committed secrets would be visible in the source and Git history.

The addon reads these server-side environment variables:

```text
SKTORRENT_UID=your_sktorrent_uid
SKTORRENT_PASS=your_sktorrent_pass
```

A safe placeholder-only `.env.example` is included in the repository.

### Configure on Vercel

In your Vercel project, add both environment variables under the project's environment-variable settings, then redeploy the project so the serverless function receives them.

The values are only read on the server and are used to send SKTorrent's authentication cookies (`uid` and `pass`) to `https://sktorrent.eu/torrent/download.php`.

If the credentials are missing or SKTorrent rejects the download, torrent search results still appear, but the torrent filename is shown as unavailable.

## Deploy to Vercel

1. Import this GitHub repository into Vercel.
2. Add `SKTORRENT_UID` and `SKTORRENT_PASS` as private environment variables.
3. Deploy or redeploy.
4. In Stremio, install the addon using:

   `https://YOUR-VERCEL-DOMAIN.vercel.app/manifest.json`

## Local development

Create a local `.env` file (it is ignored by Git):

```text
SKTORRENT_UID=your_sktorrent_uid
SKTORRENT_PASS=your_sktorrent_pass
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
2. Torrent selection rules.
3. TorBox API integration.
4. Adding the selected torrent to TorBox.
5. Returning playable Stremio streams.
