const crypto = require("node:crypto");

const manifest = {
  id: "community.streamisko",
  version: "0.7.0",
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

async function fetchWithTimeout(url, options = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function getSkTorrentCredentials() {
  const uid = String(process.env.SKTORRENT_UID || "").trim();
  const pass = String(process.env.SKTORRENT_PASS || "").trim();
  return uid && pass ? { uid, pass } : null;
}

function getSkTorrentHeaders(accept) {
  const headers = {
    "User-Agent": "Mozilla/5.0 Streamisko/0.7",
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

function getTorBoxApiKey() {
  return String(process.env.TORBOX_API_KEY || "").trim();
}

function getTorBoxHeaders() {
  return {
    Authorization: `Bearer ${getTorBoxApiKey()}`,
    Accept: "application/json",
    "User-Agent": "Streamisko/0.7"
  };
}

async function getTorBoxConnectionStatus() {
  if (!getTorBoxApiKey()) {
    return "TorBox: Not connected ❌ (API key missing)";
  }

  const response = await fetchWithTimeout(
    "https://api.torbox.app/v1/api/user/me?settings=false",
    { headers: getTorBoxHeaders() },
    5000
  );

  if (!response) {
    return "TorBox: Not connected ❌ (API unreachable)";
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (response.ok && body && body.success === true && body.data) {
    return "TorBox: Connected ✅";
  }

  const error = body && body.error ? String(body.error).toUpperCase() : "";
  if (
    response.status === 401 ||
    response.status === 403 ||
    error === "BAD_TOKEN" ||
    error === "NO_AUTH" ||
    error === "AUTH_ERROR"
  ) {
    return "TorBox: Not connected ❌ (invalid API key)";
  }

  return `TorBox: Not connected ❌ (API error ${response.status})`;
}

async function getMovieDetails(imdbId) {
  const fallback = { name: "Unknown movie", year: "Unknown year" };
  if (!/^tt\d+$/.test(imdbId)) return fallback;

  const response = await fetchWithTimeout(
    `https://v3-cinemeta.strem.io/meta/movie/${encodeURIComponent(imdbId)}.json`,
    {},
    5000
  );
  if (!response || !response.ok) return fallback;

  try {
    const data = await response.json();
    const meta = data && data.meta;
    if (!meta) return fallback;

    let year = fallback.year;
    if (meta.releaseInfo) {
      const yearMatch = String(meta.releaseInfo).match(/\d{4}/);
      if (yearMatch) year = yearMatch[0];
    } else if (meta.released) {
      const releasedYear = new Date(meta.released).getUTCFullYear();
      if (Number.isFinite(releasedYear)) year = String(releasedYear);
    }

    return { name: meta.name || fallback.name, year };
  } catch {
    return fallback;
  }
}

async function fetchSkTorrentPage(url) {
  const response = await fetchWithTimeout(
    url,
    { headers: getSkTorrentHeaders("text/html,application/xhtml+xml") },
    6000
  );
  return response && response.ok ? response.text() : null;
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
    .replace(/&#x([a-f0-9]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function htmlToText(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function getTorrentNameFromHref(href, id) {
  try {
    const url = new URL(decodeHtmlEntities(href), "https://sktorrent.eu/torrent/");
    const name = url.searchParams.get("name");
    if (name) return name.replace(/-/g, " ").replace(/\s+/g, " ").trim();
  } catch {
    // Fall through.
  }
  return `SKTorrent ${id.slice(0, 8)}`;
}

function getLastSearchPage(html) {
  let lastPage = 0;
  const pageRegex = /(?:\?|&|&amp;)page=(\d+)/gi;
  for (const match of html.matchAll(pageRegex)) {
    const page = Number(match[1]);
    if (Number.isSafeInteger(page) && page > lastPage) lastPage = page;
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
    if ((!existing[key] || existing[key] === "?") && torrent[key]) existing[key] = torrent[key];
  }
}

function addTorrentResultsFromHtml(html, torrentsById) {
  if (!html) return;

  const anchorRegex = /<a\b[^>]*href=["']([^"']*details\.php\?[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const matches = Array.from(html.matchAll(anchorRegex));

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const href = decodeHtmlEntities(match[1]);
    const idMatch = href.match(/[?&]id=([a-f0-9]{40})/i);
    if (!idMatch) continue;

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
  if (!movie || movie.name === "Unknown movie") return [];

  const searchTerms = [movie.name];
  if (/^\d{4}$/.test(movie.year)) searchTerms.push(movie.year);

  const searchUrl = new URL("https://sktorrent.eu/torrent/torrents_v2.php");
  searchUrl.searchParams.set("search", searchTerms.join(" "));
  searchUrl.searchParams.set("category", "0");
  searchUrl.searchParams.set("zaner", "");
  searchUrl.searchParams.set("jazyk", "");
  searchUrl.searchParams.set("active", "0");

  const firstPageHtml = await fetchSkTorrentPage(searchUrl);
  if (!firstPageHtml) return [];

  const torrentsById = new Map();
  addTorrentResultsFromHtml(firstPageHtml, torrentsById);

  const pages = [];
  for (let page = 1; page <= getLastSearchPage(firstPageHtml); page += 1) pages.push(page);

  const batchSize = 5;
  for (let index = 0; index < pages.length; index += batchSize) {
    const htmlPages = await Promise.all(
      pages.slice(index, index + batchSize).map((page) => {
        const pageUrl = new URL(searchUrl);
        pageUrl.searchParams.set("page", String(page));
        return fetchSkTorrentPage(pageUrl);
      })
    );
    for (const html of htmlPages) addTorrentResultsFromHtml(html, torrentsById);
  }

  return Array.from(torrentsById.values());
}

function contentDispositionFileName(contentDisposition) {
  if (!contentDisposition) return null;
  const utf8Match = contentDisposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (utf8Match) {
    const encoded = utf8Match[1].trim().replace(/^"|"$/g, "");
    try { return decodeURIComponent(encoded); } catch { return encoded; }
  }
  const quotedMatch = contentDisposition.match(/filename\s*=\s*"([^"]+)"/i);
  if (quotedMatch) return quotedMatch[1].trim();
  const plainMatch = contentDisposition.match(/filename\s*=\s*([^;]+)/i);
  return plainMatch ? plainMatch[1].trim().replace(/^"|"$/g, "") : null;
}

function isGenericSkTorrentFileName(fileName) {
  const normalized = String(fileName || "").trim().toLowerCase().replace(/\s+/g, "");
  return new Set(["[skt]", "[skt].torrent", "skt", "skt.torrent", "download", "download.torrent"]).has(normalized);
}

function parseTorrentMetadata(buffer) {
  let offset = 0;
  let infoStart = -1;
  let infoEnd = -1;

  function parseString() {
    const colon = buffer.indexOf(0x3a, offset);
    if (colon === -1) throw new Error("Invalid bencoded string");
    const length = Number(buffer.toString("ascii", offset, colon));
    if (!Number.isSafeInteger(length) || length < 0) throw new Error("Invalid bencoded string length");
    const start = colon + 1;
    const end = start + length;
    if (end > buffer.length) throw new Error("Bencoded string exceeds buffer");
    offset = end;
    return buffer.subarray(start, end);
  }

  function parseValue(isRoot = false) {
    if (offset >= buffer.length) throw new Error("Unexpected end of bencoded data");
    const token = buffer[offset];

    if (token >= 0x30 && token <= 0x39) return parseString();

    if (token === 0x69) {
      offset += 1;
      const end = buffer.indexOf(0x65, offset);
      if (end === -1) throw new Error("Invalid bencoded integer");
      const value = Number(buffer.toString("ascii", offset, end));
      offset = end + 1;
      return value;
    }

    if (token === 0x6c) {
      offset += 1;
      const values = [];
      while (offset < buffer.length && buffer[offset] !== 0x65) values.push(parseValue(false));
      if (buffer[offset] !== 0x65) throw new Error("Unterminated bencoded list");
      offset += 1;
      return values;
    }

    if (token === 0x64) {
      offset += 1;
      const value = Object.create(null);
      while (offset < buffer.length && buffer[offset] !== 0x65) {
        const key = parseString().toString("utf8");
        const valueStart = offset;
        value[key] = parseValue(false);
        const valueEnd = offset;
        if (isRoot && key === "info") {
          infoStart = valueStart;
          infoEnd = valueEnd;
        }
      }
      if (buffer[offset] !== 0x65) throw new Error("Unterminated bencoded dictionary");
      offset += 1;
      return value;
    }

    throw new Error("Unsupported bencoded token");
  }

  try {
    const decoded = parseValue(true);
    const info = decoded && decoded.info;
    const rawName = info && (info["name.utf-8"] || info.name);
    const name = rawName
      ? (Buffer.isBuffer(rawName) ? rawName.toString("utf8") : String(rawName)).replace(/\0/g, "").trim()
      : null;
    const infoHash = infoStart >= 0 && infoEnd > infoStart
      ? crypto.createHash("sha1").update(buffer.subarray(infoStart, infoEnd)).digest("hex")
      : null;
    return { name: name || null, infoHash };
  } catch {
    return { name: null, infoHash: null };
  }
}

function makeTorrentFileName(name) {
  if (!name) return null;
  const safeName = String(name)
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!safeName) return null;
  return /\.torrent$/i.test(safeName) ? safeName : `${safeName}.torrent`;
}

async function fetchTorrentMetadata(id) {
  if (!getSkTorrentCredentials()) return { fileName: null, infoHash: null };

  const response = await fetchWithTimeout(
    `https://sktorrent.eu/torrent/download.php?id=${encodeURIComponent(id)}`,
    {
      redirect: "follow",
      headers: getSkTorrentHeaders("application/x-bittorrent,application/octet-stream,*/*")
    },
    6000
  );

  if (!response || !response.ok) return { fileName: null, infoHash: null };
  if (/text\/html/i.test(response.headers.get("content-type") || "")) return { fileName: null, infoHash: null };

  try {
    const headerName = contentDispositionFileName(response.headers.get("content-disposition") || "");
    const buffer = Buffer.from(await response.arrayBuffer());
    const parsed = parseTorrentMetadata(buffer);
    let fileName = makeTorrentFileName(parsed.name);

    if (!fileName && headerName && !isGenericSkTorrentFileName(headerName)) fileName = headerName;
    if (!fileName) {
      try {
        const lastPart = decodeURIComponent(new URL(response.url).pathname.split("/").pop() || "");
        if (/\.torrent$/i.test(lastPart) && !isGenericSkTorrentFileName(lastPart)) fileName = lastPart;
      } catch {
        // No fallback.
      }
    }

    return { fileName: fileName || null, infoHash: parsed.infoHash || null };
  } catch {
    return { fileName: null, infoHash: null };
  }
}

async function addTorrentMetadata(torrents) {
  if (!getSkTorrentCredentials() || !torrents.length) {
    return torrents.map((torrent) => ({ ...torrent, fileName: null, infoHash: null }));
  }

  const enriched = new Array(torrents.length);
  const batchSize = 8;
  for (let index = 0; index < torrents.length; index += batchSize) {
    const batchResults = await Promise.all(
      torrents.slice(index, index + batchSize).map(async (torrent) => ({
        ...torrent,
        ...(await fetchTorrentMetadata(torrent.id))
      }))
    );
    for (let offset = 0; offset < batchResults.length; offset += 1) enriched[index + offset] = batchResults[offset];
  }
  return enriched;
}

function cachedHashesFromTorBoxPayload(payload) {
  const data = payload && Object.prototype.hasOwnProperty.call(payload, "data") ? payload.data : payload;
  const hashes = new Set();

  if (Array.isArray(data)) {
    for (const entry of data) {
      if (typeof entry === "string") hashes.add(entry.toLowerCase());
      else if (entry && typeof entry === "object") {
        const hash = entry.hash || entry.info_hash;
        if (hash) hashes.add(String(hash).toLowerCase());
      }
    }
    return hashes;
  }

  if (data && typeof data === "object") {
    for (const [responseHash, value] of Object.entries(data)) {
      if (value === null || value === false) continue;
      const hash = String((value && (value.hash || value.info_hash)) || responseHash).toLowerCase();
      if (hash) hashes.add(hash);
    }
  }

  return hashes;
}

async function getTorBoxCacheMap(torrents) {
  const hashes = [...new Set(
    torrents
      .map((torrent) => String(torrent.infoHash || "").toLowerCase())
      .filter((hash) => /^[a-f0-9]{40}$/.test(hash))
  )];
  const result = new Map(hashes.map((hash) => [hash, null]));
  if (!getTorBoxApiKey() || !hashes.length) return result;

  for (let offset = 0; offset < hashes.length; offset += 50) {
    const chunk = hashes.slice(offset, offset + 50);
    const url = new URL("https://api.torbox.app/v1/api/torrents/checkcached");
    url.searchParams.set("hash", chunk.join(","));
    url.searchParams.set("format", "object");
    url.searchParams.set("list_files", "false");

    const response = await fetchWithTimeout(url, { headers: getTorBoxHeaders() }, 6000);
    if (!response || !response.ok) continue;

    let payload = null;
    try { payload = await response.json(); } catch { continue; }
    if (payload && payload.success === false) continue;

    const cachedHashes = cachedHashesFromTorBoxPayload(payload);
    for (const hash of chunk) result.set(hash, cachedHashes.has(hash));
  }

  return result;
}

function torrentToStream(torrent, index) {
  const fileName = torrent.fileName || "Unavailable (torrent metadata could not be read)";
  const cacheStatus = torrent.torBoxCached === true
    ? "Yes ✅"
    : torrent.torBoxCached === false
      ? "No ❌"
      : "Unknown ⚠️";

  return {
    name: `Streamiško • SKTorrent #${index + 1}`,
    description: [
      torrent.title,
      `Torrent file: ${fileName}`,
      `Cached on TorBox: ${cacheStatus}`,
      `Size: ${torrent.size} • Seeders: ${torrent.seeders} • Leechers: ${torrent.leechers}`,
      `Added: ${torrent.added} • SKTorrent ID: ${torrent.id}`
    ].join("\n"),
    externalUrl: `https://sktorrent.eu/torrent/details.php?id=${torrent.id}`
  };
}

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== "GET") return sendJson(res, 405, { error: "Method not allowed" });

  const route = req.query.route;
  if (route === "manifest") return sendJson(res, 200, manifest);

  if (route === "stream") {
    if (req.query.type !== "movie") return sendJson(res, 200, { streams: [] });

    const imdbId = String(req.query.id || "");
    const [movie, torBoxStatus] = await Promise.all([
      getMovieDetails(imdbId),
      getTorBoxConnectionStatus()
    ]);

    const foundTorrents = await findSkTorrentResults(movie);
    const torrentsWithMetadata = await addTorrentMetadata(foundTorrents);
    const torBoxCacheMap = await getTorBoxCacheMap(torrentsWithMetadata);
    const torrents = torrentsWithMetadata.map((torrent) => ({
      ...torrent,
      torBoxCached: torrent.infoHash
        ? torBoxCacheMap.get(torrent.infoHash.toLowerCase()) ?? null
        : null
    }));

    const helloStream = {
      name: "Streamiško",
      description: `Hello Streamiško 👋\n${movie.name} (${movie.year}) • IMDb: ${imdbId || "unknown"}\nFound torrents on sktorrent.eu: ${torrents.length}\n${torBoxStatus}`,
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
    <p>This is the Streamiško Stremio addon.</p>
  </body>
</html>`);
  }

  return sendJson(res, 404, { error: "Not found" });
};