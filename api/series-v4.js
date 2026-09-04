const seriesHandler = require('./series-v3');

function sendJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function decodeVideoId(value) {
  let raw = String(value || '').trim();
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
  return match ? { imdbId: match[1].toLowerCase() } : null;
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value) {
  const normalized = normalizeText(value);
  return normalized ? normalized.split(' ') : [];
}

function isReleaseMarker(token) {
  return /^(?:s\d{1,2}(?:e\d{1,3})?|e\d{1,3}|\d{1,2}x\d{1,3}|19\d{2}|20\d{2}|2160p|1080p|720p|480p|4k|uhd|hdr\d*|dv|webrip|webdl|bluray|brrip|hdtv|complete|komplet|season|serie|series)$/i.test(token || '');
}

function singleWordTitleMatches(seriesWord, candidate) {
  const tokens = tokenize(candidate);
  if (!tokens.length) return false;

  const indexes = [];
  tokens.forEach((token, index) => {
    if (token === seriesWord) indexes.push(index);
  });
  if (!indexes.length) return false;

  const continuationWords = new Set(['of', 'the', 'a', 'an', 'and', 'or', 'in', 'on', 'at', 'from', 'for', 'with', 'under', 'over', 'to']);
  const allowedPrefixes = new Set(['dr', 'doctor']);
  const knownSuffixes = new Set(['md']);

  return indexes.some((index) => {
    if (index > 1) return false;
    if (index === 1 && !allowedPrefixes.has(tokens[0])) return false;

    const next = tokens[index + 1] || '';
    if (!next) return true;
    if (continuationWords.has(next)) return false;
    if (knownSuffixes.has(next) || (next === 'm' && tokens[index + 2] === 'd') || isReleaseMarker(next)) return true;

    return /^(?:cz|sk|en|multi|dub|dabing|x264|x265|h264|h265|hevc|av1|aac|ac3|dts|proper|repack)$/i.test(next);
  });
}

function seriesTitleMatches(seriesName, candidate) {
  const seriesTokens = tokenize(seriesName);
  const candidateText = normalizeText(candidate);
  if (!seriesTokens.length || !candidateText) return false;

  if (seriesTokens.length === 1) {
    return singleWordTitleMatches(seriesTokens[0], candidate);
  }

  const exactPhrase = seriesTokens.join(' ');
  if (candidateText === exactPhrase || candidateText.startsWith(`${exactPhrase} `) || candidateText.includes(` ${exactPhrase} `)) {
    return true;
  }

  const candidateTokens = candidateText.split(' ');
  let cursor = 0;
  let firstMatch = -1;
  for (const word of seriesTokens) {
    const index = candidateTokens.indexOf(word, cursor);
    if (index === -1) return false;
    if (firstMatch === -1) firstMatch = index;
    cursor = index + 1;
  }
  return firstMatch <= 1 && cursor - firstMatch <= seriesTokens.length + 2;
}

function getDescriptionLine(description, prefix) {
  const lines = String(description || '').split('\n');
  const line = lines.find((entry) => entry.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : '';
}

function streamBelongsToSeries(stream, seriesName) {
  const description = String(stream && stream.description || '');
  const torrentTitle = description.split('\n')[0] || '';
  const episodeFile = getDescriptionLine(description, 'Episode file:');
  return seriesTitleMatches(seriesName, torrentTitle) || seriesTitleMatches(seriesName, episodeFile);
}

async function getSeriesName(imdbId) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(`https://v3-cinemeta.strem.io/meta/series/${encodeURIComponent(imdbId)}.json`, {
      signal: controller.signal
    });
    if (!response.ok) return null;
    const payload = await response.json();
    return payload && payload.meta && payload.meta.name ? String(payload.meta.name) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
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
    end(body = '') {
      resolveDone({
        statusCode: response.statusCode,
        headers: Array.from(headers.values()),
        body: body == null ? '' : String(body)
      });
    }
  };
  return { response, done };
}

module.exports = async function handler(req, res) {
  if (req.query.route === 'play') return seriesHandler(req, res);

  const parsed = parseSeriesVideoId(req.query.id);
  if (!parsed || req.query.type !== 'series') return seriesHandler(req, res);

  const seriesNamePromise = getSeriesName(parsed.imdbId);
  const { response: capturedRes, done } = captureResponse();
  await seriesHandler(req, capturedRes);
  const captured = await done;

  for (const header of captured.headers) res.setHeader(header.name, header.value);
  res.statusCode = captured.statusCode;
  if (captured.statusCode !== 200) return res.end(captured.body);

  let body;
  try {
    body = JSON.parse(captured.body);
  } catch {
    return res.end(captured.body);
  }

  if (!body || !Array.isArray(body.streams) || body.streams.length <= 1) {
    return sendJson(res, captured.statusCode, body);
  }

  const seriesName = await seriesNamePromise;
  if (!seriesName) return sendJson(res, captured.statusCode, body);

  const hello = body.streams[0];
  const before = body.streams.length - 1;
  const filtered = body.streams.slice(1).filter((stream) => streamBelongsToSeries(stream, seriesName));

  if (hello && hello.description) {
    hello.description = `${hello.description}\nTitle-relevant results: ${filtered.length}/${before}`;
  }

  return sendJson(res, captured.statusCode, { ...body, streams: [hello, ...filtered] });
};
