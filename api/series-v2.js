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
    "User-Agent": "Mozilla/5.0 Streamisko/1.0-series",
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
    "User-Agent": "Streamisko/1.0-series",
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
  const error = result.payload && result.payload.error ? String(result.payload.error).toUpperCase() : "";
  if ([401, 403].includes(result.status) || ["BAD_TOKEN", "NO_AUTH", "AUTH_ERROR"].includes(error)) {
    return "TorBox: Not connected ❌ (invalid API key)";
  }
  if (!result.status) return "TorBox: Not connected ❌ (API unreachable)";
  return `TorBox: Not connected ❌ (API error ${result.status})`;
}

function parseSeriesVideoId(videoId) {
  const raw = String(videoId || "").trim();
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

function pad2(value) {
  return String(value).padStart(2, "0");
}

function episodeCode(season, episode) {
  return `S${pad2(season)}E${pad2(episode)}`;
}

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
  if (pieces[0] && pieces[0].length >= 4) return pieces[0].trim();
  return cleaned;
}

async function getSeriesDetails(request) {
  const fallback = {
    name: "Unknown series",
    year: "Unknown year",
    episodeTitle: null,
    ...request
  };
  const response = await fetchWithTimeout(
    `https://v3-cinemeta.strem.io/meta/series/${encodeURIComponent(request.imdbId)}.json`,
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
      const match = String(meta.releaseInfo).match(/\d{4}/);
      if (match) year = match[0];
    } else if (meta.released) {
      const candidate = new Date(meta.released).getUTCFullYear();
      if (Number.isFinite(candidate)) year = String(candidate);
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

async function resolveCsfdUrl(series) {
  if (!series || series.name === "Unknown series") return null;
  const searchUrl = new URL("https://www.csfd.cz/hledat/");
  searchUrl.searchParams.set("q", series.name);
  const response = await fetchWithTimeout(
    searchUrl,
    {
      headers: {
        "User-Agent": "Mozilla/5.0 Streamisko/1.0-series",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "cs,sk;q=0.9,en;q=0.5"
      }
    },
    5000
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
    candidates.push({ href, score: label === expected ? 100 : label.includes(expected) || expected.includes(label) ? 50 : 0 });
  }
  candidates.sort((a, b) => b.score - a.score);
  if (!candidates.length) return null;
  try { return new URL(candidates[0].href, "https://www.csfd.cz").toString(); } catch { return null; }
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

function mergeTorrentResult(target, torrent, query) {
  const existing = target.get(torrent.id);
  if (!existing) {
    target.set(torrent.id, { ...torrent, matchedQueries: query ? [query] : [] });
    return;
  }
  for (const key of ["title", "size", "added", "seeders", "leechers"]) {
    if ((!existing[key] || existing[key] === "?") && torrent[key]) existing[key] = torrent[key];
  }
  if (query && !existing.matchedQueries.includes(query)) existing.matchedQueries.push(query);
}

function addTorrentResultsFromHtml(html, torrentsById, query) {
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
    }, query);
  }
}

async function searchSkTorrent(query) {
  const searchUrl = new URL("https://sktorrent.eu/torrent/torrents_v2.php");
  searchUrl.searchParams.set("search", query);
  searchUrl.searchParams.set("category", "0");
  searchUrl.searchParams.set("zaner", "");
  searchUrl.searchParams.set("jazyk", "");
  searchUrl.searchParams.set("active", "0");

  const firstPageHtml = await fetchSkTorrentPage(searchUrl);
  if (!firstPageHtml) return [];
  const torrentsById = new Map();
  addTorrentResultsFromHtml(firstPageHtml, torrentsById, query);
  const lastPage = Math.min(getLastSearchPage(firstPageHtml), 25);
  const pages = [];
  for (let page = 1; page <= lastPage; page += 1) pages.push(page);
  for (let index = 0; index < pages.length; index += 5) {
    const htmlPages = await Promise.all(
      pages.slice(index, index + 5).map((page) => {
        const pageUrl = new URL(searchUrl);
        pageUrl.searchParams.set("page", String(page));
        return fetchSkTorrentPage(pageUrl);
      })
    );
    for (const html of htmlPages) addTorrentResultsFromHtml(html, torrentsById, query);
  }
  return Array.from(torrentsById.values());
}

function buildSearchQueries(series, csfdUrl) {
  const ascii = stripDiacritics(series.name);
  const short = shortenedTitle(series.name);
  const shortAscii = stripDiacritics(short);
  const titleVariants = uniqueStrings([series.name, ascii, short, shortAscii]).slice(0, 3);
  const exact = episodeCode(series.season, series.episode);
  const xCode = `${series.season}x${pad2(series.episode)}`;
  const seasonCode = `S${pad2(series.season)}`;
  const queries = [];
  if (csfdUrl) queries.push(csfdUrl);
  for (const title of titleVariants) {
    queries.push(`${title} ${exact}`);
    queries.push(`${title} ${xCode}`);
  }
  for (const title of uniqueStrings([series.name, ascii])) {
    queries.push(`${title} ${series.season}. série`);
    queries.push(`${title} ${series.season}.série`);
    queries.push(`${title} ${seasonCode}`);
    queries.push(title);
  }
  return uniqueStrings(queries).slice(0, 16);
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
    new RegExp(`\\b0*${e}\\s*(?:epizoda|epizoda|diel|dil|cast|cast|episode)\\b`, "i")
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

  function decodeString(value) {
    return Buffer.isBuffer(value) ? value.toString("utf8") : String(value || "");
  }

  function decodePath(parts) {
    if (!Array.isArray(parts)) return "";
    return parts.map(decodeString).filter(Boolean).join("/");
  }

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
        const path = decodePath(file && (file["path.utf-8"] || file.path));
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
  const safeName = String(name)
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
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
  const sp = pad2(season);
  const e = String(episode);
  const ep = pad2(episode);
  const seasons = explicitSeasonNumbers(text);
  if (seasons.size && !seasons.has(season)) return -1;

  if (new RegExp(`(?:^|[^a-z0-9])s0*${s}[ ._\\-]*e0*${e}(?:[^0-9]|$)`, "i").test(text)) return 120;
  if (new RegExp(`(?:^|[^0-9])0*${s}x0*${e}(?:[^0-9]|$)`, "i").test(text)) return 115;
  if (new RegExp(`(?:^|[^0-9])${sp}x${ep}(?:[^0-9]|$)`, "i").test(text)) return 110;
  if (new RegExp(`(?:^|[^0-9])0*${e}\\s*(?:epizoda|diel|dil|cast|episode)(?:[^a-z0-9]|$)`, "i").test(text)) return 95;
  if (new RegExp(`(?:episode|epizoda|diel|dil|cast)\\s*0*${e}(?:[^0-9]|$)`, "i").test(text)) return 90;
  if (new RegExp(`(?:^|[^a-z0-9])e0*${e}(?:[^0-9]|$)`, "i").test(text)) return seasons.has(season) || text.includes(`season ${s}`) ? 80 : 55;

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
    if (!best || score > best.score || (score === best.score && file.size > best.file.size)) {
      best = { file, score };
    }
  }
  return best ? best.file : null;
}

async function fetchTorrentMetadata(id) {
  if (!getSkTorrentCredentials()) return { fileName: null, infoHash: null, files: [] };
  const response = await fetchWithTimeout(
    `https://sktorrent.eu/torrent/download.php?id=${encodeURIComponent(id)}`,
    { redirect: "follow", headers: getSkTorrentHeaders("application/x-bittorrent,application/octet-stream,*/*") },
    6500
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

async function collectSeriesCandidates(series) {
  const csfdUrl = await resolveCsfdUrl(series);
  const queries = buildSearchQueries(series, csfdUrl);
  const merged = new Map();

  for (let offset = 0; offset < queries.length; offset += 3) {
    const batch = queries.slice(offset, offset + 3);
    const groups = await Promise.all(batch.map((query) => searchSkTorrent(query)));
    groups.forEach((results, index) => {
      const query = batch[index];
      for (const torrent of results) mergeTorrentResult(merged, torrent, query);
    });
  }

  const titleFiltered = [];
  for (const torrent of merged.values()) {
    const decision = titleIsCandidate(torrent, series);
    if (decision.ok) titleFiltered.push({ ...torrent, titlePack: decision.pack });
  }

  const inspected = new Array(titleFiltered.length);
  for (let offset = 0; offset < titleFiltered.length; offset += 6) {
    const batch = titleFiltered.slice(offset, offset + 6);
    const results = await Promise.all(batch.map(async (torrent) => {
      const metadata = await fetchTorrentMetadata(torrent.id);
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
    for (let i = 0; i < results.length; i += 1) inspected[offset + i] = results[i];
  }

  return {
    torrents: inspected.filter(Boolean),
    queries,
    csfdUrl
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

async function getTorBoxCacheMap(torrents) {
  const hashes = [...new Set(
    torrents.map((torrent) => String(torrent.infoHash || "").toLowerCase()).filter((hash) => /^[a-f0-9]{40}$/.test(hash))
  )];
  const result = new Map(hashes.map((hash) => [hash, null]));
  if (!getTorBoxApiKey() || !hashes.length) return result;
  for (let offset = 0; offset < hashes.length; offset += 50) {
    const chunk = hashes.slice(offset, offset + 50);
    const url = new URL("https://api.torbox.app/v1/api/torrents/checkcached");
    url.searchParams.set("hash", chunk.join(","));
    url.searchParams.set("format", "object");
    url.searchParams.set("list_files", "false");
    const response = await parseTorBoxResponse(await fetchWithTimeout(url, { headers: getTorBoxHeaders() }, 6000));
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
  const result = await parseTorBoxResponse(await fetchWithTimeout(url, { headers: getTorBoxHeaders() }, 8000));
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
    const item = matches.find((entry) => String(entry && entry.id) === String(torrentId) || torBoxTorrentHash(entry) === normalized);
    if (item && Array.isArray(item.files) && item.files.length) return item;
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
  throw new Error("TorBox torrent is not ready for streaming");
}

function torBoxFileName(file) {
  return String((file && (file.name || file.short_name || file.path)) || "");
}

function chooseTorBoxFile(files, wantedIndex, wantedPath) {
  if (!Array.isArray(files) || !files.length) return null;
  if (Number.isInteger(wantedIndex) && files[wantedIndex]) return files[wantedIndex];
  const wantedBase = String(wantedPath || "").split("/").pop().toLowerCase();
  if (wantedBase) {
    const exact = files.find((file) => torBoxFileName(file).split("/").pop().toLowerCase() === wantedBase);
    if (exact) return exact;
  }
  return null;
}

async function requestTorBoxDirectLink(torrentId, fileId) {
  const url = new URL("https://api.torbox.app/v1/api/torrents/requestdl");
  url.searchParams.set("token", getTorBoxApiKey());
  url.searchParams.set("torrent_id", String(torrentId));
  url.searchParams.set("file_id", String(fileId));
  const result = await parseTorBoxResponse(await fetchWithTimeout(url, { headers: getTorBoxHeaders() }, 10000));
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
  const metadata = await fetchTorrentMetadata(skTorrentId);
  if (!metadata.infoHash) throw new Error("Could not read torrent info hash");
  const episodeFile = findEpisodeFile(metadata.files, season, episode);
  if (!episodeFile) throw new Error("Requested episode file is no longer present in torrent metadata");
  if (Number.isInteger(requestedFileIdx) && episodeFile.index !== requestedFileIdx) {
    throw new Error("Requested episode file index no longer matches torrent metadata");
  }
  const cacheMap = await getTorBoxCacheMap([{ infoHash: metadata.infoHash }]);
  if (cacheMap.get(metadata.infoHash.toLowerCase()) !== true) throw new Error("Torrent is not currently cached on TorBox");
  const torrent = await ensureTorBoxTorrent(metadata.infoHash);
  const file = chooseTorBoxFile(torrent.files, episodeFile.index, episodeFile.path);
  if (!file || file.id == null) throw new Error("TorBox could not map the requested episode file");
  return requestTorBoxDirectLink(torrent.id, file.id);
}

function torrentToStream(torrent, index, baseUrl, series) {
  const cacheStatus = torrent.torBoxCached === true
    ? "Yes ✅"
    : torrent.torBoxCached === false
      ? "No ❌"
      : "Unknown ⚠️";
  const stream = {
    name: `Streamiško • SKTorrent #${index + 1}`,
    description: [
      torrent.title,
      `Episode: ${episodeCode(series.season, series.episode)}`,
      `Torrent file: ${torrent.fileName || "Unavailable"}`,
      `Episode file: ${torrent.episodeFilePath}`,
      `File index: ${torrent.fileIdx}`,
      `Cached on TorBox: ${cacheStatus}`,
      `Size: ${torrent.size} • Seeders: ${torrent.seeders} • Leechers: ${torrent.leechers}`,
      `Added: ${torrent.added} • SKTorrent ID: ${torrent.id}`
    ].join("\n")
  };
  if (torrent.torBoxCached === true && torrent.infoHash) {
    const playUrl = new URL(`${baseUrl}/api/series-v2`);
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
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
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
      return sendText(
        res,
        502,
        `Streamiško could not start this TorBox series stream: ${error && error.message ? error.message : "unknown error"}`
      );
    }
  }

  if (route !== "stream" || req.query.type !== "series") return sendJson(res, 200, { streams: [] });
  const request = parseSeriesVideoId(req.query.id);
  if (!request) return sendJson(res, 200, { streams: [] });

  const [series, torBoxStatus] = await Promise.all([
    getSeriesDetails(request),
    getTorBoxConnectionStatus()
  ]);
  const discovery = await collectSeriesCandidates(series);
  const cacheMap = await getTorBoxCacheMap(discovery.torrents);
  const torrents = discovery.torrents.map((torrent) => ({
    ...torrent,
    torBoxCached: torrent.infoHash ? cacheMap.get(torrent.infoHash.toLowerCase()) ?? null : null
  }));

  const hello = {
    name: "Streamiško",
    description: [
      "Hello Streamiško 👋",
      `${series.name} (${series.year}) • ${episodeCode(series.season, series.episode)}${series.episodeTitle ? ` • ${series.episodeTitle}` : ""}`,
      `IMDb: ${series.imdbId} • Video: ${series.videoId}`,
      `Search queries: ${discovery.queries.length}${discovery.csfdUrl ? " • ČSFD resolved ✅" : " • ČSFD unavailable"}`,
      `Matching torrents with exact episode file: ${torrents.length}`,
      torBoxStatus
    ].join("\n"),
    externalUrl: getBaseUrl(req)
  };

  const baseUrl = getBaseUrl(req);
  return sendJson(res, 200, {
    streams: [hello, ...torrents.map((torrent, index) => torrentToStream(torrent, index, baseUrl, series))]
  });
};
