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

// ─── Debug — visit /debug/cameras, /debug/travel, /debug/incidents, /debug/locations
app.get("/debug/:name", async (req, res) => {
  const map = {
    cameras:   "GetCCTVSiteTable",
    travel:    "GetTravelTimeData",
    incidents: "GetSituation",
    locations: "GetPredefinedTravelTimeLocations",
  };
  const ep = map[req.params.name];
  if (!ep) return res.status(400).send("Bruk: cameras, travel, incidents, locations");
  try {
    const xml = await datexGet(ep);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(xml.slice(0, 6000));
  } catch (e) {
    res.status(502).send("Feil: " + e.message);
  }
});

// ─── Travel times ─────────────────────────────────────────────────────────────
// Location names are "Fra - Til" format e.g. "Ammerud - Bjerke"
// Coordinates are UTM32 — not usable for geo-filter, so we filter by name instead
// Eksakte strekninger vi vil vise — begge retninger (A→B og B→A)
const OSLO_ROUTES = [
  // E6 nord/sør
  ["hvam","manglerud"], ["hvam","ryen"],
  ["manglerud","hvam"], ["ryen","hvam"],
  ["klemetsrud","ryen"], ["klemetsrud","operatunnelen"],
  ["ryen","klemetsrud"], ["operatunnelen","klemetsrud"],
  ["operatunnelen"],   // enkeltpunkt — match alt med "operatunnelen"

  // E18 vest/øst
  ["asker","lysaker"], ["lysaker","filipstad"],
  ["asker","filipstad"],
  ["filipstad","lysaker"], ["lysaker","asker"],
  ["filipstad","asker"],
  ["fiskevollen","mosseveien"], ["fiskevollen","bjørvika"],
  ["mosseveien","fiskevollen"], ["bjørvika","fiskevollen"],

  // Ring 3 / Rv150
  ["ryen","granfosstunnelen"], ["granfosstunnelen","ryen"],
  ["manglerud","sinsen"], ["sinsen","manglerud"],
  ["bryn","smestad"], ["smestad","bryn"],
  ["sinsen","ullevål"], ["ullevål","sinsen"],
  ["ullevål","smestad"], ["smestad","ullevål"],

  // Rv4 / E16
  ["gjelleråsen","sinsen"], ["sinsen","gjelleråsen"],
  ["sandvika","skui"], ["skui","sandvika"],
];

function isOslo(name) {
  const l = name.toLowerCase();
  return OSLO_ROUTES.some(pair => pair.every(kw => l.includes(kw)));
}

app.get("/travel", async (req, res) => {
  try {
    const xml    = await datexGet("GetTravelTimeData");
    let   locXml = "";
    try { locXml = await datexGet("GetPredefinedTravelTimeLocations"); } catch(_) {}

    // Build id → name map
    // Structure: <predefinedLocationReference id="100357">
    //              <predefinedLocationName><values><value lang="no">Ammerud - Bjerke</value>
    const locMap = {};
    for (const m of locXml.matchAll(/<predefinedLocationReference[^>]+id="([^"]+)"[^>]*>([\s\S]*?)<\/predefinedLocationReference>/gi)) {
      const id   = m[1];
      const name = m[2].match(/<value[^>]*>([^<]+)<\/value>/i)?.[1]?.trim();
      if (id && name) locMap[id] = name;
    }

    const results = [];
    const seen    = new Set();

    const blocks = [...xml.matchAll(/<physicalQuantity[^>]*>([\s\S]*?)<\/physicalQuantity>/gi)];

    for (const b of blocks) {
      const block = b[1];
      if (!block.includes("TravelTimeData")) continue;

      const id    = block.match(/predefinedLocationReference[^>]+id="([^"]+)"/i)?.[1] || "";
      if (seen.has(id)) continue;
      seen.add(id);

      const label = locMap[id] || "";
      if (!label) continue;

      // Filter to Oslo area by name
      if (!isOslo(label)) continue;

      const secs     = parseFloat(block.match(/<travelTime[^>]*>\s*<duration[^>]*>([^<]+)<\/duration>/i)?.[1] || "0");
      const freeSecs = parseFloat(block.match(/<freeFlowTravelTime[^>]*>\s*<duration[^>]*>([^<]+)<\/duration>/i)?.[1] || "0");

      if (secs > 0 && secs < 7200) {
        results.push({ label, secs, freeSecs: freeSecs || null, id });
      }
    }

    // Sort by label for consistent display
    results.sort((a, b) => a.label.localeCompare(b.label, "no"));

    console.log(`Travel: ${results.length} Oslo-strekninger (av ${blocks.length} totalt)`);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({ ok: true, count: results.length, routes: results.slice(0, 15) });
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
// Confirmed DATEX v3.1 structure from live XML:
//   <cctvCameraMetadataRecord id="3000047_2">
//     <cctvCameraSiteLocalDescription><values><value>Rundebrua</value>...
//     <pointByCoordinates><pointCoordinates><latitude>62.37</latitude><longitude>5.62</longitude>
//     <stillImageUrl><urlLinkAddress>https://kamera.atlas.vegvesen.no/api/images/3000047_2</urlLinkAddress>
app.get("/cameras", async (req, res) => {
  try {
    const xml     = await datexGet("GetCCTVSiteTable");
    const cameras = [];

    const records = [...xml.matchAll(/<cctvCameraMetadataRecord[^>]*>([\s\S]*?)<\/cctvCameraMetadataRecord>/gi)];
    console.log(`Kamera-records totalt: ${records.length}`);

    for (const m of records) {
      const block = m[1];

      // Coordinates
      const lat = parseFloat(block.match(/<latitude>([^<]+)<\/latitude>/i)?.[1] || "0");
      const lon = parseFloat(block.match(/<longitude>([^<]+)<\/longitude>/i)?.[1] || "0");

      // Image URL inside <stillImageUrl><urlLinkAddress>
      const stillBlock = block.match(/<stillImageUrl[^>]*>([\s\S]*?)<\/stillImageUrl>/i)?.[1] || "";
      const imgUrl     = stillBlock.match(/<urlLinkAddress>([^<]+)<\/urlLinkAddress>/i)?.[1]?.trim() || "";

      // Name from <cctvCameraSiteLocalDescription><values><value>
      const descBlock = block.match(/<cctvCameraSiteLocalDescription[^>]*>([\s\S]*?)<\/cctvCameraSiteLocalDescription>/i)?.[1] || "";
      const name      = descBlock.match(/<value[^>]*>([^<]+)<\/value>/i)?.[1]?.trim() ||
                        block.match(/<cctvCameraIdentification>([^<]+)<\/cctvCameraIdentification>/i)?.[1]?.trim() || "Kamera";

      // Oslo area filter (lat 59.7-60.2, lon 10.3-11.0)
      if (imgUrl && lat > 59.7 && lat < 60.2 && lon > 10.3 && lon < 11.0) {
        cameras.push({ name, lat, lon, url: `/camimg?url=${encodeURIComponent(imgUrl)}` });
      }
    }

    console.log(`Kameraer i Oslo: ${cameras.length}`);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({ ok: true, count: cameras.length, cameras: cameras.slice(0, 9) });
  } catch (e) {
    console.error("Camera error:", e.message);
    res.status(502).json({ ok: false, error: e.message, cameras: [] });
  }
});

// ─── Camera image proxy ───────────────────────────────────────────────────────
// Proxies kamera.atlas.vegvesen.no server-side — browser cannot reach it directly
app.get("/camimg", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send("Mangler url");
  const decoded = decodeURIComponent(url);
  if (!decoded.startsWith("https://kamera.atlas.vegvesen.no") &&
      !decoded.startsWith("https://webkamera.vegvesen.no")) {
    return res.status(403).send("Forbudt domene");
  }
  try {
    const upstream = await fetch(decoded, {
      headers: {
        Authorization: `Basic ${DATEX_AUTH}`,
        "User-Agent": "Mozilla/5.0 oslo-ops-center/1.0",
        "Accept": "image/jpeg, image/*",
      },
    });
    if (!upstream.ok) return res.status(upstream.status).send(`Kamera ${upstream.status}`);
    const buf = await upstream.arrayBuffer();
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=30");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(Buffer.from(buf));
  } catch (e) {
    res.status(502).send("Kamera-henting feilet");
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ─── Catch-all → index.html ───────────────────────────────────────────────────
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log(`Oslo Ops Center running on http://localhost:${PORT}`));
