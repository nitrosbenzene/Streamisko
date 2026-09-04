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

module.exports = function handler(req, res) {
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

    return sendJson(res, 200, {
      streams: [
        {
          name: "Streamiško",
          description: "Hello Streamiško 👋",
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
