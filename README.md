# Streamiško

A minimal Stremio addon scaffold designed to be deployed on Vercel and extended incrementally.

## Current behavior

For every movie, the addon returns a single placeholder stream entry:

**Hello Streamiško 👋**

There is no torrent search, SKTorrent authentication, or TorBox integration yet.

## Endpoints

- `/manifest.json` — Stremio addon manifest
- `/stream/movie/:id.json` — placeholder stream response for any movie
- `/` — tiny landing page

## Deploy to Vercel

1. Import this GitHub repository into Vercel.
2. Keep the default project settings.
3. Deploy.
4. In Stremio, install the addon using:

   `https://YOUR-VERCEL-DOMAIN.vercel.app/manifest.json`

After installation, open any movie. The Streamiško stream section should contain the placeholder message.

## Local development

Install dependencies and start Vercel's local development server:

```bash
npm install
npm run dev
```

Then use:

`http://localhost:3000/manifest.json`

## Planned direction

Later iterations can add:

1. SKTorrent credentials/configuration.
2. Movie lookup on `sktorrent.eu`.
3. Torrent selection.
4. TorBox API integration.
5. Returning playable Stremio streams.
