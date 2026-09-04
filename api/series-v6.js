const crypto = require("node:crypto");
const seriesHandler = require("./series-v5");

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
}

function sendText(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
}

function getSkTorrentCredentials() {
  const uid = String(process.env.SKTORRENT_UID || "").trim();
  const pass = String(process.env.SKTORRENT_PASS || "").trim();
  return uid && pass ? { uid, pass } : null;
}

function getSkTorrentHeaders(accept) {
  const headers = {
    "User-Agent": "Mozilla/5.0 Streamisko/1.2-reference-playback",
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
    "User-Agent": "Streamisko/1.2-reference-playback",
    ...extra
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
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

function captureResponse() {
  const headers = new Map();
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const response = {
    statusCode: 200,
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), { name, value });
    },
    getHeader(name) {
      const entry = headers.get(String(name).toLowerCase());
      return entry ? entry.value : undefined;
    },
    end(body = "") {
      resolveDone({
        statusCode: response.statusCode,
        headers: Array.from(headers.values()),
        body: body == null ? "" : String(body)
      });
    }
  };
  return { response, done };
}

function getDescriptionLine(description, prefix) {
  const line = String(description || "").split("\n").find((entry) => entry.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : "";
}

function rewriteStreamPlaybackUrl(stream, baseUrl) {
  if (!stream || !stream.url) return stream;

  let oldUrl;
  try { oldUrl = new URL(stream.url); } catch { return stream; }

  const torrent = oldUrl.searchParams.get("torrent");
  const season = oldUrl.searchParams.get("season");
  const episode = oldUrl.searchParams.get("episode");
  const episodePath = getDescriptionLine(stream.description, "Episode file:");
  const fileName = episodePath.split(/[\\/]/).pop();

  if (!torrent || !season || !episode || !fileName) return stream;

  const playUrl = new URL(`${baseUrl}/api/series-v6`);
  playUrl.searchParams.set("route", "play");
  playUrl.searchParams.set("torrent", torrent);
  playUrl.searchParams.set("season", season);
  playUrl.searchParams.set("episode", episode);
  playUrl.searchParams.set("fileName", fileName);
  return { ...stream, url: playUrl.toString() };
}

function getBaseUrl(req) {
  const protocol = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${protocol}://${host}`;
}

function parseTorrentInfoHash(buffer) {
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
      offset = end + 1;
      return null;
    }

    if (token === 0x6c) {
      offset += 1;
      while (offset < buffer.length && buffer[offset] !== 0x65) parseValue(false);
      if (buffer[offset] !== 0x65) throw new Error("Unterminated bencoded list");
      offset += 1;
      return null;
    }

    if (token === 0x64) {
      offset += 1;
      while (offset < buffer.length && buffer[offset] !== 0x65) {
        const key = parseString().toString("utf8");
        const valueStart = offset;
        parseValue(false);
        const valueEnd = offset;
        if (isRoot && key === "info") {
          infoStart = valueStart;
          infoEnd = valueEnd;
        }
      }
      if (buffer[offset] !== 0x65) throw new Error("Unterminated bencoded dictionary");
      offset += 1;
      return null;
    }

    throw new Error("Unsupported bencoded token");
  }

  try {
    parseValue(true);
    if (infoStart < 0 || infoEnd <= infoStart) return null;
    return crypto.createHash("sha1").update(buffer.subarray(infoStart, infoEnd)).digest("hex");
  } catch {
    return null;
  }
}

async function getTorrentInfoHash(skTorrentId) {
  if (!getSkTorrentCredentials()) throw new Error("SKTorrent credentials are not configured");
  const response = await fetchWithTimeout(
    `https://sktorrent.eu/torrent/download.php?id=${encodeURIComponent(skTorrentId)}`,
    {
      redirect: "follow",
      headers: getSkTorrentHeaders("application/x-bittorrent,application/octet-stream,*/*")
    },
    7000
  );
  if (!response || !response.ok) throw new Error("Could not download SKTorrent metadata");
  if (/text\/html/i.test(response.headers.get("content-type") || "")) {
    throw new Error("SKTorrent returned HTML instead of torrent metadata");
  }
  const hash = parseTorrentInfoHash(Buffer.from(await response.arrayBuffer()));
  if (!hash) throw new Error("Could not read torrent info hash");
  return hash;
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

function torBoxFileName(file) {
  return String((file && (file.name || file.short_name || file.path)) || "");
}

function isVideoFileName(value) {
  return /\.(mkv|mp4|m4v|avi|mov|webm|ts|m2ts|mpg|mpeg)$/i.test(String(value || ""));
}

function normalizeFileName(value) {
  return String(value || "")
    .split(/[\\/]/).pop()
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();
}

function findTorBoxFileByName(files, fileName) {
  const wanted = normalizeFileName(fileName);
  if (!wanted) return null;
  const videos = (Array.isArray(files) ? files : []).filter((file) => isVideoFileName(torBoxFileName(file)));
  return videos.find((file) => {
    const candidate = normalizeFileName(torBoxFileName(file));
    return candidate && (candidate.includes(wanted) || wanted.includes(candidate));
  }) || null;
}

function findTorBoxFileByEpisode(files, season, episode) {
  const videos = (Array.isArray(files) ? files : []).filter((file) => isVideoFileName(torBoxFileName(file)));
  const episodeNumber = Number(episode);
  const episodeText = String(episodeNumber).padStart(2, "0");
  const seasonText = String(Number(season)).padStart(2, "0");
  const regexes = [
    new RegExp(`[\\\\/](?:\\d+\\.\\s*s[eé]rie[\\\\/])?0*${episodeNumber}[\\s._-][^\\\\/]*\\.(?:mp4|mkv|avi|m4v)$`, "i"),
    new RegExp(`\\bS${seasonText}[._-]?E${episodeText}\\b`, "i"),
    new RegExp(`\\b${Number(season)}x${episodeText}\\b`, "i"),
    new RegExp(`\\b${seasonText}x${episodeText}\\b`, "i"),
    new RegExp(`\\b${Number(season)}x0*${episodeNumber}\\b`, "i"),
    new RegExp(`S${seasonText}[._-]?E${episodeText}(?![0-9])`, "i"),
    new RegExp(`Ep(?:isode)?[._\\s]*0*${episodeNumber}\\b`, "i"),
    new RegExp(`\\b0*${episodeNumber}[._\\s-]*(?:Epiz[oó]da|Diel|Časť|Cast)\\b`, "i"),
    new RegExp(`\\bE${episodeText}\\b`, "i"),
    new RegExp(`(?:^|[\\\\/])[\\s._-]*0*${episodeNumber}[\\s._-].*\\.(?:mp4|mkv|avi|m4v)$`, "i")
  ];

  for (const regex of regexes) {
    const found = videos.find((file) => regex.test(torBoxFileName(file)));
    if (found) return found;
  }
  return null;
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
  if (!directUrl || !/^https?:\/\//i.test(directUrl)) {
    throw new Error("TorBox did not return a playable URL");
  }
  return directUrl;
}

async function resolvePlayableTorBoxUrl(skTorrentId, season, episode, fileName) {
  if (!getTorBoxApiKey()) throw new Error("TorBox API key is not configured");
  if (!/^[a-f0-9]{40}$/i.test(skTorrentId)) throw new Error("Invalid SKTorrent id");
  if (!Number.isSafeInteger(season) || !Number.isSafeInteger(episode)) {
    throw new Error("Invalid series episode request");
  }

  const infoHash = await getTorrentInfoHash(skTorrentId);
  const torrent = await ensureTorBoxTorrent(infoHash);
  const files = Array.isArray(torrent.files) ? torrent.files : [];

  let selectedFile = findTorBoxFileByName(files, fileName);
  if (!selectedFile) selectedFile = findTorBoxFileByEpisode(files, season, episode);
  if (!selectedFile || selectedFile.id == null) {
    throw new Error(`TorBox does not contain a matching S${season}E${episode} file`);
  }

  return requestTorBoxDirectLink(torrent.id, selectedFile.id);
}

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  if (req.query.route === "play") {
    const skTorrentId = String(req.query.torrent || "").trim().toLowerCase();
    const season = Number(req.query.season);
    const episode = Number(req.query.episode);
    const fileName = String(req.query.fileName || "").trim();

    if (!Number.isSafeInteger(season) || !Number.isSafeInteger(episode) || !fileName) {
      return sendText(res, 400, "Invalid series playback request");
    }

    try {
      const directUrl = await resolvePlayableTorBoxUrl(skTorrentId, season, episode, fileName);
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

  const { response: capturedRes, done } = captureResponse();
  await seriesHandler(req, capturedRes);
  const captured = await done;

  for (const header of captured.headers) res.setHeader(header.name, header.value);
  res.statusCode = captured.statusCode;
  if (captured.statusCode !== 200) return res.end(captured.body);

  try {
    const body = JSON.parse(captured.body);
    if (body && Array.isArray(body.streams)) {
      const baseUrl = getBaseUrl(req);
      body.streams = body.streams.map((stream) => rewriteStreamPlaybackUrl(stream, baseUrl));
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.end(JSON.stringify(body));
    }
  } catch {
    // Preserve original upstream response if it is not JSON.
  }

  return res.end(captured.body);
};
