const crypto = require("node:crypto");

const SEARCH_BUDGET_MS = 25000;
const MAX_STREAMS = 30;

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
  const timeout = setTimeout(() => controller.abort(), Math.max(250, timeoutMs));
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function timeLeft(deadline, cap = 6000) {
  return Math.max(250, Math.min(cap, deadline - Date.now()));
}

function getSkTorrentCredentials() {
  const uid = String(process.env.SKTORRENT_UID || "").trim();
  const pass = String(process.env.SKTORRENT_PASS || "").trim();
  return uid && pass ? { uid, pass } : null;
}

function getSkTorrentHeaders(accept) {
  const headers = {
    "User-Agent": "Mozilla/5.0 Streamisko/1.1-reference-series",
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
    "User-Agent": "Streamisko/1.1-reference-series",
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
      4000
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
  const match = decodeVideoId(value).match(/^(tt\d+):(\d+):(\d+)$/i);
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

function cleanTitle(value) {
  return String(value || "")
    .replace(/\(.*?\)/g, " ")
    .replace(/TV (Mini )?Series/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function shortTitle(title, words = 3) {
  return String(title || "").split(/\s+/).slice(0, words).join(" ");
}

function normalizeText(value) {
  return stripDiacritics(value)
    .toLowerCase()
    .replace(/[._\-()[\]{}:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueStrings(values) {
  const result = [];
  const seen = new Set();
  for (const raw of values || []) {
    const value = cleanTitle(raw);
    if (!value) continue;
    const key = normalizeText(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function parseYearRange(value) {
  if (!value) return { yearStart: null, yearEnd: null };
  const text = String(value).trim();
  const match = text.match(/^(\d{4})(?:\s*-\s*(\d{4})?)?/);
  if (!match) return { yearStart: null, yearEnd: null };
  return {
    yearStart: match[1] ? Number(match[1]) : null,
    yearEnd: match[2] ? Number(match[2]) : null
  };
}

async function getSeriesDetails(request) {
  const fallback = {
    ...request,
    name: "Unknown series",
    titleOriginal: null,
    titleCz: null,
    titles: [],
    yearStart: null,
    yearEnd: null,
    episodeTitle: null
  };

  const response = await fetchWithTimeout(
    `https://v3-cinemeta.strem.io/meta/series/${encodeURIComponent(request.imdbId)}.json`,
    {},
    5000
  );
  if (!response || !response.ok) return fallback;

  try {
    const payload = await response.json();
    const meta = payload && payload.meta;
    if (!meta) return fallback;

    const titleCz = cleanTitle(meta.name) || null;
    const titleOriginal = cleanTitle(meta.original_name || meta.originalName || meta.original_title) || titleCz;
    const aliases = Array.isArray(meta.aliases) ? meta.aliases : [];
    const titles = uniqueStrings([titleOriginal, titleCz, ...aliases]);

    let yearStart = null;
    let yearEnd = null;
    if (meta.year) ({ yearStart, yearEnd } = parseYearRange(meta.year));
    if (!yearStart && meta.releaseInfo) ({ yearStart, yearEnd } = parseYearRange(meta.releaseInfo));
    if (!yearStart && meta.released) {
      const year = new Date(meta.released).getUTCFullYear();
      if (Number.isFinite(year)) yearStart = year;
    }

    const videos = Array.isArray(meta.videos) ? meta.videos : [];
    const episodeMeta = videos.find((video) => String(video && video.id) === request.videoId);
    const episodeTitle = episodeMeta && (episodeMeta.title || episodeMeta.name)
      ? String(episodeMeta.title || episodeMeta.name)
      : null;

    return {
      ...request,
      name: titleCz || titleOriginal || fallback.name,
      titleOriginal,
      titleCz,
      titles,
      yearStart,
      yearEnd,
      episodeTitle
    };
  } catch {
    return fallback;
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
    .replace(/&#x([a-f0-9]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function htmlToText(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

async function resolveCsfdUrl(series, deadline) {
  if (!series || series.name === "Unknown series" || Date.now() >= deadline) return null;
  const query = series.titleOriginal || series.titleCz || series.name;
  const url = new URL("https://www.csfd.cz/hledat/");
  url.searchParams.set("q", query);

  const response = await fetchWithTimeout(
    url,
    {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "sk,cs;q=0.9,en;q=0.7"
      }
    },
    timeLeft(deadline, 6000)
  );
  if (!response || !response.ok) return null;

  if (response.url && /csfd\.cz\/film\//i.test(response.url)) return response.url;

  let html = "";
  try { html = await response.text(); } catch { return null; }

  const results = [];
  const articleRegex = /<[^>]*class=["'][^"']*article-header[^"']*["'][^>]*>([\s\S]*?)(?=<[^>]*class=["'][^"']*article-header|$)/gi;
  for (const match of html.matchAll(articleRegex)) {
    const article = match[1];
    const linkMatch = article.match(/<a\b[^>]*class=["'][^"']*film-title-name[^"']*["'][^>]*href=["']([^"']+)["']/i)
      || article.match(/<a\b[^>]*href=["']([^"']*\/film\/[^"']*)["'][^>]*class=["'][^"']*film-title-name[^"']*["']/i);
    if (!linkMatch) continue;
    const info = htmlToText(article);
    const yearMatch = info.match(/\b(19|20)\d{2}\b/);
    const year = yearMatch ? Number(yearMatch[0]) : null;
    const isSeries = /seri[aá]l|s[eé]rie/i.test(info);
    let resultUrl = null;
    try { resultUrl = new URL(decodeHtmlEntities(linkMatch[1]), "https://www.csfd.cz").toString(); } catch { continue; }
    results.push({ url: resultUrl, year, isSeries });
  }

  if (!results.length) {
    const fallbackRegex = /<a\b[^>]*href=["']([^"']*\/film\/[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
    for (const match of html.matchAll(fallbackRegex)) {
      const label = htmlToText(match[2]);
      if (!label) continue;
      let resultUrl = null;
      try { resultUrl = new URL(decodeHtmlEntities(match[1]), "https://www.csfd.cz").toString(); } catch { continue; }
      results.push({ url: resultUrl, year: null, isSeries: true, label });
    }
  }

  const seriesResults = results.filter((item) => item.isSeries);
  const candidates = seriesResults.length ? seriesResults : results;
  if (!candidates.length) return null;

  if (series.yearStart) {
    const yearMatch = candidates.find((item) => item.year && Math.abs(item.year - series.yearStart) <= 1);
    if (yearMatch) return yearMatch.url;
  }
  return candidates[0].url;
}

function buildSeriesQueries(series, csfdUrl) {
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

  const season = series.season;
  const episode = series.episode;
  const epTag = ` S${pad2(season)}E${pad2(episode)}`;
  const epTag2 = ` ${season}x${pad2(episode)}`;
  const sTag1 = ` S${pad2(season)}`;
  const sTag2 = ` ${season}.série`;
  const sTag3 = ` ${season}. série`;

  for (const baseTitle of series.titles) {
    const title = cleanTitle(baseTitle);
    const ascii = stripDiacritics(title);
    const short = shortTitle(ascii, 3);

    add(ascii + epTag);
    add(title + epTag);
    add(ascii + sTag3);
    add(short + sTag3);
    add(ascii + sTag2);
    add(short + sTag2);
    add(ascii + sTag1);
    add(short + sTag1);
    add(ascii + epTag2);
    add(short + epTag2);
    add(ascii);
    add(short);
  }

  return queries;
}

async function fetchSkTorrentPage(url, deadline) {
  if (Date.now() >= deadline) return null;
  const response = await fetchWithTimeout(
    url,
    { headers: getSkTorrentHeaders("text/html,application/xhtml+xml") },
    timeLeft(deadline, 6000)
  );
  return response && response.ok ? response.text() : null;
}

function getTorrentNameFromHref(href, id) {
  try {
    const url = new URL(decodeHtmlEntities(href), "https://sktorrent.eu/torrent/");
    const name = url.searchParams.get("name");
    if (name) return name.replace(/-/g, " ").replace(/\s+/g, " ").trim();
  } catch {}
  return `SKTorrent ${id.slice(0, 8)}`;
}

function mergeTorrentResult(target, torrent, query, csfdUrl) {
  const existing = target.get(torrent.id);
  const viaCsfd = Boolean(csfdUrl && query === csfdUrl);
  if (!existing) {
    target.set(torrent.id, { ...torrent, matchedQueries: query ? [query] : [], viaCsfd });
    return;
  }
  for (const key of ["title", "size", "added", "seeders", "leechers", "category"]) {
    if ((!existing[key] || existing[key] === "?") && torrent[key]) existing[key] = torrent[key];
  }
  if (query && !existing.matchedQueries.includes(query)) existing.matchedQueries.push(query);
  if (viaCsfd) existing.viaCsfd = true;
}

function addTorrentResultsFromHtml(html, target, query, csfdUrl) {
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

    const next = matches[index + 1];
    const segmentStart = match.index + match[0].length;
    const segmentEnd = next ? next.index : Math.min(html.length, segmentStart + 2500);
    const segmentText = htmlToText(html.slice(segmentStart, segmentEnd));

    const sizeMatch = segmentText.match(/Velkost\s*:?\s*(.+?)(?=\s*\|\s*Pridany|\s+Pridany\b|$)/i);
    const addedMatch = segmentText.match(/Pridany\s*:?\s*([0-9./-]+)/i);
    const seedersMatch = segmentText.match(/Odosielaju\s*:\s*(\d+)/i);
    const leechersMatch = segmentText.match(/Stahuju\s*:\s*(\d+)/i);
    const categoryMatch = segmentText.match(/\b(Film[^|]*|Seri[aá]l[^|]*|Dokument[^|]*|TV[^|]*)/i);

    const before = target.size;
    mergeTorrentResult(target, {
      id,
      title,
      size: sizeMatch ? sizeMatch[1].trim() : "?",
      added: addedMatch ? addedMatch[1] : "?",
      seeders: seedersMatch ? Number(seedersMatch[1]) : 0,
      leechers: leechersMatch ? Number(leechersMatch[1]) : 0,
      category: categoryMatch ? categoryMatch[1].trim() : "series"
    }, query, csfdUrl);
    if (target.size > before) added += 1;
  }
  return added;
}

async function searchSkTorrent(query, deadline, csfdUrl) {
  if (!query || query.trim().length < 2 || Date.now() >= deadline) return [];
  const maxPages = query.includes("csfd.cz") ? 20 : 1;
  const results = new Map();

  for (let page = 0; page < maxPages && Date.now() < deadline; page += 1) {
    const url = new URL("https://sktorrent.eu/torrent/torrents_v2.php");
    url.searchParams.set("search", query);
    url.searchParams.set("category", "0");
    url.searchParams.set("active", "0");
    url.searchParams.set("order", "data");
    url.searchParams.set("by", "DESC");
    url.searchParams.set("page", String(page));

    const html = await fetchSkTorrentPage(url, deadline);
    if (!html) break;
    const found = addTorrentResultsFromHtml(html, results, query, csfdUrl);
    if (found < 10) break;
  }

  return [...results.values()].sort((a, b) => Number(b.seeders || 0) - Number(a.seeders || 0));
}

function seriesTitleMatches(series, torrentTitle) {
  const candidate = normalizeText(torrentTitle);
  if (!candidate) return false;
  return series.titles.some((title) => {
    const target = normalizeText(title);
    if (!target) return false;
    return candidate === target || candidate.startsWith(`${target} `) || candidate.includes(` ${target} `);
  });
}

function torrentSedisSeriou(name, season) {
  if (
    /S\d{1,2}\s*[-–]\s*S?\d{1,2}/i.test(name) ||
    /Seasons?\s*\d{1,2}\s*[-–]\s*\d{1,2}/i.test(name) ||
    /\b\d{1,2}\.?\s*[-–]\s*\d{1,2}\.?\s*s[eé]rie/i.test(name) ||
    /\bs[eé]ri[ae]\s*\d{1,2}\s*[-–]\s*\d{1,2}\b/i.test(name)
  ) {
    return true;
  }

  const serieMatch = name.match(/\b(\d+)\.\s*s[eé]rie/i);
  if (serieMatch && Number(serieMatch[1]) !== season) return false;

  const seasonMatch = name.match(/\bSeason\s+(\d+)\b/i);
  if (seasonMatch && Number(seasonMatch[1]) !== season) return false;

  const seMatch = name.match(/\bS(\d{1,2})[._-]?E\d{1,3}\b/i);
  if (seMatch && Number(seMatch[1]) !== season) return false;

  const xMatch = name.match(/\b(\d{1,2})x\d{1,3}\b/i);
  if (xMatch && Number(xMatch[1]) !== season) return false;

  const sMatch = name.match(/\bS(\d{2})(?!E)/i);
  if (sMatch && Number(sMatch[1]) !== season) return false;

  return true;
}

function torrentSediSEpizodou(name, season, episode) {
  const range =
    name.match(/\bS(\d{1,2})\s*[-–]\s*S?(\d{1,2})\b/i) ||
    name.match(/\bSeason\s*(\d{1,2})\s*[-–]\s*(\d{1,2})\b/i) ||
    name.match(/\bSeasons\s*(\d{1,2})\s*[-–]\s*(\d{1,2})\b/i) ||
    name.match(/\b(\d{1,2})\.?\s*[-–]\s*(\d{1,2})\.?\s*s[eé]rie\b/i) ||
    name.match(/\bs[eé]ri[ae]\s*(\d{1,2})\s*[-–]\s*(\d{1,2})\b/i);

  if (range) {
    const numbers = range.filter((value) => value !== undefined && /^\d+$/.test(value));
    if (numbers.length >= 2) {
      const a = Number(numbers[0]);
      const b = Number(numbers[1]);
      if (season >= Math.min(a, b) && season <= Math.max(a, b)) return true;
    }
  }

  const seasonText = pad2(season);
  const episodeText = pad2(episode);
  let wrongEpisode = false;

  const sxe = [...name.matchAll(new RegExp(`S${seasonText}[._-]?E(\\d{1,3})\\b`, "gi"))];
  if (sxe.length > 0 && !sxe.some((match) => Number(match[1]) === episode)) wrongEpisode = true;

  const xMatches = [...name.matchAll(new RegExp(`\\b${season}x(\\d{1,3})\\b`, "gi"))];
  if (xMatches.length > 0 && !xMatches.some((match) => Number(match[1]) === episode)) wrongEpisode = true;

  const episodeRange = name.match(/E(\d{1,3})\s*[-–]\s*E?(\d{1,3})\b/i);
  if (episodeRange && episode >= Number(episodeRange[1]) && episode <= Number(episodeRange[2])) {
    wrongEpisode = false;
  }

  if (wrongEpisode) return false;

  if (new RegExp(`S${seasonText}[._-]?E${episodeText}\\b`, "i").test(name)) return true;
  if (new RegExp(`\\b${season}x${episodeText}\\b`, "i").test(name)) return true;
  if (new RegExp(`\\b0*${episode}[._\\s-]*(?:Epiz[oó]da|Diel|Časť|Cast)\\b`, "i").test(name)) return true;

  const explicitRange = name.match(/E(\d{1,3})\s*[-–]\s*E?(\d{1,3})\b/i)
    || name.match(/(?:Dily?|Parts?|Epizody?|Eps?|Ep)[._\s]*(\d{1,3})\s*[-–]\s*(\d{1,3})\b/i);
  if (explicitRange) {
    const start = Number(explicitRange[1] || explicitRange[2]);
    const end = Number(explicitRange[2] || explicitRange[3]);
    if (episode >= start && episode <= end) return true;
  }

  return new RegExp(`\\b${season}\\.\\s*s[eé]rie\\b`, "i").test(name)
    || new RegExp(`\\bs[eé]ri[ae]\\s*${season}\\b`, "i").test(name)
    || new RegExp(`\\bSeason\\s*${season}\\b`, "i").test(name)
    || new RegExp(`\\bS${seasonText}\\b`, "i").test(name)
    || /\b(Pack|Komplet|Complete|Vol|Volume|Part|Časť|Cast|1\.\s*-\s*\d{1,2}\.)\b/i.test(name);
}

function filterSeriesTorrents(torrents, series) {
  return torrents.filter((torrent) => {
    if (!torrent.viaCsfd && !seriesTitleMatches(series, torrent.title)) return false;
    return torrentSedisSeriou(torrent.title, series.season)
      && torrentSediSEpizodou(torrent.title, series.season, series.episode);
  });
}

async function findSeriesTorrents(series, deadline) {
  const csfdUrl = await resolveCsfdUrl(series, deadline);
  const queries = buildSeriesQueries(series, csfdUrl);
  const torrents = new Map();
  let foundViaCsfd = false;
  const tried = [];

  for (let index = 0; index < queries.length && index <= 10 && Date.now() < deadline; index += 1) {
    const query = queries[index];
    tried.push(query);
    const found = await searchSkTorrent(query, deadline, csfdUrl);
    for (const torrent of found) mergeTorrentResult(torrents, torrent, query, csfdUrl);

    if (csfdUrl && query === csfdUrl && found.length > 0) foundViaCsfd = true;
    if (foundViaCsfd) break;
    if (torrents.size >= 30) break;
  }

  return {
    torrents: filterSeriesTorrents([...torrents.values()], series),
    candidateCount: torrents.size,
    csfdUrl,
    queries: tried,
    deadlineHit: Date.now() >= deadline
  };
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

  function asString(value) {
    return Buffer.isBuffer(value) ? value.toString("utf8") : String(value || "");
  }

  function decodePath(parts) {
    return Array.isArray(parts) ? parts.map(asString).filter(Boolean).join("/") : "";
  }

  try {
    const decoded = parseValue(true);
    const info = decoded && decoded.info;
    if (!info) return { name: null, infoHash: null, files: [] };

    const rawName = info["name.utf-8"] || info.name;
    const name = rawName ? asString(rawName).replace(/\0/g, "").trim() : null;
    const infoHash = infoStart >= 0 && infoEnd > infoStart
      ? crypto.createHash("sha1").update(buffer.subarray(infoStart, infoEnd)).digest("hex")
      : null;

    const files = [];
    if (Array.isArray(info.files)) {
      info.files.forEach((file, index) => {
        const relative = decodePath(file && (file["path.utf-8"] || file.path));
        files.push({ index, path: relative || name || "", size: Number(file && file.length) || 0 });
      });
    } else if (name) {
      files.push({ index: 0, path: name, size: Number(info.length) || 0 });
    }

    return { name, infoHash, files };
  } catch {
    return { name: null, infoHash: null, files: [] };
  }
}

function makeTorrentFileName(name) {
  if (!name) return null;
  const safe = String(name)
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!safe) return null;
  return /\.torrent$/i.test(safe) ? safe : `${safe}.torrent`;
}

function isVideoFile(path) {
  return /\.(mp4|mkv|avi|m4v|mov|webm|ts|m2ts|mpg|mpeg)$/i.test(String(path || ""));
}

function chooseEpisodeFile(files, season, episode) {
  const videos = (Array.isArray(files) ? files : [])
    .filter((file) => isVideoFile(file.path))
    .slice()
    .sort((a, b) => String(a.path).localeCompare(String(b.path), undefined, { numeric: true, sensitivity: "base" }));

  if (!videos.length) return null;

  const episodeNumber = Number(episode);
  const episodeText = pad2(episodeNumber);
  const seasonText = pad2(season);

  if (videos.length === 1) {
    const path = videos[0].path;
    const explicit =
      path.match(new RegExp(`S${seasonText}[._-]?E(\\d{1,3})\\b`, "i")) ||
      path.match(new RegExp(`\\b${season}x(\\d{1,3})\\b`, "i")) ||
      path.match(/Ep(?:isode)?[._\s]*(\d{1,3})\b/i) ||
      path.match(/\b(\d{1,3})[._\s]*(?:Epiz[oó]da|Diel|Časť|Cast)\b/i) ||
      path.match(/\bE(\d{1,3})\b/i);
    if (explicit && Number(explicit[1]) !== episodeNumber) return null;
    return videos[0];
  }

  const regexes = [
    new RegExp(`[\\\\/](?:\\d+\\.\\s*s[eé]rie[\\\\/])?0*${episodeNumber}[\\s._-][^\\\\/]*\\.(?:mp4|mkv|avi|m4v)$`, "i"),
    new RegExp(`\\bS${seasonText}[._-]?E${episodeText}\\b`, "i"),
    new RegExp(`\\b${season}x${episodeText}\\b`, "i"),
    new RegExp(`\\b${seasonText}x${episodeText}\\b`, "i"),
    new RegExp(`\\b${season}x0*${episodeNumber}\\b`, "i"),
    new RegExp(`S${seasonText}[._-]?E${episodeText}(?![0-9])`, "i"),
    new RegExp(`Ep(?:isode)?[._\\s]*0*${episodeNumber}\\b`, "i"),
    new RegExp(`\\b0*${episodeNumber}[._\\s-]*(?:Epiz[oó]da|Diel|Časť|Cast)\\b`, "i"),
    new RegExp(`\\bE${episodeText}\\b`, "i"),
    new RegExp(`(?:^|[\\\\/])[\\s._-]*0*${episodeNumber}[\\s._-].*\\.(?:mp4|mkv|avi|m4v)$`, "i")
  ];

  for (const regex of regexes) {
    const found = videos.find((file) => regex.test(file.path));
    if (found) return found;
  }

  return null;
}

async function fetchTorrentMetadata(id, deadline) {
  if (!getSkTorrentCredentials() || Date.now() >= deadline) return { fileName: null, infoHash: null, files: [] };
  const response = await fetchWithTimeout(
    `https://sktorrent.eu/torrent/download.php?id=${encodeURIComponent(id)}`,
    {
      redirect: "follow",
      headers: getSkTorrentHeaders("application/x-bittorrent,application/octet-stream,*/*")
    },
    timeLeft(deadline, 6000)
  );
  if (!response || !response.ok) return { fileName: null, infoHash: null, files: [] };
  if (/text\/html/i.test(response.headers.get("content-type") || "")) return { fileName: null, infoHash: null, files: [] };

  try {
    const headerName = contentDispositionFileName(response.headers.get("content-disposition") || "");
    const buffer = Buffer.from(await response.arrayBuffer());
    const parsed = parseTorrentMetadata(buffer);
    let fileName = makeTorrentFileName(parsed.name);
    if (!fileName && headerName && !isGenericSkTorrentFileName(headerName)) fileName = headerName;
    return { fileName, infoHash: parsed.infoHash, files: parsed.files };
  } catch {
    return { fileName: null, infoHash: null, files: [] };
  }
}

async function enrichWithEpisodeFiles(torrents, series, deadline) {
  const valid = [];
  const batchSize = 5;
  for (let index = 0; index < torrents.length && Date.now() < deadline && valid.length < MAX_STREAMS; index += batchSize) {
    const batch = torrents.slice(index, index + batchSize);
    const results = await Promise.all(batch.map(async (torrent) => {
      const metadata = await fetchTorrentMetadata(torrent.id, deadline);
      if (!metadata.infoHash) return null;
      const episodeFile = chooseEpisodeFile(metadata.files, series.season, series.episode);
      if (!episodeFile) return null;
      return {
        ...torrent,
        fileName: metadata.fileName,
        infoHash: metadata.infoHash,
        fileIdx: episodeFile.index,
        episodeFilePath: episodeFile.path,
        episodeFileSize: episodeFile.size
      };
    }));
    for (const result of results) if (result) valid.push(result);
  }
  return valid;
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

async function getTorBoxCacheMap(torrents, deadline) {
  const hashes = [...new Set(
    torrents
      .map((torrent) => String(torrent.infoHash || "").toLowerCase())
      .filter((hash) => /^[a-f0-9]{40}$/.test(hash))
  )];
  const result = new Map(hashes.map((hash) => [hash, null]));
  if (!getTorBoxApiKey() || !hashes.length || Date.now() >= deadline) return result;

  for (let offset = 0; offset < hashes.length && Date.now() < deadline; offset += 50) {
    const chunk = hashes.slice(offset, offset + 50);
    const url = new URL("https://api.torbox.app/v1/api/torrents/checkcached");
    url.searchParams.set("hash", chunk.join(","));
    url.searchParams.set("format", "object");
    url.searchParams.set("list_files", "false");
    const resultResponse = await parseTorBoxResponse(
      await fetchWithTimeout(url, { headers: getTorBoxHeaders() }, timeLeft(deadline, 4000))
    );
    if (!resultResponse.ok) continue;
    const cached = cachedHashesFromTorBoxPayload(resultResponse.payload);
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
  const wantedBase = String(wantedPath || "").split(/[\\/]/).pop().toLowerCase();
  if (!wantedBase) return null;
  return files.find((file) => torBoxFileName(file).split(/[\\/]/).pop().toLowerCase() === wantedBase) || null;
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

async function resolvePlayableTorBoxUrl(skTorrentId, season, episode, requestedFileIdx) {
  if (!getTorBoxApiKey()) throw new Error("TorBox API key is not configured");
  if (!/^[a-f0-9]{40}$/i.test(skTorrentId)) throw new Error("Invalid SKTorrent id");

  const deadline = Date.now() + 7000;
  const metadata = await fetchTorrentMetadata(skTorrentId, deadline);
  if (!metadata.infoHash) throw new Error("Could not read torrent info hash");
  const episodeFile = chooseEpisodeFile(metadata.files, season, episode);
  if (!episodeFile) throw new Error("Requested episode file is no longer present in torrent metadata");
  if (Number.isInteger(requestedFileIdx) && requestedFileIdx >= 0 && episodeFile.index !== requestedFileIdx) {
    throw new Error("Requested episode file index no longer matches torrent metadata");
  }

  const cacheMap = await getTorBoxCacheMap([{ infoHash: metadata.infoHash }], Date.now() + 3000);
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
    const playUrl = new URL(`${baseUrl}/api/series-v5`);
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
    if (![season, episode, fileIdx].every(Number.isSafeInteger)) {
      return sendText(res, 400, "Invalid series playback request");
    }
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

  const startedAt = Date.now();
  const deadline = startedAt + SEARCH_BUDGET_MS;
  const [series, torBoxStatus] = await Promise.all([
    getSeriesDetails(request),
    getTorBoxConnectionStatus()
  ]);

  if (series.name === "Unknown series" || !series.titles.length) return sendJson(res, 200, { streams: [] });

  const discovery = await findSeriesTorrents(series, deadline);
  const torrentsWithFiles = await enrichWithEpisodeFiles(discovery.torrents, series, deadline);
  const cacheMap = await getTorBoxCacheMap(torrentsWithFiles, Math.max(deadline + 1500, Date.now() + 2500));
  const torrents = torrentsWithFiles.map((torrent) => ({
    ...torrent,
    torBoxCached: torrent.infoHash
      ? cacheMap.get(torrent.infoHash.toLowerCase()) ?? null
      : null
  }));

  const titleLine = series.titleOriginal && series.titleCz && normalizeText(series.titleOriginal) !== normalizeText(series.titleCz)
    ? `${series.titleCz} / ${series.titleOriginal}`
    : (series.titleCz || series.titleOriginal || series.name);
  const yearText = series.yearStart
    ? (series.yearEnd && series.yearEnd !== series.yearStart ? `${series.yearStart}-${series.yearEnd}` : String(series.yearStart))
    : "Unknown year";

  const hello = {
    name: "Streamiško",
    description: [
      "Hello Streamiško 👋",
      `${titleLine} (${yearText}) • ${episodeCode(series.season, series.episode)}${series.episodeTitle ? ` • ${series.episodeTitle}` : ""}`,
      `IMDb: ${series.imdbId} • Video: ${series.videoId}`,
      `Queries tried: ${discovery.queries.length}${discovery.csfdUrl ? " • ČSFD resolved ✅" : " • ČSFD unavailable"}`,
      `SKTorrent candidates: ${discovery.candidateCount} • title/season/episode matches: ${discovery.torrents.length} • exact episode files: ${torrents.length}`,
      `Search time: ${((Date.now() - startedAt) / 1000).toFixed(1)}s${discovery.deadlineHit ? " • budget reached" : ""}`,
      torBoxStatus
    ].join("\n"),
    externalUrl: getBaseUrl(req)
  };

  const baseUrl = getBaseUrl(req);
  return sendJson(res, 200, {
    streams: [hello, ...torrents.map((torrent, index) => torrentToStream(torrent, index, baseUrl, series))]
  });
};
