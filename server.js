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

// Helper: fetch from DATEX with auth
async function datexGet(endpoint) {
  const res = await fetch(`${DATEX_BASE}/${endpoint}/pullsnapshotdata`, {
    headers: { Authorization: `Basic ${DATEX_AUTH}`, Accept: "application/xml, text/xml" },
  });
  if (res.status === 401) throw new Error("401 — sjekk DATEX_USER og DATEX_PASS i Render environment variables");
  if (!res.ok) throw new Error(`Vegvesen svarte ${res.status}`);
  return res.text();
}

// Helper: extract first text match for any of several tag names
function getTag(xml, ...tags) {
  for (const tag of tags) {
    const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]{1,300})</${tag}>`, "i"));
    if (m) return m[1].trim();
  }
  return "";
}

// ─── Raw DATEX proxy (for debugging / fallback) ───────────────────────────────
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
    console.error("DATEX raw error:", e.message);
    res.status(502).json({ error: e.message });
  }
});

// ─── Travel times — parsed server-side, returns JSON ─────────────────────────
app.get("/travel", async (req, res) => {
  try {
    const xml = await datexGet("GetTravelTimeData");

    // Also fetch location names so we can label each segment
    let locXml = "";
    try { locXml = await datexGet("GetPredefinedTravelTimeLocations"); } catch(_) {}

    // Build location name map from id → description
    const locMap = {};
    const locBlocks = [...locXml.matchAll(/<predefinedLocation[^>]*>([\s\S]*?)<\/predefinedLocation>/gi)];
    for (const lb of locBlocks) {
      const idM   = lb[0].match(/id="([^"]+)"/);
      const nameM = lb[1].match(/<name[^>]*>\s*<value[^>]*>([^<]+)<\/value>/i) ||
                    lb[1].match(/<description[^>]*>\s*<value[^>]*>([^<]+)<\/value>/i) ||
                    lb[1].match(/<value[^>]*>([^<]+)<\/value>/i);
      if (idM && nameM) locMap[idM[1]] = nameM[1].trim();
    }

    // Parse travel time measurement blocks
    const results = [];
    // v3.1 uses <elaboratedData> inside <siteMeasurements>
    const blocks = [...xml.matchAll(/<siteMeasurements[^>]*>([\s\S]*?)<\/siteMeasurements>/gi)];
    for (const b of blocks) {
      const block = b[1];
      const refM  = block.match(/measurementSiteReference[^>]+refId="([^"]+)"/i) ||
                    block.match(/<measurementSiteReference[^>]*>([^<]+)<\/measurementSiteReference>/i);
      const ref   = refM ? refM[1] : "";
      const label = locMap[ref] || ref || "Strekning";

      // Travel time in seconds
      const secM  = block.match(/<travelTime[^>]*>\s*<duration[^>]*>([^<]+)<\/duration>/i) ||
                    block.match(/<duration[^>]*>PT([^S]+)S<\/duration>/i) ||
                    block.match(/<value[^>]*>([0-9.]+)<\/value>/i);

      // Free-flow travel time
      const freeM = block.match(/<freeFlowTravelTime[^>]*>\s*<duration[^>]*>([^<]+)<\/duration>/i) ||
                    block.match(/<normallyExpectedTravelTime[^>]*>\s*<duration[^>]*>([^<]+)<\/duration>/i);

      let secs = null;
      if (secM) {
        // Handle both PT30S (ISO 8601) and plain numbers
        const raw = secM[1].trim();
        secs = raw.startsWith("PT") ? parseFloat(raw.replace("PT","").replace("S","")) : parseFloat(raw);
      }
      let freeSecs = null;
      if (freeM) {
        const raw = freeM[1].trim();
        freeSecs = raw.startsWith("PT") ? parseFloat(raw.replace("PT","").replace("S","")) : parseFloat(raw);
      }

      if (secs && !isNaN(secs) && secs > 0 && secs < 7200) { // sanity check: < 2 hours
        results.push({ label, secs, freeSecs });
      }
    }

    console.log(`Travel times: found ${results.length} segments, ${blocks.length} blocks`);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({ ok: true, count: results.length, routes: results.slice(0, 10) });
  } catch (e) {
    console.error("Travel time error:", e.message);
    res.status(502).json({ ok: false, error: e.message, routes: [] });
  }
});

// ─── Incidents — parsed server-side, returns JSON ────────────────────────────
app.get("/incidents", async (req, res) => {
  try {
    const xml = await datexGet("GetSituation");

    const results = [];
    const blocks = [...xml.matchAll(/<situationRecord[^>]*>([\s\S]*?)<\/situationRecord>/gi)];

    for (const b of blocks.slice(0, 10)) {
      const block = b[1];

      // Description — try several tag paths used in v3.1
      const desc =
        getTag(block, "comment", "generalPublicComment", "overallSeverity") ||
        getTag(block, "impactOnTraffic", "trafficRestrictionType", "networkManagement") ||
        "Trafikkmelding";

      // Location / road name
      const road = getTag(block, "roadName", "locationDescription", "roadNumber", "tpegPointName");

      // Time
      const time = getTag(block, "situationRecordCreationTime", "overallStartTime", "startOfPeriod");

      // Severity
      const sev = getTag(block, "severity", "probabilityOfOccurrence", "impactSeverityLevel");

      results.push({ desc, road, time, sev });
    }

    console.log(`Incidents: found ${results.length} of ${blocks.length} blocks`);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({ ok: true, count: results.length, incidents: results });
  } catch (e) {
    console.error("Incidents error:", e.message);
    res.status(502).json({ ok: false, error: e.message, incidents: [] });
  }
});

// ─── Camera list — parsed server-side, returns JSON ──────────────────────────
app.get("/cameras", async (req, res) => {
  try {
    const xml = await datexGet("GetCCTVSiteTable");

    const cameras = [];
    // Try both tag variants used across DATEX v3.1 implementations
    const patterns = [
      /<cctvSiteRecord[^>]*>([\s\S]*?)<\/cctvSiteRecord>/gi,
      /<cctvCamera[^>]*>([\s\S]*?)<\/cctvCamera>/gi,
    ];

    for (const pattern of patterns) {
      const matches = [...xml.matchAll(pattern)];
      for (const m of matches) {
        const block = m[1];

        const lat  = parseFloat(getTag(block, "latitude", "lat") || "0");
        const lon  = parseFloat(getTag(block, "longitude", "lon") || "0");
        const name = getTag(block, "cctvCameraIdentifier", "value", "name", "description") || "Kamera";
        const url  = getTag(block, "urlLinkAddress", "stillImageUrl", "urlLink", "imageUrl");

        // Extract numeric ID from URL (webkamera.vegvesen.no/public?id=XXXXX)
        const idFromUrl = url.match(/[?&]id=(\d+)/)?.[1];

        if (idFromUrl && lat > 59.7 && lat < 60.2 && lon > 10.3 && lon < 11.0) {
          cameras.push({ name, lat, lon, url: `/camimg?id=${idFromUrl}` });
        }
      }
      if (cameras.length > 0) break; // found cameras with first pattern
    }

    // Log a snippet to help debug XML structure if nothing found
    if (cameras.length === 0) {
      console.log("No cameras found. XML snippet:", xml.slice(0, 800));
    } else {
      console.log(`Cameras: found ${cameras.length} in Oslo area`);
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({ ok: true, count: cameras.length, cameras: cameras.slice(0, 9) });
  } catch (e) {
    console.error("Camera error:", e.message);
    res.status(502).json({ ok: false, error: e.message, cameras: [] });
  }
});

// ─── Camera image proxy ───────────────────────────────────────────────────────
app.get("/camimg", async (req, res) => {
  const { id } = req.query;
  if (!id || !/^\d+$/.test(id)) return res.status(400).send("Invalid ID");
  try {
    const upstream = await fetch(`https://webkamera.vegvesen.no/public?id=${id}`, {
      headers: { Authorization: `Basic ${DATEX_AUTH}`, "User-Agent": "oslo-ops-center/1.0" },
    });
    if (!upstream.ok) return res.status(upstream.status).send("Camera unavailable");
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
