import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();
const app  = express();
const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Serve the frontend ───────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

// ─── DATEX II proxy ───────────────────────────────────────────────────────────
// All DATEX requests go through here — credentials never touch the browser
const DATEX_BASE = "https://datex-server-get-v3-1.atlas.vegvesen.no/datexapi";
const DATEX_AUTH = Buffer.from(
  `${process.env.DATEX_USER}:${process.env.DATEX_PASS}`
).toString("base64");

const ALLOWED_ENDPOINTS = [
  "GetTravelTimeData",
  "GetPredefinedTravelTimeLocations",
  "GetCCTVSiteTable",
  "GetSituation",
  "GetMeasuredWeatherData",
];

app.get("/datex/:endpoint", async (req, res) => {
  const { endpoint } = req.params;

  if (!ALLOWED_ENDPOINTS.includes(endpoint)) {
    return res.status(400).json({ error: "Unknown endpoint" });
  }

  try {
    const upstream = await fetch(
      `${DATEX_BASE}/${endpoint}/pullsnapshotdata`,
      {
        headers: {
          Authorization: `Basic ${DATEX_AUTH}`,
          Accept: "application/xml, text/xml",
        },
      }
    );

    if (upstream.status === 401) {
      return res.status(401).json({ error: "Bad DATEX credentials — check .env" });
    }
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: `Vegvesen returned ${upstream.status}` });
    }

    const xml = await upstream.text();
    res.setHeader("Content-Type", "application/xml");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(xml);
  } catch (err) {
    console.error("DATEX fetch error:", err.message);
    res.status(502).json({ error: "Could not reach Vegvesen DATEX server" });
  }
});

// ─── Camera image proxy ───────────────────────────────────────────────────────
// Vegvesen camera images block direct browser requests (no CORS).
// We proxy them server-side and forward to the browser.
// Only allow vegvesen camera URLs to prevent open proxy abuse.
app.get("/camimg", async (req, res) => {
  const { id } = req.query;
  if (!id || !/^\d+$/.test(id)) {
    return res.status(400).send("Invalid camera ID");
  }
  const camUrl = `https://webkamera.vegvesen.no/public?id=${id}`;
  try {
    const upstream = await fetch(camUrl, {
      headers: {
        Authorization: `Basic ${DATEX_AUTH}`,
        "User-Agent": "oslo-ops-center/1.0",
      },
    });
    if (!upstream.ok) return res.status(upstream.status).send("Camera unavailable");
    const buf = await upstream.arrayBuffer();
    const ct  = upstream.headers.get("content-type") || "image/jpeg";
    res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", "public, max-age=30"); // cache 30s — cams update slowly
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(Buffer.from(buf));
  } catch (err) {
    res.status(502).send("Could not fetch camera image");
  }
});

// ─── DATEX camera list — parsed and returned as clean JSON ────────────────────
// Parses the CCTV XML on the server and returns only Oslo cameras as JSON,
// so the browser doesn't need to deal with complex DATEX XML.
app.get("/cameras", async (req, res) => {
  try {
    const upstream = await fetch(
      `${DATEX_BASE}/GetCCTVSiteTable/pullsnapshotdata`,
      { headers: { Authorization: `Basic ${DATEX_AUTH}`, Accept: "application/xml" } }
    );
    if (!upstream.ok) throw new Error(`Vegvesen ${upstream.status}`);
    const xml = await upstream.text();

    // Parse camera entries with regex — no XML lib needed for this structure
    const cameras = [];

    // DATEX v3.1 CCTV structure: <cctvSiteRecord> contains <id>, <name>, coordinates and <urlLinkAddress>
    const sitePattern = /<cctvSiteRecord[^>]*>([\s\S]*?)<\/cctvSiteRecord>/g;
    let match;
    while ((match = sitePattern.exec(xml)) !== null) {
      const block = match[1];

      const getText = (tag) => {
        const m = block.match(new RegExp(`<${tag}[^>]*>([^<]+)<\/${tag}>`));
        return m ? m[1].trim() : "";
      };

      const lat  = parseFloat(getText("latitude")  || getText("lat")  || "0");
      const lon  = parseFloat(getText("longitude") || getText("lon")  || "0");
      const name = getText("cctvCameraIdentifier") || getText("value") || getText("name") || "Kamera";

      // Extract image URL — try multiple possible tag names used in v3.1
      let imgUrl = getText("urlLinkAddress") || getText("stillImageUrl") || getText("urlLink") || "";

      // If no direct URL, check for camera ID to build proxy URL
      const idMatch = block.match(/id="([^"]+)"/);
      const camId   = idMatch ? idMatch[1] : "";

      // Filter to Oslo area (lat 59.7–60.2, lon 10.3–11.0)
      if (lat > 59.7 && lat < 60.2 && lon > 10.3 && lon < 11.0) {
        // Use our server proxy for the image to bypass CORS
        const proxyUrl = imgUrl
          ? `/camimg?id=${encodeURIComponent(imgUrl.match(/id=(\d+)/)?.[1] || camId)}`
          : camId ? `/camimg?id=${camId}` : null;

        if (proxyUrl && proxyUrl !== "/camimg?id=") {
          cameras.push({ name, lat, lon, url: proxyUrl, rawUrl: imgUrl });
        }
      }
    }

    // Also try <cctvCamera> tag (some v3.1 variants use this)
    if (cameras.length === 0) {
      const camPattern = /<cctvCamera[^>]*>([\s\S]*?)<\/cctvCamera>/g;
      while ((match = camPattern.exec(xml)) !== null) {
        const block = match[1];
        const getText = (tag) => {
          const m = block.match(new RegExp(`<${tag}[^>]*>([^<]+)<\/${tag}>`));
          return m ? m[1].trim() : "";
        };
        const lat = parseFloat(getText("latitude") || "0");
        const lon = parseFloat(getText("longitude") || "0");
        const name = getText("name") || getText("description") || "Kamera";
        const imgUrl = getText("urlLinkAddress") || getText("stillImageUrl") || "";
        const idFromUrl = imgUrl.match(/id=(\d+)/)?.[1];
        if (lat > 59.7 && lat < 60.2 && lon > 10.3 && lon < 11.0 && idFromUrl) {
          cameras.push({ name, lat, lon, url: `/camimg?id=${idFromUrl}`, rawUrl: imgUrl });
        }
      }
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({ count: cameras.length, cameras: cameras.slice(0, 9) });
  } catch (err) {
    console.error("Camera list error:", err.message);
    res.status(502).json({ error: err.message, cameras: [] });
  }
});

// ─── Health check (used by hosting platforms) ────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ─── Catch-all → serve index.html (single page app) ─────────────────────────
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Oslo Ops Center running on http://localhost:${PORT}`);
});
