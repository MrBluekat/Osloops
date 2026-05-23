import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();
const app  = express();
const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(express.static(path.join(__dirname, "public")));

const DATEX_BASE = "https://datex-server-get-v3-1.atlas.vegvesen.no/datexapi";
const DATEX_AUTH = Buffer.from(
  `${process.env.DATEX_USER}:${process.env.DATEX_PASS}`
).toString("base64");

// Strip all namespace prefixes from XML so regex works cleanly
// <ns7:cctvSiteRecord> → <cctvSiteRecord>, </ns2:payload> → </payload>
function stripNS(xml) {
  return xml
    .replace(/<([a-zA-Z0-9]+):/g, "<")
    .replace(/<\/([a-zA-Z0-9]+):/g, "</");
}

// Fetch from DATEX with auth
async function datexGet(endpoint) {
  const res = await fetch(`${DATEX_BASE}/${endpoint}/pullsnapshotdata`, {
    headers: { Authorization: `Basic ${DATEX_AUTH}`, Accept: "application/xml, text/xml" },
  });
  if (res.status === 401) throw new Error("401 — sjekk DATEX_USER og DATEX_PASS i Render environment variables");
  if (!res.ok) throw new Error(`Vegvesen svarte ${res.status}`);
  const xml = await res.text();
  return stripNS(xml);
}

// Extract first matching tag value from a block of XML
function getTag(xml, ...tags) {
  for (const tag of tags) {
    const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]{1,500})</${tag}>`, "i"));
    if (m) return m[1].trim();
  }
  return "";
}

// Extract value from nested <value> tag (DATEX multilingual strings)
function getValueTag(xml, ...wrappers) {
  for (const tag of wrappers) {
    const m = xml.match(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<value[^>]*>([^<]{1,300})<\\/value>`, "i"));
    if (m) return m[1].trim();
  }
  return "";
}

// ─── Raw DATEX proxy ──────────────────────────────────────────────────────────
const ALLOWED = ["GetTravelTimeData","GetPredefinedTravelTimeLocations","GetCCTVSiteTable","GetSituation","GetMeasuredWeatherData"];
app.get("/datex/:endpoint", async (req, res) => {
  if (!ALLOWED.includes(req.params.endpoint))
    return res.status(400).json({ error: "Unknown endpoint" });
  try {
    const xml = await datexGet(req.params.endpoint);
    res.setHeader("Content-Type", "application/xml");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(xml);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ─── Debug — visit /debug/cameras, /debug/travel, /debug/incidents in browser ─
app.get("/debug/:name", async (req, res) => {
  const map = { cameras:"GetCCTVSiteTable", travel:"GetTravelTimeData", incidents:"GetSituation" };
  const ep  = map[req.params.name];
  if (!ep) return res.status(400).send("Bruk: cameras, travel, incidents");
  try {
    const xml = await datexGet(ep);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(xml.slice(0, 4000)); // first 4000 chars of stripped XML
  } catch (e) {
    res.status(502).send("Feil: " + e.message);
  }
});

// ─── Travel times ─────────────────────────────────────────────────────────────
app.get("/travel", async (req, res) => {
  try {
    const xml    = await datexGet("GetTravelTimeData");
    let   locXml = "";
    try { locXml = await datexGet("GetPredefinedTravelTimeLocations"); } catch(_) {}

    // Build location name map  id → human label
    const locMap = {};
    const locBlocks = [...locXml.matchAll(/<predefinedLocation[^>]*>([\s\S]*?)<\/predefinedLocation>/gi)];
    for (const lb of locBlocks) {
      const idM = lb[0].match(/id="([^"]+)"/);
      const nm  = getValueTag(lb[1], "name", "description") || getTag(lb[1], "value", "name");
      if (idM && nm) locMap[idM[1]] = nm;
    }

    const results = [];
    const blocks  = [...xml.matchAll(/<siteMeasurements[^>]*>([\s\S]*?)<\/siteMeasurements>/gi)];

    for (const b of blocks) {
      const block = b[1];

      // Location reference
      const refM  = block.match(/measurementSiteReference[^>]+refId="([^"]+)"/i) ||
                    block.match(/<measurementSiteReference[^>]*>([^<]+)<\/measurementSiteReference>/i);
      const ref   = refM ? refM[1] : "";
      const label = locMap[ref] || ref || "Strekning";

      // Travel time — handle ISO 8601 (PT45S) and plain seconds
      const parseDuration = (str) => {
        if (!str) return null;
        str = str.trim();
        if (str.startsWith("PT")) {
          const h = (str.match(/(\d+)H/)?.[1] || 0) * 3600;
          const m = (str.match(/(\d+)M/)?.[1] || 0) * 60;
          const s = (str.match(/(\d+(?:\.\d+)?)S/)?.[1] || 0) * 1;
          return h + m + parseFloat(s);
        }
        return parseFloat(str);
      };

      const secRaw  = getTag(block, "travelTime", "duration", "value");
      const freeRaw = getTag(block, "freeFlowTravelTime", "normallyExpectedTravelTime");
      const secs    = parseDuration(secRaw);
      const freeSecs= parseDuration(freeRaw);

      if (secs && !isNaN(secs) && secs > 0 && secs < 7200) {
        results.push({ label, secs, freeSecs });
      }
    }

    console.log(`Travel: ${results.length} ruter fra ${blocks.length} blokker`);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({ ok: true, count: results.length, routes: results.slice(0, 10) });
  } catch (e) {
    console.error("Travel error:", e.message);
    res.status(502).json({ ok: false, error: e.message, routes: [] });
  }
});

// ─── Incidents ────────────────────────────────────────────────────────────────
app.get("/incidents", async (req, res) => {
  try {
    const xml    = await datexGet("GetSituation");
    const results = [];

    const blocks = [...xml.matchAll(/<situationRecord[^>]*>([\s\S]*?)<\/situationRecord>/gi)];
    console.log(`Incidents: ${blocks.length} blokker funnet`);

    for (const b of blocks.slice(0, 10)) {
      const block = b[1];

      const desc =
        getValueTag(block, "comment", "generalPublicComment") ||
        getTag(block, "overallSeverity", "impactOnTraffic", "trafficRestrictionType", "networkManagement") ||
        "Trafikkmelding";

      const road = getValueTag(block, "locationDescription") ||
                   getTag(block, "roadName", "roadNumber", "tpegPointName");

      const time = getTag(block, "situationRecordCreationTime", "overallStartTime", "startOfPeriod");
      const sev  = getTag(block, "severity", "probabilityOfOccurrence", "impactSeverityLevel");

      results.push({ desc, road, time, sev });
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({ ok: true, count: results.length, incidents: results });
  } catch (e) {
    console.error("Incidents error:", e.message);
    res.status(502).json({ ok: false, error: e.message, incidents: [] });
  }
});

// ─── Camera list ──────────────────────────────────────────────────────────────
app.get("/cameras", async (req, res) => {
  try {
    const xml     = await datexGet("GetCCTVSiteTable");
    const cameras = [];

    // After namespace stripping, try both common DATEX v3.1 record tags
    for (const tag of ["cctvSiteRecord", "cctvCamera", "cctvSiteTablePublication"]) {
      const pattern = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
      const matches = [...xml.matchAll(pattern)];
      if (!matches.length) continue;

      for (const m of matches) {
        const block = m[1];
        const lat   = parseFloat(getTag(block, "latitude", "lat") || "0");
        const lon   = parseFloat(getTag(block, "longitude", "lon") || "0");
        const name  = getValueTag(block, "cctvCameraIdentifier", "name", "description") ||
                      getTag(block, "cctvCameraIdentifier", "value", "name") || "Kamera";
        const url   = getTag(block, "urlLinkAddress", "stillImageUrl", "urlLink", "imageUrl");
        const idFromUrl = url.match(/[?&]id=(\d+)/)?.[1];

        if (idFromUrl && lat > 59.7 && lat < 60.2 && lon > 10.3 && lon < 11.0) {
          cameras.push({ name, lat, lon, url: `/camimg?id=${idFromUrl}` });
        }
      }
      if (cameras.length) break;
    }

    // Log more XML if still empty to help debug
    if (cameras.length === 0) {
      // Find first URL in the XML to verify the structure
      const anyUrl = xml.match(/webkamera\.vegvesen\.no[^"<\s]*/)?.[0] || "ingen URL funnet";
      console.log(`Ingen kameraer. Første URL i XML: ${anyUrl}`);
      console.log(`XML-snippet (500 tegn): ${xml.slice(0, 500)}`);
    } else {
      console.log(`Kameraer: ${cameras.length} funnet i Oslo-området`);
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({ ok: true, count: cameras.length, cameras: cameras.slice(0, 9) });
  } catch (e) {
    console.error("Camera error:", e.message);
    res.status(502).json({ ok: false, error: e.message, cameras: [] });
  }
});

// ─── Camera image proxy ───────────────────────────────────────────────────────
// 406-fix: don't send Accept header — let vegvesen return default content type
app.get("/camimg", async (req, res) => {
  const { id } = req.query;
  if (!id || !/^\d+$/.test(id)) return res.status(400).send("Invalid ID");
  try {
    const upstream = await fetch(`https://webkamera.vegvesen.no/public?id=${id}`, {
      headers: {
        Authorization: `Basic ${DATEX_AUTH}`,
        "User-Agent": "Mozilla/5.0 oslo-ops-center/1.0",
      },
    });
    if (!upstream.ok) return res.status(upstream.status).send(`Camera ${upstream.status}`);
    const buf = await upstream.arrayBuffer();
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=30");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(Buffer.from(buf));
  } catch (e) {
    res.status(502).send("Camera fetch failed");
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ─── Catch-all → index.html ───────────────────────────────────────────────────
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log(`Oslo Ops Center running on http://localhost:${PORT}`));
