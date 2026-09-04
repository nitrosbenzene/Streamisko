const movieHandler = require("./index");
const seriesHandler = require("./series");

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

function cacheRank(stream) {
  const description = String(stream && stream.description || "");
  if (/Cached on TorBox:\s*Yes\b/i.test(description)) return 0;
  if (/Cached on TorBox:\s*No\b/i.test(description)) return 1;
  return 2;
}

function streamSizeBytes(stream) {
  const description = String(stream && stream.description || "");
  const match = description.match(/(?:^|\n)Size:\s*([^\n•]+)/i);
  return match ? parseSizeBytes(match[1]) : -1;
}

function sortStreams(streams) {
  if (!Array.isArray(streams) || streams.length <= 2) return streams;

  const helloStream = streams[0];
  const torrentStreams = streams.slice(1).map((stream, originalIndex) => ({
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

  return [helloStream, ...torrentStreams.map((item) => item.stream)];
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
      body.streams = sortStreams(body.streams);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.end(JSON.stringify(body));
    }
  } catch {
    // Preserve the original response if it is not JSON.
  }

  return res.end(captured.body);
};
