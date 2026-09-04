const crypto = require("node:crypto");

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
    "User-Agent": "Mozilla/5.0 Streamisko/0.9",
    Accept: accept,
    "Accept-Language": "sk,cs;q=0.9,en;q=0.6",
    Referer: "https://sktorrent.eu/"
  };
  const credentials = getSkTorrentCredentials();
  if (credentials) headers.Cookie = `uid=${credentials.uid}; pass=${credentials.pass}`;
  return headers;
}

function getTorBoxApiKey() {
  return String(process.env.TORBOX_API_KEY || "").trim();
}

function getTorBoxHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${getTorBoxApiKey()}`,
    Accept: "application/json",
    "User-Agent": "Streamisko/0.9",
    ...extra
  };
}

async function parseTorBoxResponse(response) {
  if (!response) return { ok: false, status: 0, payload: null };
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  return {
    ok: response.ok && (!payload || payload.success !== false),
    status: response.status,
    payload
  };
}

function unwrapTorBoxPayload(payload) {
  return payload && Object.prototype.hasOwnProperty.call(payload, "data") ? payload.data : payload;
}

async function getTorBoxConnectionStatus() {
  if (!getTorBoxApiKey()) return "TorBox: Not connected ❌ (API key missing)";

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
  if (result.status === 401 || result.status === 403) {
    return "TorBox: Not connected ❌ (invalid API key)";
  }
  if (!result.status) return "TorBox: Not connected ❌ (API unreachable)";
  return `TorBox: Not connected ❌ (API error ${result.status})`;
}

function stripDiacritics(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function normalizeTorrentName(value) {
  return stripDiacritics(value)
    .toLowerCase()
    .replace(/stiahni si/gi, " ")
    .replace(/[._\-()[\]{}:]+/g, " ")
    .replace(/\b(1080p|720p|2160p|4k|hdr|web-?dl|webrip|brrip|bluray|dvdrip|tvrip|uhd|fhd|hevc|x265|x264|h264|h265|cam|cz|sk|en)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanMovieTitle(value) {
  return String(value || "")
    .replace(/\(.*?\)/g, " ")
    .replace(/TV (Mini )?Series/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const cleaned = cleanMovieTitle(value);
    if (!cleaned) continue;
    const key = stripDiacritics(cleaned).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
  }
  return result;
}

function extractYear(meta) {
  const candidates = [meta && meta.year, meta && meta.releaseInfo, meta && meta.released];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const match = String(candidate).match(/\b(19|20)\d{2}\b/);
    if (match) return Number(match[0]);
  }
  return null;
}

async function getMovieDetails(imdbId) {
  const fallback = {
    name: "Unknown movie",
    year: null,
    titleOriginal: null,
    titles: []
  };
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

    const name = cleanMovieTitle(meta.name) || fallback.name;
    const titleOriginal = cleanMovieTitle(meta.original_name || meta.originalName || meta.original_title) || name;
    const aliases = Array.isArray(meta.aliases) ? meta.aliases : [];
    const titles = uniqueStrings([titleOriginal, name, ...aliases]);

    return {
      name,
      year: extractYear(meta),
      titleOriginal,
      titles
    };
  } catch {
    return fallback;
  }
}

function getMovieTarget(movie) {
  for (const raw of movie && Array.isArray(movie.titles) ? movie.titles : []) {
    const normalized = normalizeTorrentName(raw)
      .replace(/\b(19|20)\d{2}\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const match = normalized.match(/^(.*?)(?:\s+(\d+))?$/);
    if (!match) continue;
    const baseTitle = (match[1] || "").trim();
    const sequelNumber = match[2] ? Number(match[2]) : null;
    if (baseTitle) return { baseTitle, sequelNumber };
  }
  return { baseTitle: null, sequelNumber: null };
}

function movieTorrentMatches(torrentName, movie) {
  const name = stripDiacritics(String(torrentName || ""))
    .toLowerCase()
    .replace(/stiahni si/gi, " ")
    .replace(/[._\-()[\]{}:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const targets = (movie && Array.isArray(movie.titles) ? movie.titles : [])
    .map((title) => stripDiacritics(title).toLowerCase().replace(/[._\-()[\]{}:]+/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);

  if (!targets.length) return true;

  let baseTitle = null;
  let sequelNumber = null;
  for (const target of targets) {
    const clean = target.replace(/\b(19|20)\d{2}\b/g, " ").replace(/\s+/g, " ").trim();
    const match = clean.match(/^(.*?)(?:\s+(\d+))?$/);
    if (match && match[1]) {
      baseTitle = match[1].trim();
      sequelNumber = match[2] ? Number(match[2]) : null;
      break;
    }
  }

  if (!baseTitle) return true;

  const escapedBase = escapeRegExp(baseTitle);
  if (!new RegExp(`\\b${escapedBase}\\b`, "i").test(name)) return false;

  const isPack = /\b(komplet|pack|kolekce|kolekcia|collection|saga|trilogy|quadrilogy)\b/i.test(name);
  const rawName = stripDiacritics(String(torrentName || "")).toLowerCase();
  const range = sequelNumber !== null ? rawName.match(/\b(\d{1,2})\s*[-–]\s*(\d{1,2})\b/) : null;

  if (movie && movie.year && !isPack && !range) {
    const years = [...name.matchAll(/\b(19|20)\d{2}\b/g)].map((match) => Number(match[0]));
    if (years.length > 0 && !years.includes(Number(movie.year))) return false;
    if (years.length === 0 && sequelNumber === null) {
      const looksLikeCollection = /\b(komplet|bijak|kolekce|kolekcia|collection|saga|trilogy|desnej)\b/i.test(name);
      if (looksLikeCollection) return false;
    }
  }

  if (sequelNumber !== null) {
    if (isPack) return true;
    if (range) {
      const low = Number(range[1]);
      const high = Number(range[2]);
      if (sequelNumber >= Math.min(low, high) && sequelNumber <= Math.max(low, high)) return true;
    }
    const digits = [...name.matchAll(/\b(\d{1,2})\b/g)].map((match) => Number(match[1]));
    if (digits.includes(sequelNumber)) return true;
    if (sequelNumber === 2 && /\bii\b/i.test(name)) return true;
    return false;
  }

  if (isPack) return false;
  return true;
}

function movieFileMatches(filePath, movie) {
  const name = stripDiacritics(String(filePath || ""))
    .toLowerCase()
    .replace(/[._\-()[\]{}:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const { baseTitle, sequelNumber } = getMovieTarget(movie);
  if (!baseTitle) return false;
  if (!new RegExp(`\\b${escapeRegExp(baseTitle)}\\b`, "i").test(name)) return false;

  if (sequelNumber !== null) {
    const numbers = [...name.matchAll(/\b(\d{1,2})\b/g)].map((match) => Number(match[1]));
    if (numbers.includes(sequelNumber)) return true;
    const romanMap = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
    const romans = [...name.matchAll(/\b(x|ix|viii|vii|vi|v|iv|iii|ii|i)\b/gi)];
    return romans.some((match) => romanMap[match[1].toLowerCase()] === sequelNumber);
  }

  if (movie && movie.year) {
    const years = [...name.matchAll(/\b(19|20)\d{2}\b/g)].map((match) => Number(match[0]));
    if (years.length > 0 && !years.includes(Number(movie.year))) return false;
  }
  return true;
}

async function findCsfdUrl(movie) {
  if (!movie || movie.name === "Unknown movie") return null;

  const searchUrl = new URL("https://www.csfd.cz/hledat/");
  searchUrl.searchParams.set("q", movie.titleOriginal || movie.name);
  const response = await fetchWithTimeout(
    searchUrl,
    {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "sk,cs;q=0.9,en;q=0.7"
      }
    },
    6000
  );
  if (!response || !response.ok) return null;

  if (response.url && /csfd\.cz\/film\//i.test(response.url)) return response.url;

  let html = "";
  try { html = await response.text(); } catch { return null; }

  const results = [];
  const articleRegex = /<[^>]*class=["'][^"']*article-header[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/gi;
  for (const articleMatch of html.matchAll(articleRegex)) {
    const article = articleMatch[1];
    const linkMatch = article.match(/<a\b[^>]*class=["'][^"']*film-title-name[^"']*["'][^>]*href=["']([^"']+)["']/i)
      || article.match(/<a\b[^>]*href=["']([^"']*\/film\/[^"']*)["'][^>]*class=["'][^"']*film-title-name[^"']*["']/i);
    if (!linkMatch) continue;
    const text = htmlToText(article);
    const yearMatch = text.match(/\b(19|20)\d{2}\b/);
    const year = yearMatch ? Number(yearMatch[0]) : null;
    const isSeries = /seri[aá]l|s[eé]rie/i.test(text);
    let url;
    try { url = new URL(decodeHtmlEntities(linkMatch[1]), "https://www.csfd.cz").toString(); } catch { continue; }
    results.push({ url, year, isSeries });
  }

  const movies = results.filter((result) => !result.isSeries);
  const candidates = movies.length ? movies : results;
  if (!candidates.length) return null;

  if (movie.year) {
    const byYear = candidates.find((result) => result.year && Math.abs(result.year - Number(movie.year)) <= 1);
    if (byYear) return byYear.url;
  }
  return candidates[0].url;
}

function buildMovieSearchQueries(movie, csfdUrl) {
  const queries = [];
  const seen = new Set();
  const add = (value) => {
    const query = String(value || "").replace(/\s+/g, " ").trim();
    if (query.length < 2) return;
    const key = query.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    queries.push(query);
  };

  if (csfdUrl) add(csfdUrl);

  for (const title of movie && Array.isArray(movie.titles) ? movie.titles : []) {
    const base = cleanMovieTitle(title);
    const withoutDiacritics = stripDiacritics(base);
    const short = withoutDiacritics.split(/\s+/).slice(0, 3).join(" ");
    const numbered = withoutDiacritics.match(/^(.*?)\s+(\d+)$/);
    if (numbered && numbered[1].trim().length > 2) add(numbered[1].trim());
    add(base);
    add(withoutDiacritics);
    add(short);
  }
  return queries;
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
  if (!html) return 0;

  const anchorRegex = /<a\b([^>]*)href=["']([^"']*details\.php\?[^"']*)["']([^>]*)>([\s\S]*?)<\/a>/gi;
  const matches = Array.from(html.matchAll(anchorRegex));
  let added = 0;

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const href = decodeHtmlEntities(match[2]);
    const idMatch = href.match(/[?&]id=([a-f0-9]{40})/i);
    if (!idMatch) continue;

    const id = idMatch[1].toLowerCase();
    const attrs = `${match[1] || ""} ${match[3] || ""}`;
    const titleAttr = attrs.match(/\btitle=["']([^"']+)["']/i);
    const anchorText = htmlToText(match[4]);
    const title = decodeHtmlEntities(titleAttr ? titleAttr[1] : "") || anchorText || getTorrentNameFromHref(href, id);

    const nextMatch = matches[index + 1];
    const segmentStart = match.index + match[0].length;
    const segmentEnd = nextMatch ? nextMatch.index : Math.min(html.length, segmentStart + 2500);
    const segmentText = htmlToText(html.slice(segmentStart, segmentEnd));

    const sizeMatch = segmentText.match(/Velkost\s*:?\s*(.+?)(?=\s*\|\s*Pridany|\s+Pridany\b|$)/i);
    const addedMatch = segmentText.match(/Pridany\s*:?\s*([0-9./-]+)/i);
    const seedersMatch = segmentText.match(/Odosielaju\s*:\s*(\d+)/i);
    const leechersMatch = segmentText.match(/Stahuju\s*:\s*(\d+)/i);

    const before = torrentsById.size;
    mergeTorrentResult(torrentsById, {
      id,
      title,
      size: sizeMatch ? sizeMatch[1].trim() : "?",
      added: addedMatch ? addedMatch[1] : "?",
      seeders: seedersMatch ? Number(seedersMatch[1]) : 0,
      leechers: leechersMatch ? Number(leechersMatch[1]) : 0
    });
    if (torrentsById.size > before) added += 1;
  }
  return added;
}

async function searchSkTorrent(query, maxPages = 1) {
  const results = new Map();
  const pages = query.includes("csfd.cz") ? 20 : maxPages;

  for (let page = 0; page < pages; page += 1) {
    const searchUrl = new URL("https://sktorrent.eu/torrent/torrents_v2.php");
    searchUrl.searchParams.set("search", query);
    searchUrl.searchParams.set("category", "0");
    searchUrl.searchParams.set("active", "0");
    searchUrl.searchParams.set("order", "data");
    searchUrl.searchParams.set("by", "DESC");
    searchUrl.searchParams.set("page", String(page));

    const html = await fetchSkTorrentPage(searchUrl);
    if (!html) break;
    const foundOnPage = addTorrentResultsFromHtml(html, results);
    if (foundOnPage < 10) break;
  }

  return [...results.values()].sort((a, b) => Number(b.seeders || 0) - Number(a.seeders || 0));
}

async function findSkTorrentResults(movie) {
  if (!movie || movie.name === "Unknown movie") return [];

  const csfdUrl = await findCsfdUrl(movie);
  const queries = buildMovieSearchQueries(movie, csfdUrl);
  const torrentsById = new Map();
  let foundViaCsfd = false;

  for (let index = 0; index < queries.length && index < 11; index += 1) {
    const query = queries[index];
    const results = await searchSkTorrent(query, 1);
    for (const torrent of results) mergeTorrentResult(torrentsById, torrent);

    if (csfdUrl && query === csfdUrl && results.length > 0) foundViaCsfd = true;
    if (foundViaCsfd && index >= 1) break;
    if (!foundViaCsfd && torrentsById.size >= 30) break;
  }

  return [...torrentsById.values()]
    .filter((torrent) => movieTorrentMatches(torrent.title, movie))
    .sort((a, b) => Number(b.seeders || 0) - Number(a.seeders || 0));
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

    const response = await parseTorBoxResponse(
      await fetchWithTimeout(url, { headers: getTorBoxHeaders() }, 6000)
    );
    if (!response.ok) continue;
    const cached = cachedHashesFromTorBoxPayload(response.payload);
    for (const hash of chunk) result.set(hash, cached.has(hash));
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
  const id = data && typeof data === "object" ? (data.torrent_id ?? data.id) : data;
  if (id == null) throw new Error("TorBox did not return a torrent id");
  return id;
}

async function ensureTorBoxTorrent(infoHash) {
  const normalized = String(infoHash || "").toLowerCase();
  const existing = (await fetchTorBoxTorrentList()).find((item) => torBoxTorrentHash(item) === normalized);
  if (existing && Array.isArray(existing.files) && existing.files.length) return existing;

  const torrentId = existing && existing.id != null ? existing.id : await createCachedTorBoxTorrent(normalized);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const matches = await fetchTorBoxTorrentList(torrentId);
    const item = matches.find((entry) =>
      String(entry && entry.id) === String(torrentId) || torBoxTorrentHash(entry) === normalized
    );
    if (item && Array.isArray(item.files) && item.files.length) return item;
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
  throw new Error("TorBox torrent is not ready for streaming");
}

function getTorBoxFileName(file) {
  return String(file && (file.name || file.short_name || file.path || ""));
}

function chooseTorBoxMediaFile(files, movie) {
  if (!Array.isArray(files) || !files.length) return null;

  const videoExtension = /\.(mkv|mp4|m4v|avi|mov|webm|ts|m2ts|mpg|mpeg)$/i;
  const videos = files.filter((file) => videoExtension.test(getTorBoxFileName(file)));
  const candidates = (videos.length ? videos : files)
    .filter(Boolean)
    .slice()
    .sort((a, b) => Number(b.size || b.length || 0) - Number(a.size || a.length || 0));

  const matching = candidates.find((file) => movieFileMatches(getTorBoxFileName(file), movie));
  return matching || candidates[0] || null;
}

async function requestTorBoxDirectLink(torrentId, fileId) {
  const url = new URL("https://api.torbox.app/v1/api/torrents/requestdl");
  url.searchParams.set("token", getTorBoxApiKey());
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
  const directUrl = typeof data === "string" ? data : data && (data.link || data.url);
  if (!directUrl || !/^https?:\/\//i.test(directUrl)) throw new Error("TorBox did not return a playable URL");
  return directUrl;
}

async function resolvePlayableTorBoxUrl(skTorrentId, imdbId) {
  if (!getTorBoxApiKey()) throw new Error("TorBox API key is not configured");
  if (!/^[a-f0-9]{40}$/i.test(skTorrentId)) throw new Error("Invalid SKTorrent id");

  const [metadata, movie] = await Promise.all([
    fetchTorrentMetadata(skTorrentId),
    getMovieDetails(imdbId)
  ]);
  if (!metadata.infoHash) throw new Error("Could not read torrent info hash");

  const cacheMap = await getTorBoxCacheMap([{ infoHash: metadata.infoHash }]);
  if (cacheMap.get(metadata.infoHash.toLowerCase()) !== true) {
    throw new Error("Torrent is not currently cached on TorBox");
  }

  const torrent = await ensureTorBoxTorrent(metadata.infoHash);
  const file = chooseTorBoxMediaFile(torrent.files, movie);
  if (!file || file.id == null) throw new Error("No playable file found in TorBox torrent");
  return requestTorBoxDirectLink(torrent.id, file.id);
}

function torrentToStream(torrent, index, baseUrl, imdbId) {
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
    const playUrl = new URL(`${baseUrl}/api/movie`);
    playUrl.searchParams.set("route", "play");
    playUrl.searchParams.set("torrent", torrent.id);
    playUrl.searchParams.set("imdb", imdbId);
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

  if (route === "play") {
    const skTorrentId = String(req.query.torrent || "").trim().toLowerCase();
    const imdbId = String(req.query.imdb || "").trim();
    try {
      const directUrl = await resolvePlayableTorBoxUrl(skTorrentId, imdbId);
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

    const imdbId = String(req.query.id || "").trim();
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
      description: `Hello Streamiško 👋\n${movie.name} (${movie.year || "Unknown year"}) • IMDb: ${imdbId || "unknown"}\nFound matching torrents on sktorrent.eu: ${torrents.length}\n${torBoxStatus}`,
      externalUrl: getBaseUrl(req)
    };

    const baseUrl = getBaseUrl(req);
    return sendJson(res, 200, {
      streams: [
        helloStream,
        ...torrents.map((torrent, index) => torrentToStream(torrent, index, baseUrl, imdbId))
      ]
    });
  }

  return sendJson(res, 404, { error: "Not found" });
};

module.exports._test = {
  buildMovieSearchQueries,
  movieTorrentMatches,
  movieFileMatches,
  normalizeTorrentName,
  getMovieTarget
};
