const movieHandler = require("./movie");
const seriesHandler = require("./series-v6");

function parseSizeBytes(value) {
  const text = String(value || "").trim();
  const match = text.match(/([0-9]+(?:[.,][0-9]+)?)\s*(B|KB|MB|GB|TB|KIB|MIB|GIB|TIB)\b/i);
  if (!match) return -1;

  const amount = Number(match[1].replace(",", "."));
  if (!Number.isFinite(amount)) return -1;

  const unit = match[2].toUpperCase();
  const powers = {
    B: 0,
    KB: 1,
    KIB: 1,
    MB: 2,
    MIB: 2,
    GB: 3,
    GIB: 3,
    TB: 4,
    TIB: 4
  };

  return amount * (1024 ** powers[unit]);
}

function streamDescription(stream) {
  return String(stream && stream.description || "");
}

function cacheRank(stream) {
  const description = streamDescription(stream);
  if (/Cached on TorBox:\s*Yes\b/i.test(description)) return 0;
  if (/Cached on TorBox:\s*No\b/i.test(description)) return 1;
  return 2;
}

function streamSizeBytes(stream) {
  const description = streamDescription(stream);
  const match = description.match(/(?:^|\n)Size:\s*([^\n•]+)/i);
  return match ? parseSizeBytes(match[1]) : -1;
}

function isDebugStream(stream) {
  const name = String(stream && stream.name || "");
  const description = streamDescription(stream);
  const text = `${name}\n${description}`;

  return /hello\s+streamiško/i.test(text)
    || /hello\s+streamisko/i.test(text)
    || /streamiško\s+debug/i.test(text)
    || /streamisko\s+debug/i.test(text);
}

function getBaseUrl(req) {
  const protocol = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${protocol}://${host}`;
}

function skTorrentIdFromStream(stream) {
  const description = streamDescription(stream);
  const match = description.match(/SKTorrent ID:\s*([a-f0-9]{40})\b/i);
  return match ? match[1].toLowerCase() : null;
}

function wireUncachedTorBoxStreams(streams, baseUrl) {
  return (Array.isArray(streams) ? streams : []).map((stream) => {
    if (!stream || cacheRank(stream) !== 1) return stream;

    const skTorrentId = skTorrentIdFromStream(stream);
    if (!skTorrentId) return stream;

    const downloadUrl = new URL(`${baseUrl}/api/torbox-uncached`);
    downloadUrl.searchParams.set("route", "download");
    downloadUrl.searchParams.set("torrent", skTorrentId);

    const rewritten = {
      ...stream,
      url: downloadUrl.toString()
    };
    delete rewritten.externalUrl;
    return rewritten;
  });
}

function sortStreams(streams) {
  const torrentStreams = (Array.isArray(streams) ? streams : [])
    .filter((stream) => !isDebugStream(stream))
    .map((stream, originalIndex) => ({
      stream,
      originalIndex,
      cacheRank: cacheRank(stream),
      sizeBytes: streamSizeBytes(stream)
    }));

  torrentStreams.sort((a, b) => {
    if (a.cacheRank !== b.cacheRank) return a.cacheRank - b.cacheRank;
    if (a.sizeBytes !== b.sizeBytes) return b.sizeBytes - a.sizeBytes;
    return a.originalIndex - b.originalIndex;
  });

  return torrentStreams.map((item) => item.stream);
}

function descriptionLine(description, prefix) {
  const line = String(description || "")
    .split("\n")
    .find((entry) => entry.trim().toLowerCase().startsWith(prefix.toLowerCase()));
  return line ? line.trim().slice(prefix.length).trim() : "";
}

function cleanTorrentName(value) {
  return String(value || "")
    .replace(/^Stiahni si\s*/i, "")
    .trim();
}

function qualityText(value) {
  const text = String(value || "").toLowerCase();
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

  return qualities.length > 0 ? `🎥 ${qualities.join(" • ")}` : "🎥 Kvalita neznáma";
}

function languageText(value) {
  const flags = {
    CZ: "🇨🇿",
    SK: "🇸🇰",
    EN: "🇬🇧"
  };
  const matches = String(value || "").match(/\b(CZ|SK|EN)\b/ig) || [];
  const unique = [...new Set(matches.map((code) => flags[code.toUpperCase()]).filter(Boolean))];
  return unique.length > 0 ? unique.join(" / ") : "Neznámy jazyk";
}

function extractDisplayMeta(streams, type) {
  const debug = (Array.isArray(streams) ? streams : []).find((stream) => isDebugStream(stream));
  if (!debug) return { titleLine: "", season: null, episode: null };

  const lines = streamDescription(debug).split("\n").map((line) => line.trim()).filter(Boolean);
  const infoLine = lines[1] || "";

  if (type === "series") {
    const match = infoLine.match(/^(.*?)\s*•\s*S(\d{1,2})E(\d{1,3})\b/i);
    if (match) {
      return {
        titleLine: match[1].trim(),
        season: Number(match[2]),
        episode: Number(match[3])
      };
    }
    return { titleLine: infoLine, season: null, episode: null };
  }

  return {
    titleLine: infoLine.replace(/\s*•\s*IMDb:.*$/i, "").trim(),
    season: null,
    episode: null
  };
}

function episodeInfo(description, meta) {
  const episodeCode = descriptionLine(description, "Episode:");
  const match = episodeCode.match(/S(\d{1,2})E(\d{1,3})/i);
  const season = match ? Number(match[1]) : meta.season;
  const episode = match ? Number(match[2]) : meta.episode;
  if (!Number.isFinite(season) || !Number.isFinite(episode)) return "";
  return `📺 Séria ${season} • Epizóda ${episode}`;
}

function torrentSizeAndSeeders(description) {
  const line = String(description || "").split("\n").find((entry) => /^Size:\s*/i.test(entry.trim())) || "";
  const sizeMatch = line.match(/Size:\s*([^•\n]+)/i);
  const seedersMatch = line.match(/Seeders:\s*([^•\n]+)/i);
  return {
    size: sizeMatch ? sizeMatch[1].trim() : "?",
    seeders: seedersMatch ? seedersMatch[1].trim() : "N/A"
  };
}

function displayFileName(description, type) {
  const raw = type === "series"
    ? descriptionLine(description, "Episode file:")
    : descriptionLine(description, "Torrent file:");
  if (!raw) return "";

  const fileName = raw.split(/[\\/]/).pop().trim();
  if (!fileName || /^Unavailable/i.test(fileName)) return "";

  // Movie handlers currently expose the .torrent metadata filename, not the selected video file.
  // Do not label that metadata file as the playable video file.
  if (type !== "series" && /\.torrent$/i.test(fileName)) return "";
  return fileName;
}

function formatStreamLikeReference(stream, type, meta) {
  const description = streamDescription(stream);
  const lines = description.split("\n");
  const rawTorrentTitle = lines[0] || stream.title || "SKTorrent";
  const torrentTitle = cleanTorrentName(rawTorrentTitle);
  const { size, seeders } = torrentSizeAndSeeders(description);
  const rows = [];

  if (meta.titleLine) rows.push(meta.titleLine);

  if (type === "series") {
    const episodeRow = episodeInfo(description, meta);
    if (episodeRow) rows.push(episodeRow);
  }

  rows.push(`🔊 ${languageText(torrentTitle)}   |   ${qualityText(torrentTitle)}`);
  rows.push(`💿 ${size}   |   👥 Seeders: ${seeders}`);

  const fileName = displayFileName(description, type);
  if (fileName) rows.push(`📄 Súbor: ${fileName}`);

  rows.push(`🗂️ Torrent: ${torrentTitle}`);

  const rank = cacheRank(stream);
  const category = type === "series" ? "SERIÁLY" : "FILMY";
  const name = rank === 0
    ? `[TB ⚡] SKT\n${category}`
    : rank === 1
      ? `[TB ⏳] SKT\n${category}`
      : `[TB ❓] SKT\n${category}`;

  const { description: _legacyDescription, ...rest } = stream;
  return {
    ...rest,
    name,
    title: rows.join("\n")
  };
}

function captureResponse() {
  const headers = new Map();
  let resolveDone;

  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

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

module.exports = async function handler(req, res) {
  const upstreamHandler = req.query.type === "series" ? seriesHandler : movieHandler;
  const { response: capturedRes, done } = captureResponse();

  await upstreamHandler(req, capturedRes);
  const captured = await done;

  for (const header of captured.headers) {
    res.setHeader(header.name, header.value);
  }

  res.statusCode = captured.statusCode;

  if (captured.statusCode !== 200) {
    return res.end(captured.body);
  }

  try {
    const body = JSON.parse(captured.body);
    if (body && Array.isArray(body.streams)) {
      const type = req.query.type === "series" ? "series" : "movie";
      const meta = extractDisplayMeta(body.streams, type);
      const sorted = sortStreams(body.streams);
      const wired = wireUncachedTorBoxStreams(sorted, getBaseUrl(req));
      body.streams = wired.map((stream) => formatStreamLikeReference(stream, type, meta));
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.end(JSON.stringify(body));
    }
  } catch {
    // Preserve the original response if it is not JSON.
  }

  return res.end(captured.body);
};
