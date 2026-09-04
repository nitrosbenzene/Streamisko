const manifest = {
  id: "community.streamisko",
  version: "0.3.0",
  name: "Streamiško",
  description: "Minimal Streamiško Stremio addon scaffold.",
  resources: ["stream"],
  types: ["movie"],
  catalogs: []
};

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function getBaseUrl(req) {
  const protocol = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${protocol}://${host}`;
}

async function getMovieDetails(imdbId) {
  const fallback = {
    name: "Unknown movie",
    year: "Unknown year"
  };

  if (!/^tt\d+$/.test(imdbId)) {
    return fallback;
  }

  try {
    const response = await fetch(
      `https://v3-cinemeta.strem.io/meta/movie/${encodeURIComponent(imdbId)}.json`
    );

    if (!response.ok) {
      return fallback;
    }

    const data = await response.json();
    const meta = data && data.meta;

    if (!meta) {
      return fallback;
    }

    let year = fallback.year;

    if (meta.releaseInfo) {
      const yearMatch = String(meta.releaseInfo).match(/\d{4}/);
      if (yearMatch) {
        year = yearMatch[0];
      }
    } else if (meta.released) {
      const releasedYear = new Date(meta.released).getUTCFullYear();
      if (Number.isFinite(releasedYear)) {
        year = String(releasedYear);
      }
    }

    return {
      name: meta.name || fallback.name,
      year
    };
  } catch {
    return fallback;
  }
}

async function fetchSkTorrentPage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 Streamisko/0.3",
        Accept: "text/html,application/xhtml+xml"
      }
    });

    if (!response.ok) {
      return null;
    }

    return await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function addTorrentIdsFromHtml(html, torrentIds) {
  if (!html) {
    return;
  }

  const detailLinkRegex = /details\.php\?[^"'<>\s]*/gi;

  for (const match of html.matchAll(detailLinkRegex)) {
    const idMatch = match[0].match(/[?&](?:amp;)?id=([a-f0-9]{40})/i);
    if (idMatch) {
      torrentIds.add(idMatch[1].toLowerCase());
    }
  }
}

function getLastSearchPage(html) {
  let lastPage = 1;
  const pageRegex = /(?:\?|&|&amp;)page=(\d+)/gi;

  for (const match of html.matchAll(pageRegex)) {
    const page = Number(match[1]);
    if (Number.isSafeInteger(page) && page > lastPage) {
      lastPage = page;
    }
  }

  return lastPage;
}

async function countSkTorrentResults(movie) {
  if (!movie || movie.name === "Unknown movie") {
    return 0;
  }

  const searchTerms = [movie.name];
  if (/^\d{4}$/.test(movie.year)) {
    searchTerms.push(movie.year);
  }

  const searchUrl = new URL("https://sktorrent.eu/torrent/torrents_v2.php");
  searchUrl.searchParams.set("search", searchTerms.join(" "));
  searchUrl.searchParams.set("category", "0");
  searchUrl.searchParams.set("zaner", "");
  searchUrl.searchParams.set("jazyk", "");
  searchUrl.searchParams.set("active", "0");

  const firstPageHtml = await fetchSkTorrentPage(searchUrl);
  if (!firstPageHtml) {
    return 0;
  }

  const torrentIds = new Set();
  addTorrentIdsFromHtml(firstPageHtml, torrentIds);

  const lastPage = getLastSearchPage(firstPageHtml);
  const pages = [];

  for (let page = 2; page <= lastPage; page += 1) {
    pages.push(page);
  }

  const batchSize = 5;

  for (let index = 0; index < pages.length; index += batchSize) {
    const batch = pages.slice(index, index + batchSize);
    const htmlPages = await Promise.all(
      batch.map((page) => {
        const pageUrl = new URL(searchUrl);
        pageUrl.searchParams.set("page", String(page));
        return fetchSkTorrentPage(pageUrl);
      })
    );

    for (const html of htmlPages) {
      addTorrentIdsFromHtml(html, torrentIds);
    }
  }

  return torrentIds.size;
}

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== "GET") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  const route = req.query.route;

  if (route === "manifest") {
    return sendJson(res, 200, manifest);
  }

  if (route === "stream") {
    if (req.query.type !== "movie") {
      return sendJson(res, 200, { streams: [] });
    }

    const imdbId = String(req.query.id || "");
    const movie = await getMovieDetails(imdbId);
    const torrentCount = await countSkTorrentResults(movie);

    return sendJson(res, 200, {
      streams: [
        {
          name: "Streamiško",
          description: `Hello Streamiško 👋\n${movie.name} (${movie.year}) • IMDb: ${imdbId || "unknown"}\nFound torrents on sktorrent.eu: ${torrentCount}`,
          externalUrl: getBaseUrl(req)
        }
      ]
    });
  }

  if (route === "home") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Streamiško</title>
  </head>
  <body>
    <h1>Hello Streamiško 👋</h1>
    <p>This is the first minimal Stremio addon scaffold.</p>
  </body>
</html>`);
  }

  return sendJson(res, 404, { error: "Not found" });
};