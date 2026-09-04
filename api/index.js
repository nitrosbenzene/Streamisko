const crypto = require("node:crypto");

const manifest = {
  id: "community.streamisko",
  version: "0.8.0",
  name: "Streamiško",
  description: "Minimal Streamiško Stremio addon scaffold.",
  resources: ["stream"],
  types: ["movie"],
  catalogs: []
};

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
}

function sendJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function sendText(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
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
    "User-Agent": "Mozilla/5.0 Streamisko/0.8",
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

function getTorBoxHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${getTorBoxApiKey()}`,
    Accept: "application/json",
    "User-Agent": "Streamisko/0.8",
    ...extra
  };
}

async function parseTorBoxResponse(response) {
  if (!response) return { ok: false, status: 0, payload: null };
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return {
    ok: response.ok && (!payload || payload.success !== false),
    status: response.status,
    payload
  };
}

function unwrapTorBoxPayload(payload) {
  return payload && Object.prototype.hasOwnProperty.call(payload, "data")
    ? payload.data
    : payload;
}

async function getTorBoxConnectionStatus() {
  if (!getTorBoxApiKey()) {
    return "TorBox: Not connected ❌ (API key missing)";
  }

  const result = await parseTorBoxResponse(
    await fetchWithTimeout(
      "https://api.torbox.app/v1/api/user/me?settings=false",
      { headers: getTorBoxHeaders() },
      5000
    )
  );

  if (result.ok && result.payload && result.payload.success === true && result.payload.data) {
    return "TorBox: Connected ✅";
  }

  const error = result.payload && result.payload.error
    ? String(result.payload.error).toUpperCase()
    : "";
  if (
    result.status === 401 ||
    result.status === 403 ||
    error === "BAD_TOKEN" ||
    error === "NO_AUTH" ||
    error === "AUTH_ERROR"
  ) {
    return "TorBox: Not connected ❌ (invalid API key)";
  }
  if (!result.status) return "TorBox: Not connected ❌ (API unreachable)";
  return `TorBox: Not connected ❌ (API error ${result.status})`;
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
  if (/text\/html/i.test(response.headers.get("content-type") || "")) {
    return { fileName: null, infoHash: null };
  }

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
    for (let offset = 0; offset < batchResults.length; offset += 1) {
      enriched[index + offset] = batchResults[offset];
    }
  }
  return enriched;
}

function cachedHashesFromTorBoxPayload(payload) {
  const data = unwrapTorBoxPayload(payload);
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

    const torBoxResponse = await parseTorBoxResponse(
      await fetchWithTimeout(url, { headers: getTorBoxHeaders() }, 6000)
    );
    if (!torBoxResponse.ok) continue;

    const cachedHashes = cachedHashesFromTorBoxPayload(torBoxResponse.payload);
    for (const hash of chunk) result.set(hash, cachedHashes.has(hash));
  }

  return result;
}

function torBoxTorrentList(payload) {
  const data = unwrapTorBoxPayload(payload);
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.torrents)) return data.torrents;
  if (data && typeof data === "object" && data.id != null) return [data];
  return [];
}

function torBoxTorrentHash(item) {
  return String((item && (item.hash || item.info_hash)) || "").toLowerCase();
}

async function fetchTorBoxTorrentList(id = null) {
  const url = new URL("https://api.torbox.app/v1/api/torrents/mylist");
  url.searchParams.set("bypass_cache", "true");
  if (id != null) url.searchParams.set("id", String(id));

  const result = await parseTorBoxResponse(
    await fetchWithTimeout(url, { headers: getTorBoxHeaders() }, 8000)
  );
  return result.ok ? torBoxTorrentList(result.payload) : [];
}

async function createCachedTorBoxTorrent(infoHash) {
  const body = new FormData();
  body.append("magnet", `magnet:?xt=urn:btih:${infoHash}`);
  body.append("seed", "1");
  body.append("allow_zip", "false");
  body.append("add_only_if_cached", "true");

  const result = await parseTorBoxResponse(
    await fetchWithTimeout(
      "https://api.torbox.app/v1/api/torrents/createtorrent",
      { method: "POST", headers: getTorBoxHeaders(), body },
      12000
    )
  );

  if (!result.ok) {
    const detail = result.payload && (result.payload.detail || result.payload.error);
    throw new Error(detail || `TorBox create torrent failed (${result.status || "network"})`);
  }

  const data = unwrapTorBoxPayload(result.payload);
  const id = data && typeof data === "object"
    ? (data.torrent_id ?? data.id)
    : data;
  if (id == null) throw new Error("TorBox did not return a torrent id");
  return id;
}

async function ensureTorBoxTorrent(infoHash) {
  const normalized = String(infoHash || "").toLowerCase();
  const existing = (await fetchTorBoxTorrentList()).find(
    (item) => torBoxTorrentHash(item) === normalized
  );
  if (existing && Array.isArray(existing.files) && existing.files.length) return existing;

  const torrentId = existing && existing.id != null
    ? existing.id
    : await createCachedTorBoxTorrent(normalized);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const matches = await fetchTorBoxTorrentList(torrentId);
    const item = matches.find(
      (entry) =>
        String(entry && entry.id) === String(torrentId) ||
        torBoxTorrentHash(entry) === normalized
    );
    if (item && Array.isArray(item.files) && item.files.length) return item;
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }

  throw new Error("TorBox torrent is not ready for streaming");
}

function chooseTorBoxMediaFile(files) {
  if (!Array.isArray(files) || !files.length) return null;

  const videoExtension = /\.(mkv|mp4|m4v|avi|mov|webm|ts|m2ts|mpg|mpeg)$/i;
  const videoFiles = files.filter((file) =>
    videoExtension.test(String(file && (file.name || file.short_name || "")))
  );
  const candidates = videoFiles.length ? videoFiles : files;

  return candidates
    .filter(Boolean)
    .slice()
    .sort((a, b) => Number(b.size || b.length || 0) - Number(a.size || a.length || 0))[0] || null;
}

async function requestTorBoxDirectLink(torrentId, fileId) {
  const apiKey = getTorBoxApiKey();
  const url = new URL("https://api.torbox.app/v1/api/torrents/requestdl");
  url.searchParams.set("token", apiKey);
  url.searchParams.set("torrent_id", String(torrentId));
  url.searchParams.set("file_id", String(fileId));

  const result = await parseTorBoxResponse(
    await fetchWithTimeout(url, { headers: getTorBoxHeaders() }, 10000)
  );
  if (!result.ok) {
    const detail = result.payload && (result.payload.detail || result.payload.error);
    throw new Error(detail || `TorBox link request failed (${result.status || "network"})`);
  }

  const data = unwrapTorBoxPayload(result.payload);
  const directUrl = typeof data === "string"
    ? data
    : data && (data.link || data.url);
  if (!directUrl || !/^https?:\/\//i.test(directUrl)) {
    throw new Error("TorBox did not return a playable URL");
  }
  return directUrl;
}

async function resolvePlayableTorBoxUrl(skTorrentId) {
  if (!getTorBoxApiKey()) throw new Error("TorBox API key is not configured");
  if (!/^[a-f0-9]{40}$/i.test(skTorrentId)) throw new Error("Invalid SKTorrent id");

  const metadata = await fetchTorrentMetadata(skTorrentId);
  if (!metadata.infoHash) throw new Error("Could not read torrent info hash");

  const cacheMap = await getTorBoxCacheMap([{ infoHash: metadata.infoHash }]);
  if (cacheMap.get(metadata.infoHash.toLowerCase()) !== true) {
    throw new Error("Torrent is not currently cached on TorBox");
  }

  const torrent = await ensureTorBoxTorrent(metadata.infoHash);
  const file = chooseTorBoxMediaFile(torrent.files);
  if (!file || file.id == null) throw new Error("No playable file found in TorBox torrent");

  return requestTorBoxDirectLink(torrent.id, file.id);
}

function torrentToStream(torrent, index, baseUrl) {
  const fileName = torrent.fileName || "Unavailable (torrent metadata could not be read)";
  const cacheStatus = torrent.torBoxCached === true
    ? "Yes ✅"
    : torrent.torBoxCached === false
      ? "No ❌"
      : "Unknown ⚠️";

  const stream = {
    name: `Streamiško • SKTorrent #${index + 1}`,
    description: [
      torrent.title,
      `Torrent file: ${fileName}`,
      `Cached on TorBox: ${cacheStatus}`,
      `Size: ${torrent.size} • Seeders: ${torrent.seeders} • Leechers: ${torrent.leechers}`,
      `Added: ${torrent.added} • SKTorrent ID: ${torrent.id}`
    ].join("\n")
  };

  if (torrent.torBoxCached === true && torrent.infoHash) {
    const playUrl = new URL(`${baseUrl}/api/index`);
    playUrl.searchParams.set("route", "play");
    playUrl.searchParams.set("torrent", torrent.id);
    stream.url = playUrl.toString();
  } else {
    stream.externalUrl = `https://sktorrent.eu/torrent/details.php?id=${torrent.id}`;
  }

  return stream;
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

  if (route === "play") {
    const skTorrentId = String(req.query.torrent || "").trim().toLowerCase();
    try {
      const directUrl = await resolvePlayableTorBoxUrl(skTorrentId);
      res.statusCode = 302;
      res.setHeader("Location", directUrl);
      res.setHeader("Cache-Control", "no-store");
      return res.end();
    } catch (error) {
      return sendText(
        res,
        502,
        `Streamiško could not start this TorBox stream: ${error && error.message ? error.message : "unknown error"}`
      );
    }
  }

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

    const baseUrl = getBaseUrl(req);
    return sendJson(res, 200, {
      streams: [
        helloStream,
        ...torrents.map((torrent, index) => torrentToStream(torrent, index, baseUrl))
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
    <p>This is the Streamiško Stremio addon.</p>
  </body>
</html>`);
  }

  return sendJson(res, 404, { error: "Not found" });
};