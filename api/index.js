const manifest = {
  id: "community.streamisko",
  version: "0.1.0",
  name: "Streamiško",
  description: "Minimal Streamiško Stremio addon scaffold.",
  resources: ["stream"],
  types: ["movie"],
  catalogs: []
};

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function getBaseUrl(req) {
  const protocol = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${protocol}://${host}`;
}

async function getMovieDetails(imdbId) {
  const fallback = {
    name: "Unknown movie",
    year: "Unknown year"
  };

  if (!/^tt\d+$/.test(imdbId)) {
    return fallback;
  }

  try {
    const response = await fetch(
      `https://v3-cinemeta.strem.io/meta/movie/${encodeURIComponent(imdbId)}.json`
    );

    if (!response.ok) {
      return fallback;
    }

    const data = await response.json();
    const meta = data && data.meta;

    if (!meta) {
      return fallback;
    }

    let year = fallback.year;

    if (meta.releaseInfo) {
      const yearMatch = String(meta.releaseInfo).match(/\d{4}/);
      if (yearMatch) {
        year = yearMatch[0];
      }
    } else if (meta.released) {
      const releasedYear = new Date(meta.released).getUTCFullYear();
      if (Number.isFinite(releasedYear)) {
        year = String(releasedYear);
      }
    }

    return {
      name: meta.name || fallback.name,
      year
    };
  } catch {
    return fallback;
  }
}

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== "GET") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  const route = req.query.route;

  if (route === "manifest") {
    return sendJson(res, 200, manifest);
  }

  if (route === "stream") {
    if (req.query.type !== "movie") {
      return sendJson(res, 200, { streams: [] });
    }

    const imdbId = String(req.query.id || "");
    const movie = await getMovieDetails(imdbId);

    return sendJson(res, 200, {
      streams: [
        {
          name: "Streamiško",
          description: `Hello Streamiško 👋\n${movie.name} (${movie.year}) • IMDb: ${imdbId || "unknown"}`,
          externalUrl: getBaseUrl(req)
        }
      ]
    });
  }

  if (route === "home") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Streamiško</title>
  </head>
  <body>
    <h1>Hello Streamiško 👋</h1>
    <p>This is the first minimal Stremio addon scaffold.</p>
  </body>
</html>`);
  }

  return sendJson(res, 404, { error: "Not found" });
};
