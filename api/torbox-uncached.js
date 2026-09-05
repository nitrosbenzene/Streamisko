const DOWNLOADING_VIDEO_BASE64 = "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAQubW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAC7gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAA1l0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAC7gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAoAAAAFoAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAu4AAAIAAABAAAAAALRbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAoAAAAeABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAACfG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAjxzdGJsAAAAxHN0c2QAAAAAAAAAAQAAALRhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAoABaABIAAAASAAAAAAAAAABFUxhdmM2MS4xOS4xMDEgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAAOmF2Y0MBZAAf/+EAHGdkAB+scgRAoC/5cBEAAAMAAQAAAwAUDxgxhGABAAdo6EODEsiw/fj4AAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAACl9AAAAAAAAABhzdHRzAAAAAAAAAAEAAAAeAAAEAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAiGN0dHMAAAAAAAAADwAAAAEAAAgAAAAAAQAAKAAAAAABAAAQAAAAAAMAAAAAAAAABAAABAAAAAABAAAoAAAAAAEAABAAAAAAAwAAAAAAAAAEAAAEAAAAAAEAACgAAAAAAQAAEAAAAAADAAAAAAAAAAQAAAQAAAAAAQAADAAAAAABAAAEAAAAABxzdHNjAAAAAAAAAAEAAAABAAAAHgAAAAEAAACMc3RzegAAAAAAAAAAAAAAHgAADSEAAAAoAAAAIQAAABgAAAAZAAAAGQAAABIAAAASAAAAEwAAABMAAAAgAAAAFQAAABMAAAATAAAAEgAAABIAAAASAAAAEgAAABIAAAAdAAAAEgAAABIAAAASAAAAEgAAABIAAAASAAAAEgAAABIAAAAdAAAAEgAAABRzdGNvAAAAAAAAAAEAAAReAAAAYXVkdGEAAABZbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAsaWxzdAAAACSpdG9vAAAAHGRhdGEAAAABAAAAAExhdmY2MS43LjEwMwAAAAhmcmVlAAAPl21kYXQAAAKwBgX//6zcRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY0IHIzMTA4IDMxZTE5ZjkgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDIzIC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MSByZWY9MTYgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDEzMyBtZT11bWggc3VibWU9MTAgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0yNCBjaHJvbWFfbWU9MSB0cmVsbGlzPTIgOHg4ZGN0PTEgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz03IGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9OCBiX3B5cmFtaWQ9MiBiX2FkYXB0PTIgYl9iaWFzPTAgZGlyZWN0PTMgd2VpZ2h0Yj0xIG9wZW5fZ29wPTAgd2VpZ2h0cD0yIGtleWludD0yNTAga2V5aW50X21pbj0xMCBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTYwIHJjPWNyZiBtYnRyZWU9MSBjcmY9MzguMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBh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";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
}

function sendText(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

function getBaseUrl(req) {
  const protocol = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${protocol}://${host}`;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
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
    "User-Agent": "Mozilla/5.0 Streamisko/1.0.4-uncached",
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
    "User-Agent": "Streamisko/1.0.4-uncached",
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

async function fetchTorBoxTorrentList() {
  const url = new URL("https://api.torbox.app/v1/api/torrents/mylist");
  url.searchParams.set("bypass_cache", "true");
  const result = await parseTorBoxResponse(
    await fetchWithTimeout(url, { headers: getTorBoxHeaders() }, 8000)
  );
  return result.ok ? torBoxTorrentList(result.payload) : [];
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
      return;
    }

    if (token === 0x6c) {
      offset += 1;
      while (offset < buffer.length && buffer[offset] !== 0x65) parseValue(false);
      if (buffer[offset] !== 0x65) throw new Error("Unterminated bencoded list");
      offset += 1;
      return;
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
      return;
    }

    throw new Error("Unsupported bencoded token");
  }

  try {
    parseValue(true);
    if (infoStart < 0 || infoEnd <= infoStart) return null;
    return require("node:crypto").createHash("sha1").update(buffer.subarray(infoStart, infoEnd)).digest("hex");
  } catch {
    return null;
  }
}

async function downloadSkTorrentFile(skTorrentId) {
  if (!getSkTorrentCredentials()) throw new Error("SKTorrent credentials are not configured");

  const response = await fetchWithTimeout(
    `https://sktorrent.eu/torrent/download.php?id=${encodeURIComponent(skTorrentId)}`,
    {
      redirect: "follow",
      headers: getSkTorrentHeaders("application/x-bittorrent,application/octet-stream,*/*")
    },
    10000
  );

  if (!response || !response.ok) throw new Error("Could not download the SKTorrent .torrent file");
  if (/text\/html/i.test(response.headers.get("content-type") || "")) {
    throw new Error("SKTorrent returned HTML instead of a .torrent file");
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error("SKTorrent returned an empty .torrent file");
  return buffer;
}

async function createTorBoxTorrentFromFile(skTorrentId, torrentBuffer) {
  const body = new FormData();
  const blob = new Blob([torrentBuffer], { type: "application/x-bittorrent" });
  body.append("file", blob, `${skTorrentId}.torrent`);
  body.append("seed", "1");

  const result = await parseTorBoxResponse(
    await fetchWithTimeout(
      "https://api.torbox.app/v1/api/torrents/createtorrent",
      { method: "POST", headers: getTorBoxHeaders(), body },
      15000
    )
  );

  if (!result.ok) {
    const detail = result.payload && (result.payload.detail || result.payload.error);
    throw new Error(detail || `TorBox create torrent failed (${result.status || "network"})`);
  }

  const data = unwrapTorBoxPayload(result.payload);
  return data && typeof data === "object" ? (data.torrent_id ?? data.id ?? null) : data;
}

async function queueUncachedTorrent(skTorrentId) {
  const torrentBuffer = await downloadSkTorrentFile(skTorrentId);
  const infoHash = parseTorrentInfoHash(torrentBuffer);
  if (!infoHash) throw new Error("Could not read torrent info hash");

  const existing = (await fetchTorBoxTorrentList()).find(
    (item) => torBoxTorrentHash(item) === infoHash.toLowerCase()
  );
  if (existing) return existing.id ?? null;

  return createTorBoxTorrentFromFile(skTorrentId, torrentBuffer);
}

function sendDownloadingVideo(res) {
  const video = Buffer.from(DOWNLOADING_VIDEO_BASE64, "base64");
  res.statusCode = 200;
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Length", String(video.length));
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "no-store");
  res.end(video);
}

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "GET") return sendText(res, 405, "Method not allowed");

  const route = String(req.query.route || "");
  if (route === "info-video") return sendDownloadingVideo(res);

  if (route === "download") {
    const skTorrentId = String(req.query.torrent || "").trim().toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(skTorrentId)) return sendText(res, 400, "Invalid SKTorrent id");
    if (!getTorBoxApiKey()) return sendText(res, 400, "TorBox API key is not configured");

    try {
      await queueUncachedTorrent(skTorrentId);
      const infoUrl = new URL(`${getBaseUrl(req)}/api/torbox-uncached`);
      infoUrl.searchParams.set("route", "info-video");
      res.statusCode = 302;
      res.setHeader("Location", infoUrl.toString());
      res.setHeader("Cache-Control", "no-store");
      return res.end();
    } catch (error) {
      return sendText(
        res,
        502,
        `Streamiško could not add this uncached torrent to TorBox: ${error && error.message ? error.message : "unknown error"}`
      );
    }
  }

  return sendText(res, 404, "Not found");
};
