const crypto = require("node:crypto");

const SEARCH_BUDGET_MS = 12000;
const MAX_VALID_RESULTS = 24;

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

async function fetchWithTimeout(url, options = {}, timeoutMs = 4000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(250, timeoutMs));
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function timeLeft(deadline, cap = 4000) {
  return Math.max(250, Math.min(cap, deadline - Date.now()));
}

function getSkTorrentCredentials() {
  const uid = String(process.env.SKTORRENT_UID || "").trim();
  const pass = String(process.env.SKTORRENT_PASS || "").trim();
  return uid && pass ? { uid, pass } : null;
}

function getSkTorrentHeaders(accept) {
  const headers = {
    "User-Agent": "Mozilla/5.0 Streamisko/1.0.1-series",
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
    "User-Agent": "Streamisko/1.0.1-series",
    ...extra
  };
}

async function parseTorBoxResponse(response) {
  if (!response) return { ok: false, status: 0, payload: null };
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  return { ok: response.ok && (!payload || payload.success !== false), status: response.status, payload };
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
      2500
    )
  );
  if (result.ok && result.payload && result.payload.success === true && result.payload.data) return "TorBox: Connected ✅";
  const error = result.payload && result.payload.error ? String(result.payload.error).toUpperCase() : "";
  if ([401, 403].includes(result.status) || ["BAD_TOKEN", "NO_AUTH", "AUTH_ERROR"].includes(error)) {
    return "TorBox: Not connected ❌ (invalid API key)";
  }
  if (!result.status) return "TorBox: Not connected ❌ (API unreachable)";
  return `TorBox: Not connected ❌ (API error ${result.status})`;
}

function decodeVideoId(value) {
  let raw = String(value || "").trim();
  for (let i = 0; i < 2; i += 1) {
    try {
      const decoded = decodeURIComponent(raw);
      if (decoded === raw) break;
      raw = decoded;
    } catch {
      break;
    }
  }
  return raw;
}

function parseSeriesVideoId(value) {
  const raw = decodeVideoId(value);
  if (!raw.includes(":")) return null;
  const match = raw.match(/^(tt\d+):(\d+):(\d+)$/i);
  if (!match) return null;
  const season = Number(match[2]);
  const episode = Number(match[3]);
  if (!Number.isSafeInteger(season) || !Number.isSafeInteger(episode)) return null;
  return {
    imdbId: match[1].toLowerCase(),
    season,
    episode,
    videoId: `${match[1].toLowerCase()}:${season}:${episode}`
  };
}

function pad2(value) { return String(value).padStart(2, "0"); }
function episodeCode(season, episode) { return `S${pad2(season)}E${pad2(episode)}`; }

function stripDiacritics(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function normalizeText(value) {
  return stripDiacritics(value)
    .toLowerCase()
    .replace(/[_\.]+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = String(value || "").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function shortenedTitle(title) {
  const cleaned = String(title || "")
    .replace(/\s*[\[(].*?[\])]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const pieces = cleaned.split(/\s+(?:-|–|—|:)\s+/);
  return pieces[0] && pieces[0].length >= 4 ? pieces[0].trim() : cleaned;
}

async function getSeriesDetails(request) {
  const fallback = { name: "Unknown series", year: "Unknown year", episodeTitle: null, ...request };
  const response = await fetchWithTimeout(
    `https://v3-cinemeta.strem.io/meta/series/${encodeURIComponent(request.imdbId)}.json`,
    {},
    3500
  );
  if (!response || !response.ok) return fallback;
  try {
    const data = await response.json();
    const meta = data && data.meta;
    if (!meta) return fallback;
    let year = fallback.year;
    if (meta.releaseInfo) {
      const match = String(meta.releaseInfo).match(/\d{4}/);
      if (match) year = match[0];
    } else if (meta.released) {
      const y = new Date(meta.released).getUTCFullYear();
      if (Number.isFinite(y)) year = String(y);
    }
    const videos = Array.isArray(meta.videos) ? meta.videos : [];
    const episodeMeta = videos.find((video) => String(video && video.id) === request.videoId);
    return {
      ...request,
      name: meta.name || fallback.name,
      year,
      episodeTitle: episodeMeta && (episodeMeta.title || episodeMeta.name)
        ? String(episodeMeta.title || episodeMeta.name)
        : null
    };
  } catch {
    return fallback;
  }
}

async function resolveCsfdUrl(series, deadline) {
  if (!series || series.name === "Unknown series" || Date.now() >= deadline) return null;
  const searchUrl = new URL("https://www.csfd.cz/hledat/");
  searchUrl.searchParams.set("q", series.name);
  const response = await fetchWithTimeout(
    searchUrl,
    {
      headers: {
        "User-Agent": "Mozilla/5.0 Streamisko/1.0.1-series",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "cs,sk;q=0.9,en;q=0.5"
      }
    },
    timeLeft(deadline, 1800)
  );
  if (!response || !response.ok) return null;
  let html;
  try { html = await response.text(); } catch { return null; }
  const expected = normalizeText(series.name);
  const candidates = [];
  const regex = /<a\b[^>]*href=["'](\/film\/\d+[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(regex)) {
    const href = match[1].replace(/&amp;/g, "&");
    const label = normalizeText(match[2].replace(/<[^>]+>/g, " "));
    if (!href || !label) continue;
    const score = label === expected ? 100 : label.includes(expected) || expected.includes(label) ? 50 : 0;
    if (score) candidates.push({ href, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  if (!candidates.length) return null;
  try { return new URL(candidates[0].href, "https://www.csfd.cz").toString(); } catch { return null; }
}

async function fetchSkTorrentPage(url, deadline) {
  if (Date.now() >= deadline) return null;
  const response = await fetchWithTimeout(
    url,
    { headers: getSkTorrentHeaders("text/html,application/xhtml+xml") },
    timeLeft(deadline, 3200)
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
  return decodeHtmlEntities(String(value || "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function getTorrentNameFromHref(href, id) {
  try {
    const url = new URL(decodeHtmlEntities(href), "https://sktorrent.eu/torrent/");
    const name = url.searchParams.get("name");
    if (name) return name.replace(/-/g, " ").replace(/\s+/g, " ").trim();
  } catch {}
  return `SKTorrent ${id.slice(0, 8)}`;
}

function getLastSearchPage(html) {
  let lastPage = 0;
  const regex = /(?:\?|&|&amp;)page=(\d+)/gi;
  for (const match of html.matchAll(regex)) {
    const page = Number(match[1]);
    if (Number.isSafeInteger(page) && page > lastPage) lastPage = page;
  }
  return lastPage;
}

function mergeTorrentResult(target, torrent, query, priority = 99) {
  const existing = target.get(torrent.id);
  if (!existing) {
    target.set(torrent.id, { ...torrent, matchedQueries: query ? [query] : [], searchPriority: priority });
    return;
  }
  for (const key of ["title", "size", "added", "seeders", "leechers"]) {
    if ((!existing[key] || existing[key] === "?") && torrent[key]) existing[key] = torrent[key];
  }
  existing.searchPriority = Math.min(existing.searchPriority ?? 99, priority);
  if (query && !existing.matchedQueries.includes(query)) existing.matchedQueries.push(query);
}

function addTorrentResultsFromHtml(html, torrentsById, query, priority) {
  if (!html) return;
  const anchorRegex = /<a\b[^>]*href=["']([^"']*details\.php\?[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const matches = Array.from(html.matchAll(anchorRegex));
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const href = decodeHtmlEntities(match[1]);
    const idMatch = href.match(/[?&]id=([a-f0-9]{40})/i);
    if (!idMatch) continue;
    const id = idMatch[1].toLowerCase();
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
      title: htmlToText(match[2]) || getTorrentNameFromHref(href, id),
      size: sizeMatch ? sizeMatch[1].trim() : "?",
      added: addedMatch ? addedMatch[1] : "?",
      seeders: seedersMatch ? seedersMatch[1] : "?",
      leechers: leechersMatch ? leechersMatch[1] : "?"
    }, query, priority);
  }
}

async function searchSkTorrent(query, deadline, maxPages = 2, priority = 0) {
  if (Date.now() >= deadline) return [];
  const searchUrl = new URL("https://sktorrent.eu/torrent/torrents_v2.php");
  searchUrl.searchParams.set("search", query);
  searchUrl.searchParams.set("category", "0");
  searchUrl.searchParams.set("zaner", "");
  searchUrl.searchParams.set("jazyk", "");
  searchUrl.searchParams.set("active", "0");

  const firstPageHtml = await fetchSkTorrentPage(searchUrl, deadline);
  if (!firstPageHtml) return [];
  const torrentsById = new Map();
  addTorrentResultsFromHtml(firstPageHtml, torrentsById, query, priority);
  const extraPages = Math.min(getLastSearchPage(firstPageHtml), Math.max(0, maxPages - 1));
  if (extraPages > 0 && Date.now() < deadline) {
    const pages = [];
    for (let page = 1; page <= extraPages; page += 1) pages.push(page);
    const htmlPages = await Promise.all(pages.map((page) => {
      const pageUrl = new URL(searchUrl);
      pageUrl.searchParams.set("page", String(page));
      return fetchSkTorrentPage(pageUrl, deadline);
    }));
    for (const html of htmlPages) addTorrentResultsFromHtml(html, torrentsById, query, priority);
  }
  return Array.from(torrentsById.values());
}

function buildQueryTiers(series, csfdUrl) {
  const ascii = stripDiacritics(series.name);
  const short = shortenedTitle(series.name);
  const shortAscii = stripDiacritics(short);
  const titleVariants = uniqueStrings([series.name, ascii, short, shortAscii]).slice(0, 3);
  const exact = episodeCode(series.season, series.episode);
  const xCode = `${series.season}x${pad2(series.episode)}`;
  const seasonCode = `S${pad2(series.season)}`;

  const exactQueries = [];
  if (csfdUrl) exactQueries.push(csfdUrl);
  for (const title of titleVariants) {
    exactQueries.push(`${title} ${exact}`);
    exactQueries.push(`${title} ${xCode}`);
  }

  const seasonQueries = [];
  for (const title of uniqueStrings([series.name, ascii])) {
    seasonQueries.push(`${title} ${series.season}. série`);
    seasonQueries.push(`${title} ${series.season}.série`);
    seasonQueries.push(`${title} ${seasonCode}`);
  }

  return {
    exact: uniqueStrings(exactQueries),
    season: uniqueStrings(seasonQueries),
    broad: uniqueStrings([series.name, ascii, short, shortAscii]).slice(0, 3)
  };
}

function extractRanges(text, patterns) {
  const ranges = [];
  for (const regex of patterns) {
    for (const match of text.matchAll(regex)) {
      const start = Number(match[1]);
      const end = Number(match[2]);
      if (Number.isSafeInteger(start) && Number.isSafeInteger(end)) ranges.push([Math.min(start, end), Math.max(start, end)]);
    }
  }
  return ranges;
}

function titleSeasonDecision(title, wantedSeason) {
  const text = stripDiacritics(String(title || "")).toLowerCase();
  if (/complete\s+(series|seasons?)|complete\s+serie|komplet(n[yi])?\s+(serial|serie)|vsetky\s+serie|vsechny\s+serie/.test(text)) {
    return { ok: true, pack: true };
  }
  const ranges = extractRanges(text, [
    /s\s*0*(\d+)\s*[-–—]\s*s?\s*0*(\d+)/g,
    /seasons?\s*0*(\d+)\s*[-–—]\s*0*(\d+)/g,
    /(\d+)\s*\.\s*[-–—]\s*(\d+)\s*\.??\s*serie/g
  ]);
  if (ranges.some(([start, end]) => wantedSeason >= start && wantedSeason <= end)) return { ok: true, pack: true };
  if (ranges.length) return { ok: false, reason: "SEASON_MISMATCH" };
  const seasons = new Set();
  for (const match of text.matchAll(/\bs\s*0*(\d{1,2})(?=\D|$)/g)) seasons.add(Number(match[1]));
  for (const match of text.matchAll(/\bseason\s*0*(\d{1,2})\b/g)) seasons.add(Number(match[1]));
  for (const match of text.matchAll(/\b(\d{1,2})\s*\.\s*serie\b/g)) seasons.add(Number(match[1]));
  for (const match of text.matchAll(/\b(\d{1,2})x\d{1,3}\b/g)) seasons.add(Number(match[1]));
  if (seasons.size && !seasons.has(wantedSeason)) return { ok: false, reason: "SEASON_MISMATCH" };
  return { ok: true, pack: seasons.has(wantedSeason) && !new RegExp(`s\\s*0*${wantedSeason}\\s*e`, "i").test(text) };
}

function titleEpisodeDecision(title, season, wantedEpisode) {
  const text = stripDiacritics(String(title || "")).toLowerCase();
  const s = String(season);
  const e = String(wantedEpisode);
  const directPatterns = [
    new RegExp(`\\bs\\s*0*${s}\\s*[._ -]?e\\s*0*${e}\\b`, "i"),
    new RegExp(`\\b0*${s}x0*${e}\\b`, "i"),
    new RegExp(`\\be\\s*0*${e}\\b`, "i"),
    new RegExp(`\\b0*${e}\\s*(?:epizoda|diel|dil|cast|episode)\\b`, "i")
  ];
  if (directPatterns.some((regex) => regex.test(text))) return { ok: true, exact: true };
  const ranges = extractRanges(text, [
    /\be\s*0*(\d{1,3})\s*[-–—]\s*e?\s*0*(\d{1,3})\b/g,
    /\bepisodes?\s*0*(\d{1,3})\s*[-–—]\s*0*(\d{1,3})\b/g,
    /\bep(?:izod[ay]?)?\s*0*(\d{1,3})\s*[-–—]\s*0*(\d{1,3})\b/g
  ]);
  if (ranges.some(([start, end]) => wantedEpisode >= start && wantedEpisode <= end)) return { ok: true, pack: true };
  if (ranges.length) return { ok: false, reason: "EPISODE_MISMATCH" };
  const mentioned = new Set();
  for (const match of text.matchAll(/\bs\s*0*\d{1,2}\s*[._ -]?e\s*0*(\d{1,3})\b/g)) mentioned.add(Number(match[1]));
  for (const match of text.matchAll(/\b\d{1,2}x0*(\d{1,3})\b/g)) mentioned.add(Number(match[1]));
  for (const match of text.matchAll(/\be\s*0*(\d{1,3})\b/g)) mentioned.add(Number(match[1]));
  for (const match of text.matchAll(/\b0*(\d{1,3})\s*(?:epizoda|diel|dil|cast|episode)\b/g)) mentioned.add(Number(match[1]));
  if (mentioned.size && !mentioned.has(wantedEpisode)) return { ok: false, reason: "EPISODE_MISMATCH" };
  return { ok: true, pack: true };
}

function titleIsCandidate(torrent, series) {
  const season = titleSeasonDecision(torrent.title, series.season);
  if (!season.ok) return { ok: false, reason: season.reason };
  const episode = titleEpisodeDecision(torrent.title, series.season, series.episode);
  if (!episode.ok) return { ok: false, reason: episode.reason };
  return { ok: true, pack: Boolean(season.pack || episode.pack) };
}

function contentDispositionFileName(value) {
  if (!value) return null;
  const utf8 = value.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (utf8) {
    const encoded = utf8[1].trim().replace(/^"|"$/g, "");
    try { return decodeURIComponent(encoded); } catch { return encoded; }
  }
  const quoted = value.match(/filename\s*=\s*"([^"]+)"/i);
  if (quoted) return quoted[1].trim();
  const plain = value.match(/filename\s*=\s*([^;]+)/i);
  return plain ? plain[1].trim().replace(/^"|"$/g, "") : null;
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
        if (isRoot && key === "info") { infoStart = valueStart; infoEnd = valueEnd; }
      }
      if (buffer[offset] !== 0x65) throw new Error("Unterminated bencoded dictionary");
      offset += 1;
      return value;
    }
    throw new Error("Unsupported bencoded token");
  }
  function decodeString(value) { return Buffer.isBuffer(value) ? value.toString("utf8") : String(value || ""); }
  function decodePath(parts) { return Array.isArray(parts) ? parts.map(decodeString).filter(Boolean).join("/") : ""; }
  try {
    const decoded = parseValue(true);
    const info = decoded && decoded.info;
    if (!info) return { name: null, infoHash: null, files: [] };
    const rawName = info["name.utf-8"] || info.name;
    const name = rawName ? decodeString(rawName).replace(/\0/g, "").trim() : null;
    const infoHash = infoStart >= 0 && infoEnd > infoStart
      ? crypto.createHash("sha1").update(buffer.subarray(infoStart, infoEnd)).digest("hex")
      : null;
    const files = [];
    if (Array.isArray(info.files)) {
      info.files.forEach((file, index) => {
        const relPath = decodePath(file && (file["path.utf-8"] || file.path));
        const path = name && relPath ? `${name}/${relPath}` : relPath || name || "";
        files.push({ index, path, size: Number(file && file.length) || 0 });
      });
    } else if (name) {
      files.push({ index: 0, path: name, size: Number(info.length) || 0 });
    }
    return { name: name || null, infoHash, files };
  } catch {
    return { name: null, infoHash: null, files: [] };
  }
}

function makeTorrentFileName(name) {
  if (!name) return null;
  const safeName = String(name).replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/[. ]+$/g, "").trim();
  if (!safeName) return null;
  return /\.torrent$/i.test(safeName) ? safeName : `${safeName}.torrent`;
}

function videoFile(path) {
  return /\.(mkv|mp4|m4v|avi|mov|webm|ts|m2ts|mpg|mpeg)$/i.test(String(path || ""));
}

function explicitSeasonNumbers(text) {
  const values = new Set();
  const input = stripDiacritics(text).toLowerCase();
  for (const match of input.matchAll(/\bs\s*0*(\d{1,2})(?=\D|$)/g)) values.add(Number(match[1]));
  for (const match of input.matchAll(/\bseason\s*0*(\d{1,2})\b/g)) values.add(Number(match[1]));
  for (const match of input.matchAll(/\b(\d{1,2})x\d{1,3}\b/g)) values.add(Number(match[1]));
  return values;
}

function episodeFileScore(path, season, episode) {
  const text = stripDiacritics(String(path || "")).toLowerCase();
  const s = String(season);
  const e = String(episode);
  const seasons = explicitSeasonNumbers(text);
  if (seasons.size && !seasons.has(season)) return -1;
  if (new RegExp(`(?:^|[^a-z0-9])s0*${s}[ ._\\-]*e0*${e}(?:[^0-9]|$)`, "i").test(text)) return 120;
  if (new RegExp(`(?:^|[^0-9])0*${s}x0*${e}(?:[^0-9]|$)`, "i").test(text)) return 115;
  if (new RegExp(`(?:^|[^0-9])0*${e}\\s*(?:epizoda|diel|dil|cast|episode)(?:[^a-z0-9]|$)`, "i").test(text)) return seasons.has(season) ? 100 : 75;
  if (new RegExp(`(?:episode|epizoda|diel|dil|cast)\\s*0*${e}(?:[^0-9]|$)`, "i").test(text)) return seasons.has(season) ? 95 : 70;
  if (new RegExp(`(?:^|[^a-z0-9])e0*${e}(?:[^0-9]|$)`, "i").test(text)) return seasons.has(season) ? 85 : 0;
  const conflicting = new Set();
  for (const match of text.matchAll(/\bs\s*0*\d{1,2}[ ._\-]*e0*(\d{1,3})\b/g)) conflicting.add(Number(match[1]));
  for (const match of text.matchAll(/\b\d{1,2}x0*(\d{1,3})\b/g)) conflicting.add(Number(match[1]));
  if (conflicting.size && !conflicting.has(episode)) return -1;
  return 0;
}

function findEpisodeFile(files, season, episode) {
  const candidates = (Array.isArray(files) ? files : []).filter((file) => videoFile(file.path));
  let best = null;
  for (const file of candidates) {
    const score = episodeFileScore(file.path, season, episode);
    if (score <= 0) continue;
    if (!best || score > best.score || (score === best.score && file.size > best.file.size)) best = { file, score };
  }
  return best ? best.file : null;
}

async function fetchTorrentMetadata(id, deadline = Date.now() + 5000) {
  if (!getSkTorrentCredentials() || Date.now() >= deadline) return { fileName: null, infoHash: null, files: [] };
  const response = await fetchWithTimeout(
    `https://sktorrent.eu/torrent/download.php?id=${encodeURIComponent(id)}`,
    { redirect: "follow", headers: getSkTorrentHeaders("application/x-bittorrent,application/octet-stream,*/*") },
    timeLeft(deadline, 4200)
  );
  if (!response || !response.ok) return { fileName: null, infoHash: null, files: [] };
  if (/text\/html/i.test(response.headers.get("content-type") || "")) return { fileName: null, infoHash: null, files: [] };
  try {
    const headerName = contentDispositionFileName(response.headers.get("content-disposition") || "");
    const buffer = Buffer.from(await response.arrayBuffer());
    const parsed = parseTorrentMetadata(buffer);
    let fileName = makeTorrentFileName(parsed.name);
    if (!fileName && headerName && !isGenericSkTorrentFileName(headerName)) fileName = headerName;
    return { fileName: fileName || null, infoHash: parsed.infoHash || null, files: parsed.files || [] };
  } catch {
    return { fileName: null, infoHash: null, files: [] };
  }
}

function candidateRank(torrent, series) {
  const decision = titleIsCandidate(torrent, series);
  if (!decision.ok) return null;
  const text = stripDiacritics(torrent.title).toLowerCase();
  const exact = new RegExp(`s\\s*0*${series.season}\\s*[._ -]?e\\s*0*${series.episode}\\b`, "i").test(text)
    || new RegExp(`\\b0*${series.season}x0*${series.episode}\\b`, "i").test(text);
  return { ...torrent, titlePack: decision.pack, localRank: exact ? 0 : decision.pack ? 2 : 1 };
}

async function inspectNewCandidates(merged, inspectedIds, valid, series, deadline) {
  const ranked = [];
  for (const torrent of merged.values()) {
    if (inspectedIds.has(torrent.id)) continue;
    const candidate = candidateRank(torrent, series);
    if (candidate) ranked.push(candidate);
  }
  ranked.sort((a, b) => (a.searchPriority - b.searchPriority) || (a.localRank - b.localRank));
  const limited = ranked.slice(0, Math.max(0, MAX_VALID_RESULTS * 2 - inspectedIds.size));
  for (let offset = 0; offset < limited.length && Date.now() < deadline && valid.length < MAX_VALID_RESULTS; offset += 6) {
    const batch = limited.slice(offset, offset + 6);
    batch.forEach((torrent) => inspectedIds.add(torrent.id));
    const results = await Promise.all(batch.map(async (torrent) => {
      const metadata = await fetchTorrentMetadata(torrent.id, deadline);
      const episodeFile = findEpisodeFile(metadata.files, series.season, series.episode);
      if (!metadata.infoHash || !episodeFile) return null;
      return {
        ...torrent,
        fileName: metadata.fileName,
        infoHash: metadata.infoHash,
        fileIdx: episodeFile.index,
        episodeFilePath: episodeFile.path,
        episodeFileSize: episodeFile.size
      };
    }));
    for (const result of results) {
      if (result && !valid.some((item) => item.id === result.id)) valid.push(result);
    }
  }
}

async function runQueryTier(queries, merged, series, deadline, priority, maxPages) {
  for (let offset = 0; offset < queries.length && Date.now() < deadline; offset += 3) {
    const batch = queries.slice(offset, offset + 3);
    const groups = await Promise.all(batch.map((query) => searchSkTorrent(query, deadline, maxPages, priority)));
    groups.forEach((results, index) => {
      const query = batch[index];
      for (const torrent of results) mergeTorrentResult(merged, torrent, query, priority);
    });
  }
}

async function collectSeriesCandidates(series, deadline) {
  const csfdUrl = await resolveCsfdUrl(series, deadline);
  const tiers = buildQueryTiers(series, csfdUrl);
  const merged = new Map();
  const inspectedIds = new Set();
  const valid = [];
  const triedQueries = [];
  const plans = [
    { queries: tiers.exact, priority: 0, maxPages: 2, stopAt: 8 },
    { queries: tiers.season, priority: 1, maxPages: 2, stopAt: 12 },
    { queries: tiers.broad, priority: 2, maxPages: 1, stopAt: MAX_VALID_RESULTS }
  ];
  for (const plan of plans) {
    if (Date.now() >= deadline || valid.length >= plan.stopAt) break;
    triedQueries.push(...plan.queries);
    await runQueryTier(plan.queries, merged, series, deadline, plan.priority, plan.maxPages);
    await inspectNewCandidates(merged, inspectedIds, valid, series, deadline);
  }
  return {
    torrents: valid,
    queries: uniqueStrings(triedQueries),
    csfdUrl,
    candidateCount: merged.size,
    deadlineHit: Date.now() >= deadline
  };
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

async function getTorBoxCacheMap(torrents, deadline = Date.now() + 4000) {
  const hashes = [...new Set(torrents.map((torrent) => String(torrent.infoHash || "").toLowerCase()).filter((hash) => /^[a-f0-9]{40}$/.test(hash)))];
  const result = new Map(hashes.map((hash) => [hash, null]));
  if (!getTorBoxApiKey() || !hashes.length || Date.now() >= deadline) return result;
  for (let offset = 0; offset < hashes.length && Date.now() < deadline; offset += 50) {
    const chunk = hashes.slice(offset, offset + 50);
    const url = new URL("https://api.torbox.app/v1/api/torrents/checkcached");
    url.searchParams.set("hash", chunk.join(","));
    url.searchParams.set("format", "object");
    url.searchParams.set("list_files", "false");
    const response = await parseTorBoxResponse(await fetchWithTimeout(url, { headers: getTorBoxHeaders() }, timeLeft(deadline, 2200)));
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

function torBoxTorrentHash(item) { return String((item && (item.hash || item.info_hash)) || "").toLowerCase(); }

async function fetchTorBoxTorrentList(id = null) {
  const url = new URL("https://api.torbox.app/v1/api/torrents/mylist");
  url.searchParams.set("bypass_cache", "true");
  if (id != null) url.searchParams.set("id", String(id));
  const result = await parseTorBoxResponse(await fetchWithTimeout(url, { headers: getTorBoxHeaders() }, 7000));
  return result.ok ? torBoxTorrentList(result.payload) : [];
}

async function createCachedTorBoxTorrent(infoHash) {
  const body = new FormData();
  body.append("magnet", `magnet:?xt=urn:btih:${infoHash}`);
  body.append("seed", "1");
  body.append("allow_zip", "false");
  body.append("add_only_if_cached", "true");
  const result = await parseTorBoxResponse(await fetchWithTimeout("https://api.torbox.app/v1/api/torrents/createtorrent", { method: "POST", headers: getTorBoxHeaders(), body }, 10000));
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
    const item = matches.find((entry) => String(entry && entry.id) === String(torrentId) || torBoxTorrentHash(entry) === normalized);
    if (item && Array.isArray(item.files) && item.files.length) return item;
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
  throw new Error("TorBox torrent is not ready for streaming");
}

function torBoxFileName(file) { return String((file && (file.name || file.short_name || file.path)) || ""); }
function chooseTorBoxFile(files, wantedIndex, wantedPath) {
  if (!Array.isArray(files) || !files.length) return null;
  if (Number.isInteger(wantedIndex) && files[wantedIndex]) return files[wantedIndex];
  const wantedBase = String(wantedPath || "").split("/").pop().toLowerCase();
  return wantedBase ? files.find((file) => torBoxFileName(file).split("/").pop().toLowerCase() === wantedBase) || null : null;
}

async function requestTorBoxDirectLink(torrentId, fileId) {
  const url = new URL("https://api.torbox.app/v1/api/torrents/requestdl");
  url.searchParams.set("token", getTorBoxApiKey());
  url.searchParams.set("torrent_id", String(torrentId));
  url.searchParams.set("file_id", String(fileId));
  const result = await parseTorBoxResponse(await fetchWithTimeout(url, { headers: getTorBoxHeaders() }, 9000));
  if (!result.ok) {
    const detail = result.payload && (result.payload.detail || result.payload.error);
    throw new Error(detail || `TorBox link request failed (${result.status || "network"})`);
  }
  const data = unwrapTorBoxPayload(result.payload);
  const directUrl = typeof data === "string" ? data : data && (data.link || data.url);
  if (!directUrl || !/^https?:\/\//i.test(directUrl)) throw new Error("TorBox did not return a playable URL");
  return directUrl;
}

async function resolvePlayableTorBoxUrl(skTorrentId, season, episode, requestedFileIdx) {
  if (!getTorBoxApiKey()) throw new Error("TorBox API key is not configured");
  if (!/^[a-f0-9]{40}$/i.test(skTorrentId)) throw new Error("Invalid SKTorrent id");
  const metadata = await fetchTorrentMetadata(skTorrentId, Date.now() + 6000);
  if (!metadata.infoHash) throw new Error("Could not read torrent info hash");
  const episodeFile = findEpisodeFile(metadata.files, season, episode);
  if (!episodeFile) throw new Error("Requested episode file is no longer present in torrent metadata");
  if (Number.isInteger(requestedFileIdx) && episodeFile.index !== requestedFileIdx) throw new Error("Requested episode file index no longer matches torrent metadata");
  const cacheMap = await getTorBoxCacheMap([{ infoHash: metadata.infoHash }], Date.now() + 3000);
  if (cacheMap.get(metadata.infoHash.toLowerCase()) !== true) throw new Error("Torrent is not currently cached on TorBox");
  const torrent = await ensureTorBoxTorrent(metadata.infoHash);
  const file = chooseTorBoxFile(torrent.files, episodeFile.index, episodeFile.path);
  if (!file || file.id == null) throw new Error("TorBox could not map the requested episode file");
  return requestTorBoxDirectLink(torrent.id, file.id);
}

function torrentToStream(torrent, index, baseUrl, series) {
  const cacheStatus = torrent.torBoxCached === true ? "Yes ✅" : torrent.torBoxCached === false ? "No ❌" : "Unknown ⚠️";
  const stream = {
    name: `Streamiško • SKTorrent #${index + 1}`,
    description: [torrent.title, `Episode: ${episodeCode(series.season, series.episode)}`, `Torrent file: ${torrent.fileName || "Unavailable"}`, `Episode file: ${torrent.episodeFilePath}`, `File index: ${torrent.fileIdx}`, `Cached on TorBox: ${cacheStatus}`, `Size: ${torrent.size} • Seeders: ${torrent.seeders} • Leechers: ${torrent.leechers}`, `Added: ${torrent.added} • SKTorrent ID: ${torrent.id}`].join("\n")
  };
  if (torrent.torBoxCached === true && torrent.infoHash) {
    const playUrl = new URL(`${baseUrl}/api/series-v3`);
    playUrl.searchParams.set("route", "play");
    playUrl.searchParams.set("torrent", torrent.id);
    playUrl.searchParams.set("season", String(series.season));
    playUrl.searchParams.set("episode", String(series.episode));
    playUrl.searchParams.set("fileIdx", String(torrent.fileIdx));
    stream.url = playUrl.toString();
  } else {
    stream.externalUrl = `https://sktorrent.eu/torrent/details.php?id=${torrent.id}`;
  }
  return stream;
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "GET") return sendJson(res, 405, { error: "Method not allowed" });
  const route = req.query.route;
  if (route === "play") {
    const skTorrentId = String(req.query.torrent || "").trim().toLowerCase();
    const season = Number(req.query.season);
    const episode = Number(req.query.episode);
    const fileIdx = Number(req.query.fileIdx);
    if (![season, episode, fileIdx].every(Number.isSafeInteger)) return sendText(res, 400, "Invalid series playback request");
    try {
      const directUrl = await resolvePlayableTorBoxUrl(skTorrentId, season, episode, fileIdx);
      res.statusCode = 302;
      res.setHeader("Location", directUrl);
      res.setHeader("Cache-Control", "no-store");
      return res.end();
    } catch (error) {
      return sendText(res, 502, `Streamiško could not start this TorBox series stream: ${error && error.message ? error.message : "unknown error"}`);
    }
  }
  if (route !== "stream" || req.query.type !== "series") return sendJson(res, 200, { streams: [] });
  const request = parseSeriesVideoId(req.query.id);
  if (!request) return sendJson(res, 200, { streams: [] });
  const startedAt = Date.now();
  const deadline = startedAt + SEARCH_BUDGET_MS;
  const [series, torBoxStatus] = await Promise.all([getSeriesDetails(request), getTorBoxConnectionStatus()]);
  if (series.name === "Unknown series") return sendJson(res, 200, { streams: [] });
  const discovery = await collectSeriesCandidates(series, deadline);
  const cacheDeadline = Math.max(Date.now() + 500, deadline + 1500);
  const cacheMap = await getTorBoxCacheMap(discovery.torrents, cacheDeadline);
  const torrents = discovery.torrents.map((torrent) => ({ ...torrent, torBoxCached: torrent.infoHash ? cacheMap.get(torrent.infoHash.toLowerCase()) ?? null : null }));
  const hello = {
    name: "Streamiško",
    description: ["Hello Streamiško 👋", `${series.name} (${series.year}) • ${episodeCode(series.season, series.episode)}${series.episodeTitle ? ` • ${series.episodeTitle}` : ""}`, `IMDb: ${series.imdbId} • Video: ${series.videoId}`, `Queries tried: ${discovery.queries.length}${discovery.csfdUrl ? " • ČSFD resolved ✅" : " • ČSFD unavailable"}`, `SKTorrent candidates: ${discovery.candidateCount} • Exact episode files: ${torrents.length}`, `Search time: ${((Date.now() - startedAt) / 1000).toFixed(1)}s${discovery.deadlineHit ? " • budget reached" : ""}`, torBoxStatus].join("\n"),
    externalUrl: getBaseUrl(req)
  };
  const baseUrl = getBaseUrl(req);
  return sendJson(res, 200, { streams: [hello, ...torrents.map((torrent, index) => torrentToStream(torrent, index, baseUrl, series))] });
};
