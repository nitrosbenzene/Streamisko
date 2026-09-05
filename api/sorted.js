const movieHandler = require("./movie");
const seriesHandler = require("./series-v6");
const { formatStreamsLikeReference } = require("./reference-format");

function streamDescription(stream) {
  return String(stream && stream.description || "");
}

function cacheRank(stream) {
  const description = streamDescription(stream);
  if (/Cached on TorBox:\s*Yes\b/i.test(description)) return 0;
  if (/Cached on TorBox:\s*No\b/i.test(description)) return 1;
  return 2;
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
  const match = streamDescription(stream).match(/SKTorrent ID:\s*([a-f0-9]{40})\b/i);
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
  const type = req.query.type === "series" ? "series" : "movie";
  const upstreamHandler = type === "series" ? seriesHandler : movieHandler;
  const { response: capturedRes, done } = captureResponse();

  await upstreamHandler(req, capturedRes);
  const captured = await done;

  for (const header of captured.headers) {
    res.setHeader(header.name, header.value);
  }

  res.statusCode = captured.statusCode;
  if (captured.statusCode !== 200) return res.end(captured.body);

  try {
    const body = JSON.parse(captured.body);
    if (body && Array.isArray(body.streams)) {
      const torrentStreams = body.streams.filter((stream) => !isDebugStream(stream));
      const wired = wireUncachedTorBoxStreams(torrentStreams, getBaseUrl(req));
      body.streams = await formatStreamsLikeReference(wired, type, req.query.id);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.end(JSON.stringify(body));
    }
  } catch {
    // Preserve the original response if it is not JSON or formatting fails.
  }

  return res.end(captured.body);
};
