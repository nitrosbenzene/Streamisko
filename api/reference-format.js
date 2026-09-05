const crypto = require("node:crypto");

const LANG_TO_FLAG = {
  CZ: "🇨🇿", SK: "🇸🇰", EN: "🇬🇧", US: "🇺🇸", DE: "🇩🇪", FR: "🇫🇷",
  IT: "🇮🇹", ES: "🇪🇸", RU: "🇷🇺", PL: "🇵🇱", HU: "🇭🇺", JP: "🇯🇵"
};
const VIDEO_RE = /\.(mp4|mkv|avi|m4v|mov|webm|ts|m2ts|mpg|mpeg)$/i;

function description(stream) {
  return String(stream && stream.description || "");
}

function descriptionLine(text, prefix) {
  const line = String(text || "").split("\n")
    .find((entry) => entry.trim().toLowerCase().startsWith(prefix.toLowerCase()));
  return line ? line.trim().slice(prefix.length).trim() : "";
}

function skTorrentId(stream) {
  const match = description(stream).match(/SKTorrent ID:\s*([a-f0-9]{40})\b/i);
  return match ? match[1].toLowerCase() : null;
}

function cacheState(stream) {
  const text = description(stream);
  if (/Cached on TorBox:\s*Yes\b/i.test(text)) return true;
  if (/Cached on TorBox:\s*No\b/i.test(text)) return false;
  return null;
}

function torrentSizeAndSeeders(stream) {
  const line = description(stream).split("\n").find((entry) => /^Size:\s*/i.test(entry.trim())) || "";
  const size = line.match(/Size:\s*([^•\n]+)/i);
  const seeders = line.match(/Seeders:\s*([^•\n]+)/i);
  return {
    size: size ? size[1].trim() : "?",
    seeders: seeders ? seeders[1].trim() : "N/A"
  };
}

function rawTorrentTitle(stream) {
  return (description(stream).split("\n")[0] || "SKTorrent").trim();
}

function stripDiacritics(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeMovieName(value) {
  return stripDiacritics(value)
    .toLowerCase()
    .replace(/[._\-()[\]{}:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function movieFileMatches(filePath, meta) {
  const name = normalizeMovieName(filePath);
  const targets = [meta.titleOriginal, meta.titleCz].filter(Boolean).map(normalizeMovieName);
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
  if (!baseTitle || !new RegExp(`\\b${escapeRegExp(baseTitle)}\\b`, "i").test(name)) return false;

  if (sequelNumber !== null) {
    const numbers = [...name.matchAll(/\b(\d{1,2})\b/g)].map((match) => Number(match[1]));
    if (numbers.includes(sequelNumber)) return true;
    const romanMap = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
    return [...name.matchAll(/\b(x|ix|viii|vii|vi|v|iv|iii|ii|i)\b/gi)]
      .some((match) => romanMap[match[1].toLowerCase()] === sequelNumber);
  }

  if (meta.yearStart) {
    const years = [...name.matchAll(/\b(19|20)\d{2}\b/g)].map((match) => Number(match[0]));
    if (years.length > 0 && !years.includes(Number(meta.yearStart))) return false;
  }
  return true;
}

function parseYearRange(value) {
  const years = [...String(value || "").matchAll(/\b(19|20)\d{2}\b/g)].map((match) => Number(match[0]));
  if (!years.length) return { yearStart: null, yearEnd: null };
  return { yearStart: years[0], yearEnd: years.length > 1 ? years[years.length - 1] : years[0] };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 4500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function skHeaders(accept) {
  const uid = String(process.env.SKTORRENT_UID || "").trim();
  const pass = String(process.env.SKTORRENT_PASS || "").trim();
  const headers = {
    "User-Agent": "Mozilla/5.0 Streamisko/reference-format",
    Accept: accept,
    "Accept-Language": "sk,cs;q=0.9,en;q=0.6",
    Referer: "https://sktorrent.eu/"
  };
  if (uid && pass) headers.Cookie = `uid=${uid}; pass=${pass}`;
  return headers;
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

async function getReferenceMeta(type, requestId) {
  const imdbId = String(requestId || "").split(":")[0];
  const fallback = { titleOriginal: "", titleCz: "", yearStart: null, yearEnd: null };
  if (!/^tt\d+$/.test(imdbId)) return fallback;

  const response = await fetchWithTimeout(
    `https://v3-cinemeta.strem.io/meta/${type}/${encodeURIComponent(imdbId)}.json`,
    {},
    4500
  );
  if (!response || !response.ok) return fallback;

  try {
    const data = await response.json();
    const m = data && data.meta;
    if (!m) return fallback;
    const titleCz = decodeHtmlEntities(m.name || "").trim();
    const titleOriginal = decodeHtmlEntities(m.original_name || m.originalName || m.original_title || titleCz).trim();
    const range = parseYearRange(m.year || m.releaseInfo || m.released || "");
    return { titleOriginal: titleOriginal || titleCz, titleCz, ...range };
  } catch {
    return fallback;
  }
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

  try {
    const decoded = parseValue(true);
    const info = decoded && decoded.info;
    if (!info) return { infoHash: null, files: [] };
    const rootName = asString(info["name.utf-8"] || info.name).replace(/\0/g, "").trim();
    const files = [];
    if (Array.isArray(info.files)) {
      info.files.forEach((file, index) => {
        const parts = file && (file["path.utf-8"] || file.path);
        const path = Array.isArray(parts) ? parts.map(asString).filter(Boolean).join("/") : rootName;
        files.push({ index, path, length: Number(file && file.length) || 0 });
      });
    } else if (rootName) {
      files.push({ index: 0, path: rootName, length: Number(info.length) || 0 });
    }
    const infoHash = infoStart >= 0 && infoEnd > infoStart
      ? crypto.createHash("sha1").update(buffer.subarray(infoStart, infoEnd)).digest("hex")
      : null;
    return { infoHash, files };
  } catch {
    return { infoHash: null, files: [] };
  }
}

async function getTorrentFiles(id) {
  if (!id) return [];
  const response = await fetchWithTimeout(
    `https://sktorrent.eu/torrent/download.php?id=${encodeURIComponent(id)}`,
    { redirect: "follow", headers: skHeaders("application/x-bittorrent,application/octet-stream,*/*") },
    5000
  );
  if (!response || !response.ok || /text\/html/i.test(response.headers.get("content-type") || "")) return [];
  try {
    return parseTorrentMetadata(Buffer.from(await response.arrayBuffer())).files;
  } catch {
    return [];
  }
}

async function getTorrentCategory(id, type) {
  if (!id) return type === "series" ? "Seriály" : "Filmy";
  const response = await fetchWithTimeout(
    `https://sktorrent.eu/torrent/details.php?id=${encodeURIComponent(id)}`,
    { redirect: "follow", headers: skHeaders("text/html,application/xhtml+xml") },
    4000
  );
  if (response && response.ok) {
    try {
      const html = await response.text();
      for (const match of html.matchAll(/<b\b[^>]*>([\s\S]*?)<\/b>/gi)) {
        const text = htmlToText(match[1]);
        const normalized = stripDiacritics(text).toLowerCase();
        if (normalized.includes("film") || normalized.includes("serial") || normalized.includes("dokum") || /\btv\b/i.test(text)) {
          return text;
        }
      }
      const labelMatch = htmlToText(html).match(/(?:Kateg[oó]ria|Category)\s*:?\s*([^|]{2,80})/i);
      if (labelMatch) return labelMatch[1].trim();
    } catch {
      // Fall back below.
    }
  }
  return type === "series" ? "Seriály" : "Filmy";
}

function selectReferenceFile(files, type, meta, stream, requestId) {
  const all = Array.isArray(files) ? files : [];
  if (!all.length) return null;

  if (type === "series") {
    const wantedPath = descriptionLine(description(stream), "Episode file:");
    const wantedBase = wantedPath.split(/[\\/]/).pop().toLowerCase();
    if (wantedPath) {
      const exact = all.find((file) => String(file.path || "").toLowerCase() === wantedPath.toLowerCase());
      if (exact) return exact;
      const byBase = all.find((file) => String(file.path || "").split(/[\\/]/).pop().toLowerCase() === wantedBase);
      if (byBase) return byBase;
    }

    const [, seasonRaw, episodeRaw] = String(requestId || "").split(":");
    const season = Number(seasonRaw);
    const episode = Number(episodeRaw);
    const seasonText = String(season).padStart(2, "0");
    const episodeText = String(episode).padStart(2, "0");
    const videos = all.filter((file) => VIDEO_RE.test(file.path));
    const regexes = [
      new RegExp(`\\bS${seasonText}[._-]?E${episodeText}\\b`, "i"),
      new RegExp(`\\b${season}x${episodeText}\\b`, "i"),
      new RegExp(`Ep(?:isode)?[._\\s]*0*${episode}\\b`, "i"),
      new RegExp(`\\b0*${episode}[._\\s-]*(?:Epiz[oó]da|Diel|Časť|Cast)\\b`, "i"),
      new RegExp(`\\bE${episodeText}\\b`, "i")
    ];
    for (const regex of regexes) {
      const found = videos.find((file) => regex.test(file.path));
      if (found) return found;
    }
    return null;
  }

  const videos = all.filter((file) => VIDEO_RE.test(file.path)).sort((a, b) => (b.length || 0) - (a.length || 0));
  if (videos.length) {
    const matching = videos.find((file) => movieFileMatches(file.path, meta));
    return matching || videos[0];
  }
  return [...all].sort((a, b) => (b.length || 0) - (a.length || 0))[0] || null;
}

function cleanTorrentName(rawName, category) {
  let clean = String(rawName || "").replace(/^Stiahni si\s*/i, "").trim();
  const cat = String(category || "").trim();
  if (cat && clean.toLowerCase().startsWith(cat.toLowerCase())) clean = clean.slice(cat.length).trim();
  return clean;
}

function qualityParts(cleanName) {
  const text = String(cleanName || "").toLowerCase();
  const qualities = [];
  if (text.includes("2160p") || text.includes("4k") || text.includes("uhd")) qualities.push("4K");
  else if (text.includes("1080p") || text.includes("fhd")) qualities.push("1080p");
  else if (text.includes("720p") || text.includes("hd")) qualities.push("720p");
  else if (text.includes("480p")) qualities.push("480p");
  if (text.includes("hdr")) qualities.push("HDR");
  if (text.includes("dovi") || text.includes("vision")) qualities.push("Dolby Vision");
  if (text.includes("hevc") || text.includes("h265") || text.includes("h.265") || text.includes("x265")) qualities.push("HEVC");
  else if (text.includes("x264") || text.includes("h264") || text.includes("h.264") || text.includes("avc")) qualities.push("H.264");
  if (text.includes("atmos")) qualities.push("Atmos");
  return qualities;
}

function languageText(cleanName) {
  const matches = String(cleanName || "").match(/\b(CZ|SK|EN)\b/ig) || [];
  const flags = matches.map((code) => LANG_TO_FLAG[code.toUpperCase()]).filter(Boolean);
  const unique = [...new Set(flags)];
  if (unique.length) return unique.join(" / ");
  if (matches.length) return [...new Set(matches.map((code) => code.toUpperCase()))].join(" / ");
  return "Neznámy jazyk";
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let index = 0;
  let value = bytes;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index >= 2 ? 2 : 0)} ${units[index]}`;
}

function titleLine(meta) {
  const original = meta.titleOriginal ? `${meta.titleOriginal}` : "";
  const cz = meta.titleCz ? `${meta.titleCz}` : "";
  const line = cz !== "" && original !== "" ? `${cz} / ${original}` : (cz !== "" ? cz : original);
  if (!line) return "";
  const year = meta.yearStart
    ? (meta.yearEnd && meta.yearStart !== meta.yearEnd ? `${meta.yearStart}-${meta.yearEnd}` : `${meta.yearStart}`)
    : "N/A";
  return `${line} ${year !== "N/A" ? `(${year})` : ""}`;
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function formatOne(stream, type, requestId, meta) {
  const id = skTorrentId(stream);
  const [files, category] = await Promise.all([
    getTorrentFiles(id),
    getTorrentCategory(id, type)
  ]);
  const selectedFile = selectReferenceFile(files, type, meta, stream, requestId);
  const listing = torrentSizeAndSeeders(stream);
  const cleanName = cleanTorrentName(rawTorrentTitle(stream), category);
  const qualities = qualityParts(cleanName);
  const rows = [];

  const firstLine = titleLine(meta);
  if (firstLine) rows.push(firstLine);

  if (type === "series") {
    const [, seasonRaw, episodeRaw] = String(requestId || "").split(":");
    if (seasonRaw !== undefined && episodeRaw !== undefined) rows.push(`📺 Séria ${Number(seasonRaw)} • Epizóda ${Number(episodeRaw)}`);
  }

  const quality = qualities.length ? `🎥 ${qualities.join(" • ")}` : "🎥 Kvalita neznáma";
  rows.push(`🔊 ${languageText(cleanName)}   |   ${quality}`);
  rows.push(`💿 ${formatBytes(selectedFile ? selectedFile.length : 0)} (🧩 ${listing.size})   |   👥 Seeders: ${listing.seeders}`);

  if (selectedFile && selectedFile.path) {
    const baseName = String(selectedFile.path).split(/[\\/]/).pop();
    rows.push(`📄 Súbor: ${baseName}`);
  }
  rows.push(`🗂️ Torrent: ${cleanName}`);

  const torboxEnabled = Boolean(String(process.env.TORBOX_API_KEY || "").trim());
  const cached = cacheState(stream) === true;
  const categoryUpper = String(category || "").toUpperCase();
  const name = torboxEnabled
    ? (cached ? `[TB ⚡] SKT\n${categoryUpper}` : `[TB ⏳] SKT\n${categoryUpper}`)
    : `SKT\n${categoryUpper}`;

  const { description: _legacyDescription, ...rest } = stream;
  const formatted = {
    ...rest,
    name,
    title: rows.join("\n"),
    behaviorHints: {
      ...(stream.behaviorHints || {}),
      bingeGroup: `sktorrent-${qualities.length > 0 ? qualities.join("-").replace(/\s/g, "") : "standard"}`
    }
  };
  if (torboxEnabled) formatted.type = type;
  return formatted;
}

function qualityRank(text = "") {
  const value = String(text).toLowerCase();
  if (value.includes("2160p") || value.includes("4k") || value.includes("uhd")) return 4;
  if (value.includes("1080p") || value.includes("fhd")) return 3;
  if (value.includes("720p") || /\bhd\b/.test(value)) return 2;
  if (value.includes("480p")) return 1;
  return 0;
}

function sizeBytes(text = "") {
  const match = String(text).match(/(\d+(?:[.,]\d+)?)\s*(tb|gb|mb|kb)\b/i);
  if (!match) return 0;
  const value = parseFloat(match[1].replace(",", "."));
  const unit = match[2].toLowerCase();
  if (unit === "tb") return value * 1024 * 1024 * 1024 * 1024;
  if (unit === "gb") return value * 1024 * 1024 * 1024;
  if (unit === "mb") return value * 1024 * 1024;
  if (unit === "kb") return value * 1024;
  return 0;
}

function sortLikeReference(streams) {
  if (!String(process.env.TORBOX_API_KEY || "").trim()) return streams;
  return [...streams].sort((a, b) => {
    const cachedA = String(a.name || "").includes("⚡") ? 1 : 0;
    const cachedB = String(b.name || "").includes("⚡") ? 1 : 0;
    if (cachedB !== cachedA) return cachedB - cachedA;

    const qualityA = qualityRank(`${a.name || ""} ${a.title || ""}`);
    const qualityB = qualityRank(`${b.name || ""} ${b.title || ""}`);
    if (qualityB !== qualityA) return qualityB - qualityA;

    return sizeBytes(b.title || "") - sizeBytes(a.title || "");
  });
}

async function formatStreamsLikeReference(streams, type, requestId) {
  const meta = await getReferenceMeta(type, requestId);
  const formatted = await mapLimit(Array.isArray(streams) ? streams : [], 6,
    (stream) => formatOne(stream, type, requestId, meta));
  return sortLikeReference(formatted);
}

module.exports = { formatStreamsLikeReference };
