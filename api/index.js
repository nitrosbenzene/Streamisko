const manifest = {
  id: "community.streamisko",
  version: "0.5.0",
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

function getSkTorrentCredentials() {
  const uid = String(process.env.SKTORRENT_UID || "").trim();
  const pass = String(process.env.SKTORRENT_PASS || "").trim();

  if (!uid || !pass) {
    return null;
  }

  return { uid, pass };
}

function getSkTorrentHeaders(accept) {
  const headers = {
    "User-Agent": "Mozilla/5.0 Streamisko/0.5",
    Accept: accept,
    "Accept-Language": "sk,cs;q=0.9,en;q=0.6",
    Referer: "https://sktorrent.eu/"
  };

  const credentials = getSkTorrentCredentials();
  if (credentials) {
    headers.Cookie = `uid=${credentials.uid}; pass=${credentials.pass}`;
  }

  return headers;
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
      headers: getSkTorrentHeaders("text/html,application/xhtml+xml")
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

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:0*39|x0*27);/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_, code) =>
      String.fromCodePoint(parseInt(code, 16))
    );
}

function htmlToText(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function getTorrentNameFromHref(href, id) {
  try {
    const decodedHref = decodeHtmlEntities(href);
    const url = new URL(decodedHref, "https://sktorrent.eu/torrent/");
    const name = url.searchParams.get("name");

    if (name) {
      return name.replace(/-/g, " ").replace(/\s+/g, " ").trim();
    }
  } catch {
    // Fall through to a short ID label.
  }

  return `SKTorrent ${id.slice(0, 8)}`;
}

function getLastSearchPage(html) {
  let lastPage = 0;
  const pageRegex = /(?:\?|&|&amp;)page=(\d+)/gi;

  for (const match of html.matchAll(pageRegex)) {
    const page = Number(match[1]);
    if (Number.isSafeInteger(page) && page > lastPage) {
      lastPage = page;
    }
  }

  return lastPage;
}

function mergeTorrentResult(torrentsById, torrent) {
  const existing = torrentsById.get(torrent.id);

  if (!existing) {
    torrentsById.set(torrent.id, torrent);
    return;
  }

  for (const key of ["title", "size", "added", "seeders", "leechers"]) {
    if ((!existing[key] || existing[key] === "?") && torrent[key]) {
      existing[key] = torrent[key];
    }
  }
}

function addTorrentResultsFromHtml(html, torrentsById) {
  if (!html) {
    return;
  }

  const anchorRegex = /<a\b[^>]*href=["']([^"']*details\.php\?[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const matches = Array.from(html.matchAll(anchorRegex));

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const href = decodeHtmlEntities(match[1]);
    const idMatch = href.match(/[?&]id=([a-f0-9]{40})/i);

    if (!idMatch) {
      continue;
    }

    const id = idMatch[1].toLowerCase();
    const anchorTitle = htmlToText(match[2]);
    const nextMatch = matches[index + 1];
    const segmentStart = match.index + match[0].length;
    const segmentEnd = nextMatch ? nextMatch.index : Math.min(html.length, segmentStart + 2500);
    const segmentText = htmlToText(html.slice(segmentStart, segmentEnd));

    const sizeMatch = segmentText.match(/Velkost\s*:?\s*(.+?)(?=\s*\|\s*Pridany|\s+Pridany\b|$)/i);
    const addedMatch = segmentText.match(/Pridany\s*:?\s*([0-9./-]+)/i);
    const seedersMatch = segmentText.match(/Odosielaju\s*:\s*(\d+)/i);
    const leechersMatch = segmentText.match(/Stahuju\s*:\s*(\d+)/i);

    mergeTorrentResult(torrentsById, {
      id,
      title: anchorTitle || getTorrentNameFromHref(href, id),
      size: sizeMatch ? sizeMatch[1].trim() : "?",
      added: addedMatch ? addedMatch[1] : "?",
      seeders: seedersMatch ? seedersMatch[1] : "?",
      leechers: leechersMatch ? leechersMatch[1] : "?"
    });
  }
}

async function findSkTorrentResults(movie) {
  if (!movie || movie.name === "Unknown movie") {
    return [];
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
    return [];
  }

  const torrentsById = new Map();
  addTorrentResultsFromHtml(firstPageHtml, torrentsById);

  const lastPage = getLastSearchPage(firstPageHtml);
  const pages = [];

  // The unnumbered response is the first page; SKTorrent can use page=1 for
  // the next page. IDs are deduplicated if the site aliases either URL.
  for (let page = 1; page <= lastPage; page += 1) {
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
      addTorrentResultsFromHtml(html, torrentsById);
    }
  }

  return Array.from(torrentsById.values());
}

function contentDispositionFileName(contentDisposition) {
  if (!contentDisposition) {
    return null;
  }

  const utf8Match = contentDisposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (utf8Match) {
    const encoded = utf8Match[1].trim().replace(/^"|"$/g, "");
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }

  const quotedMatch = contentDisposition.match(/filename\s*=\s*"([^"]+)"/i);
  if (quotedMatch) {
    return quotedMatch[1].trim();
  }

  const plainMatch = contentDisposition.match(/filename\s*=\s*([^;]+)/i);
  if (plainMatch) {
    return plainMatch[1].trim().replace(/^"|"$/g, "");
  }

  return null;
}

async function fetchTorrentFileName(id) {
  if (!getSkTorrentCredentials()) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  const url = `https://sktorrent.eu/torrent/download.php?id=${encodeURIComponent(id)}`;

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: getSkTorrentHeaders("application/x-bittorrent,application/octet-stream,*/*")
    });

    if (!response.ok) {
      return null;
    }

    const contentType = response.headers.get("content-type") || "";
    if (/text\/html/i.test(contentType)) {
      return null;
    }

    const contentDisposition = response.headers.get("content-disposition") || "";
    const headerName = contentDispositionFileName(contentDisposition);

    if (headerName) {
      return headerName;
    }

    try {
      const finalUrl = new URL(response.url);
      const lastPart = decodeURIComponent(finalUrl.pathname.split("/").pop() || "");
      if (/\.torrent$/i.test(lastPart)) {
        return lastPart;
      }
    } catch {
      // No usable filename in the final URL.
    }

    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function addTorrentFileNames(torrents) {
  if (!getSkTorrentCredentials() || !torrents.length) {
    return torrents.map((torrent) => ({ ...torrent, fileName: null }));
  }

  const enriched = new Array(torrents.length);
  const batchSize = 8;

  for (let index = 0; index < torrents.length; index += batchSize) {
    const batch = torrents.slice(index, index + batchSize);
    const batchResults = await Promise.all(
      batch.map(async (torrent) => ({
        ...torrent,
        fileName: await fetchTorrentFileName(torrent.id)
      }))
    );

    for (let offset = 0; offset < batchResults.length; offset += 1) {
      enriched[index + offset] = batchResults[offset];
    }
  }

  return enriched;
}

function torrentToStream(torrent, index) {
  const fileName = torrent.fileName || "Unavailable (SKTorrent auth required or download failed)";
  const details = [
    torrent.title,
    `Torrent file: ${fileName}`,
    `Size: ${torrent.size} • Seeders: ${torrent.seeders} • Leechers: ${torrent.leechers}`,
    `Added: ${torrent.added} • SKTorrent ID: ${torrent.id}`
  ];

  return {
    name: `Streamiško • SKTorrent #${index + 1}`,
    description: details.join("\n"),
    externalUrl: `https://sktorrent.eu/torrent/details.php?id=${torrent.id}`
  };
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
    const foundTorrents = await findSkTorrentResults(movie);
    const torrents = await addTorrentFileNames(foundTorrents);

    const helloStream = {
      name: "Streamiško",
      description: `Hello Streamiško 👋\n${movie.name} (${movie.year}) • IMDb: ${imdbId || "unknown"}\nFound torrents on sktorrent.eu: ${torrents.length}`,
      externalUrl: getBaseUrl(req)
    };

    return sendJson(res, 200, {
      streams: [helloStream, ...torrents.map(torrentToStream)]
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
