import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import { WebSocketServer, WebSocket as WS } from "ws";
import { createHash } from "crypto";

dotenv.config();
const app  = express();
const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Password protection ─────────────────────────────────────────────────────
const SITE_PASSWORD = process.env.SITE_PASSWORD || "";

function checkAuth(req, res, next) {
  if (!SITE_PASSWORD) return next(); // no password set — open access
  // Check cookie
  const cookies = Object.fromEntries(
    (req.headers.cookie || "").split(";").map(c => c.trim().split("=").map(decodeURIComponent))
  );
  const token = createHash("sha256").update(SITE_PASSWORD).digest("hex");
  if (cookies["auth"] === token) return next();
  // Not authenticated — serve login page
  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html><html><head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Oslo Ops Center — Login</title>
    <style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{background:#000;color:#00ff41;font-family:'Courier New',monospace;
        display:flex;align-items:center;justify-content:center;min-height:100vh}
      .box{border:1px solid #007a20;padding:40px;width:320px;text-align:center}
      .logo{font-size:18px;letter-spacing:4px;margin-bottom:8px;color:#00ff41}
      .sub{font-size:10px;color:#007a20;letter-spacing:3px;margin-bottom:32px}
      input{width:100%;background:#000;border:1px solid #007a20;color:#00ff41;
        padding:10px;font-family:'Courier New',monospace;font-size:14px;
        text-align:center;outline:none;margin-bottom:12px;letter-spacing:2px}
      input:focus{border-color:#00ff41;box-shadow:0 0 8px rgba(0,255,65,.3)}
      button{width:100%;background:rgba(0,255,65,.08);border:1px solid #007a20;
        color:#00ff41;padding:10px;font-family:'Courier New',monospace;font-size:12px;
        cursor:pointer;letter-spacing:3px;transition:all .15s}
      button:hover{background:rgba(0,255,65,.18);border-color:#00ff41}
      .err{color:#ff3838;font-size:11px;margin-top:8px;min-height:16px}
    </style>
  </head><body>
    <div class="box">
      <div class="logo">OSLO_OPS_CENTER</div>
      <div class="sub">RESTRICTED ACCESS</div>
      <form method="POST" action="/login">
        <input type="password" name="password" placeholder="ENTER PASSWORD" autofocus>
        <button type="submit">ACCESS SYSTEM</button>
        <div class="err">${req.query.err ? "INCORRECT PASSWORD" : ""}</div>
      </form>
    </div>
  </body></html>`);
}

app.use(express.urlencoded({ extended: false }));

app.post("/login", (req, res) => {
  const token = createHash("sha256").update(SITE_PASSWORD).digest("hex");
  if (req.body.password === SITE_PASSWORD) {
    res.setHeader("Set-Cookie", "auth=" + encodeURIComponent(token) + "; Path=/; HttpOnly; SameSite=Strict");
    res.redirect("/");
  } else {
    res.redirect("/?err=1");
  }
});

app.use(checkAuth);
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

// ─── Debug: all routes — lists every location name matched against travel data ─
app.get("/debug/allroutes", async (req, res) => {
  try {
    const [travelXml, locXml] = await Promise.all([
      datexGet("GetTravelTimeData"),
      datexGet("GetPredefinedTravelTimeLocations"),
    ]);

    const locMap = {};
    for (const m of locXml.matchAll(/<predefinedLocationReference[^>]+id="([^"]+)"[^>]*>([\s\S]*?)<\/predefinedLocationReference>/gi)) {
      const name = m[2].match(/<value[^>]*>([^<]+)<\/value>/i)?.[1]?.trim();
      if (name) locMap[m[1]] = name;
    }

    const seen = new Set();
    const lines = [];
    for (const m of travelXml.matchAll(/predefinedLocationReference[^>]+id="([^"]+)"/gi)) {
      const id = m[1];
      if (seen.has(id)) continue;
      seen.add(id);
      const name = locMap[id] || "(navn ikke funnet)";
      lines.push(id.padEnd(10) + " " + name);
    }

    lines.sort((a, b) => a.localeCompare(b, "no"));
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send("Totalt " + lines.length + " unike strekninger:\n\n" + lines.join("\n"));
  } catch (e) {
    res.status(502).send("Feil: " + e.message);
  }
});

// ─── Debug: all still cameras with IDs ───────────────────────────────────────
app.get("/debug/stillcams", async (req, res) => {
  try {
    const xml     = await datexGet("GetCCTVSiteTable");
    const lines   = [];
    const records = [...xml.matchAll(/<cctvCameraMetadataRecord[^>]*>([\s\S]*?)<\/cctvCameraMetadataRecord>/gi)];
    for (const m of records) {
      const block = m[1];
      const lat   = parseFloat(block.match(/<latitude>([^<]+)<\/latitude>/i)?.[1] || "0");
      const lon   = parseFloat(block.match(/<longitude>([^<]+)<\/longitude>/i)?.[1] || "0");
      if (!(lat > 59.5 && lat < 60.3 && lon > 10.1 && lon < 11.2)) continue;
      const id      = m[0].match(/id="([^"]+)"/)?.[1] || "?";
      const descB   = block.match(/<cctvCameraSiteLocalDescription[^>]*>([\s\S]*?)<\/cctvCameraSiteLocalDescription>/i)?.[1] || "";
      const name    = descB.match(/<value[^>]*>([^<]+)<\/value>/i)?.[1]?.trim() || id;
      const videoB  = block.match(/<cctvVideoService[^>]*>([\s\S]*?)<\/cctvVideoService>/i)?.[1] || "";
      const videoUrl= videoB.match(/<urlLinkAddress>([^<]+)<\/urlLinkAddress>/i)?.[1]?.trim() || "";
      const hasVideo= videoUrl && videoUrl.length > 5;
      if (!hasVideo) lines.push(id.padEnd(14) + " " + name);
    }
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send("Still cameras in Oslo area:\n\n" + lines.join("\n"));
  } catch(e) {
    res.status(502).send("Feil: " + e.message);
  }
});

// ─── Debug: which Oslo cameras have video streams ────────────────────────────
app.get("/debug/cameravideo", async (req, res) => {
  try {
    const xml = await datexGet("GetCCTVSiteTable");
    const lines = [];

    const records = [...xml.matchAll(/<cctvCameraMetadataRecord[^>]*>([\s\S]*?)<\/cctvCameraMetadataRecord>/gi)];

    for (const m of records) {
      const block = m[1];
      const lat  = parseFloat(block.match(/<latitude>([^<]+)<\/latitude>/i)?.[1] || "0");
      const lon  = parseFloat(block.match(/<longitude>([^<]+)<\/longitude>/i)?.[1] || "0");

      // Oslo area only
      if (!(lat > 59.5 && lat < 60.3 && lon > 10.1 && lon < 11.2)) continue;

      const id    = m[0].match(/id="([^"]+)"/)?.[1] || "?";
      const descB = block.match(/<cctvCameraSiteLocalDescription[^>]*>([\s\S]*?)<\/cctvCameraSiteLocalDescription>/i)?.[1] || "";
      const name  = descB.match(/<value[^>]*>([^<]+)<\/value>/i)?.[1]?.trim() || id;

      // Still image URL
      const stillB  = block.match(/<cctvStillImageService[^>]*>([\s\S]*?)<\/cctvStillImageService>/i)?.[1] || "";
      const stillUrl = stillB.match(/<urlLinkAddress>([^<]+)<\/urlLinkAddress>/i)?.[1]?.trim() || "(ingen)";

      // Video URL
      const videoB   = block.match(/<cctvVideoService[^>]*>([\s\S]*?)<\/cctvVideoService>/i)?.[1] || "";
      const videoUrl = videoB.match(/<urlLinkAddress>([^<]+)<\/urlLinkAddress>/i)?.[1]?.trim() || "(ingen)";
      const hasVideo = videoUrl && videoUrl !== "(ingen)" && videoUrl.length > 5;

      lines.push(`${hasVideo ? "✓ VIDEO" : "✗ bilde"} | ${name.padEnd(35)} | ${hasVideo ? videoUrl : stillUrl}`);
    }

    lines.sort((a, b) => b.startsWith("✓") - a.startsWith("✓") || a.localeCompare(b, "no"));
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    const sep = "=".repeat(80);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    const videoCount = lines.filter(l => l.startsWith("\u2713")).length;
    const imgCount   = lines.filter(l => l.startsWith("\u2717")).length;
    res.send("Oslo-kameraer med videofeed:\n" + sep + "\n" + lines.join("\n") + "\n\nTotalt: " + lines.length + " kameraer (" + videoCount + " med video, " + imgCount + " kun bilde)");
  } catch (e) {
    res.status(502).send("Feil: " + e.message);
  }
});


// ─── Debug: check env vars ────────────────────────────────────────────────────
app.get("/debug/env", (_req, res) => {
  res.json({
    GM_KEY_SET: !!process.env.GM_KEY,
    GM_KEY_LENGTH: (process.env.GM_KEY || "").length,
    GM_KEY_PREVIEW: (process.env.GM_KEY || "").slice(0, 8) + "...",
  });
});

// ─── Debug: road weather station IDs ─────────────────────────────────────────
app.get("/debug/roadweather", async (req, res) => {
  try {
    const xml = await datexGet("GetMeasuredWeatherData");
    const records = [...xml.matchAll(/<siteMeasurements[^>]*>([\s\S]*?)<\/siteMeasurements>/gi)];
    const lines = [];
    const seen = new Set();
    for (const rec of records) {
      const block = rec[1];
      const id = block.match(/measurementSiteReference[^>]+id="([^"]+)"/i)?.[1] || "?";
      if (seen.has(id)) continue;
      seen.add(id);
      const air  = block.match(/<airTemperature><temperature>([^<]+)<\/temperature>/i)?.[1];
      const road = block.match(/<roadSurfaceTemperature><temperature>([^<]+)<\/temperature>/i)?.[1];
      lines.push(id.padEnd(12) + " luft=" + (air||"—") + " vei=" + (road||"—"));
    }
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send("Station IDs (" + lines.length + "):\n\n" + lines.join("\n"));
  } catch(e) {
    res.status(502).send("Feil: " + e.message);
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
// Eksakte DATEX-ID-er bekreftet fra /debug/allroutes — kun Oslo-området
const OSLO_IDS = new Set([
  "100361", "100362", // Ammerud - Bjerke / Bjerke - Ammerud
  "100363", "100364", // Bjerke - Grefsen / Grefsen - Bjerke
  "100365", "100366", // Bjerke - Teisen / Teisen - Bjerke
  "100367", "100368", // Bjerke - Helsfyr / Helsfyr - Bjerke
  "100147", "100148", // Helsfyr - Ryen / Ryen - Helsfyr
  "100103", "100104", // Klemetsrud - Ryen / Ryen - Klemetsrud
  "100169", "100172", // Teisen - Ryen / Ryen - Teisen  (170=Teisen-Grefsen, 172=Teisen-Ryen)
  "100177", "100152", // Helsfyr - Karihaugen / Karihaugen - Helsfyr
  "100086", "100087", // Filipstad - Ryen / Ryen - Filipstad
  "100096", "100097", // Helsfyr - Filipstad / Filipstad - Helsfyr
  "100108", "100111", // Filipstad - Skøyen / Skøyen - Filipstad
  "100159", "100162", // Holmen - Sandvika / Sandvika - Holmen
  "100256", "100257", // Sandvika - Vøyenenga / Vøyenenga - Sandvika
  "100098", "100101", // Asker - Holmen / Holmen - Asker
  "100084", "100085", // Ullevål - Strand / Strand - Ullevål
  "100113", "100114", // Grefsen - Ullevål / Ullevål - Grefsen
  "100151", "100178", // Skedsmovollen - Karihaugen / Karihaugen - Skedsmovollen
  "100254", "100255", // Blåkollen - Lillestrømbrua / Lillestrømbrua - Blåkollen
]);

function isOslo(id) {
  return OSLO_IDS.has(id);
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

      // Filter to confirmed Oslo IDs
      if (!isOslo(id)) continue;

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
      if (imgUrl && lat > 59.5 && lat < 60.3 && lon > 10.1 && lon < 11.2) {
        cameras.push({ name, lat, lon, url: `/camimg?url=${encodeURIComponent(imgUrl)}` });
      }
    }

    console.log(`Kameraer i Oslo: ${cameras.length}`);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({ ok: true, count: cameras.length, cameras: cameras });
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

// ─── HLS video proxy ─────────────────────────────────────────────────────────
// Proxies m3u8 playlists AND .ts segments from kamera.vegvesen.no
// Rewrites m3u8 so segment URLs point back through our proxy
app.get("/videoproxy", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send("Mangler url");
  const decoded = decodeURIComponent(url);
  if (!decoded.startsWith("https://kamera.vegvesen.no")) {
    return res.status(403).send("Forbudt domene");
  }
  try {
    const upstream = await fetch(decoded, {
      headers: { Authorization: "Basic " + DATEX_AUTH, "User-Agent": "oslo-ops-center/1.0" }
    });
    if (!upstream.ok) return res.status(upstream.status).send("Video " + upstream.status);

    const ct = upstream.headers.get("content-type") || "";

    if (decoded.endsWith(".m3u8") || ct.includes("mpegurl") || ct.includes("x-mpegURL")) {
      // Rewrite m3u8: make all relative URLs absolute and route through proxy
      let text = await upstream.text();
      const base = decoded.substring(0, decoded.lastIndexOf("/") + 1);
      text = text.replace(/^(?!#)(.+\.ts.*)$/gm, (line) => {
        const absUrl = line.startsWith("http") ? line : base + line;
        return "/videoproxy?url=" + encodeURIComponent(absUrl);
      });
      text = text.replace(/^(?!#)(.+\.m3u8.*)$/gm, (line) => {
        const absUrl = line.startsWith("http") ? line : base + line;
        return "/videoproxy?url=" + encodeURIComponent(absUrl);
      });
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "no-cache");
      return res.send(text);
    }

    // .ts video segments — pipe through as-is
    const buf = await upstream.arrayBuffer();
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "video/MP2T");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=5");
    res.send(Buffer.from(buf));
  } catch (e) {
    res.status(502).send("Video proxy feil: " + e.message);
  }
});

// ─── Camera list with video flag ──────────────────────────────────────────────
// Returns both still image URL and video proxy URL if available
app.get("/camerasfull", async (req, res) => {
  try {
    const xml     = await datexGet("GetCCTVSiteTable");
    const cameras = [];
    const records = [...xml.matchAll(/<cctvCameraMetadataRecord[^>]*>([\s\S]*?)<\/cctvCameraMetadataRecord>/gi)];

    for (const m of records) {
      const block = m[1];
      const lat   = parseFloat(block.match(/<latitude>([^<]+)<\/latitude>/i)?.[1] || "0");
      const lon   = parseFloat(block.match(/<longitude>([^<]+)<\/longitude>/i)?.[1] || "0");
      if (!(lat > 59.5 && lat < 60.3 && lon > 10.1 && lon < 11.2)) continue;

      const descB  = block.match(/<cctvCameraSiteLocalDescription[^>]*>([\s\S]*?)<\/cctvCameraSiteLocalDescription>/i)?.[1] || "";
      const name   = descB.match(/<value[^>]*>([^<]+)<\/value>/i)?.[1]?.trim() || "Kamera";

      const stillB   = block.match(/<cctvStillImageService[^>]*>([\s\S]*?)<\/cctvStillImageService>/i)?.[1] || "";
      const stillUrl = stillB.match(/<urlLinkAddress>([^<]+)<\/urlLinkAddress>/i)?.[1]?.trim() || "";

      const videoB   = block.match(/<cctvVideoService[^>]*>([\s\S]*?)<\/cctvVideoService>/i)?.[1] || "";
      const videoUrl = videoB.match(/<urlLinkAddress>([^<]+)<\/urlLinkAddress>/i)?.[1]?.trim() || "";
      const hasVideo = videoUrl && videoUrl.length > 5;

      cameras.push({
        name,
        lat,
        lon,
        imgUrl:   stillUrl ? "/camimg?url=" + encodeURIComponent(stillUrl) : null,
        videoUrl: hasVideo  ? "/videoproxy?url=" + encodeURIComponent(videoUrl) : null,
      });
    }


    const EXCLUDE = [
      "tangen fjordpark","åneby nord","romerikåsen","kløfta","olum",
      "smaalenes bru","hurum","stryken","råken","bogen","svartskog",
      "randselva bru","hanekleiva","storsand","holdstad","andelva","støkken"
    ];
    const filtered = cameras.filter(c =>
      !EXCLUDE.some(ex => c.name.toLowerCase().includes(ex))
    );

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({ ok: true, count: filtered.length, cameras: filtered });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message, cameras: [] });
  }
});

// ─── No-cache middleware for all /api routes ─────────────────────────────────
app.use(["/api", "/travel", "/incidents", "/cameras", "/camerasfull", "/roadweather", "/datex", "/rss"], (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  next();
});

// ─── Politiloggen — offisielt RSS API (oppdatert 11. mai 2026) ───────────────
// Correct URL confirmed: api.politiet.no/politiloggen/v1/rss?distrikt=oslo
// (returns 429 when rate-limited, which proves the URL is valid)
let politiCache = { items: [], time: 0 };

app.get("/api/politiloggen", async (req, res) => {
  // Serve from cache if fetched within last 4 minutes (avoids 429 rate-limiting)
  const now = Date.now();
  if (politiCache.items.length && (now - politiCache.time) < 240000) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.json({ ok: true, items: politiCache.items, cached: true });
  }

  try {
    const rssUrl = "https://api.politiloggen.politiet.no/feeds/rss?districts=Oslo";
    const r = await fetch(rssUrl, {
      headers: { "User-Agent": "oslo-ops-center/1.0 (osloops.xyz)", "Accept": "application/rss+xml, application/xml, text/xml" },
      signal: AbortSignal.timeout(8000),
    });

    if (r.status === 429) {
      // Rate limited — serve stale cache if we have it
      console.log("Politiloggen 429 (rate limited) — bruker cache");
      if (politiCache.items.length) {
        res.setHeader("Access-Control-Allow-Origin", "*");
        return res.json({ ok: true, items: politiCache.items, cached: true });
      }
      throw new Error("Rate limited av politiet.no, prøv igjen senere");
    }

    if (!r.ok) throw new Error("Politiet API svarte " + r.status);

    const xml   = await r.text();
    const items = parseRssItems(xml, 10).map(m => ({
      ...m,
      category: (m.title || "").match(/^([^:,]{3,30}):/)?.[1]?.trim() || "",
      url:      m.url || "https://www.politiet.no/politiloggen?distrikt=oslo",
    }));

    if (!items.length) throw new Error("Ingen meldinger i RSS");

    politiCache = { items, time: now };
    console.log("Politiloggen OK: " + items.length + " meldinger");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({ ok: true, items });
  } catch (e) {
    console.error("Politiloggen error:", e.message);
    // Serve stale cache on error if available
    if (politiCache.items.length) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.json({ ok: true, items: politiCache.items, cached: true });
    }
    res.status(502).json({ ok: false, error: e.message, items: [] });
  }
});

// ─── Politiloggen — offisielt RSS API (oppdatert 11. mai 2026) ───────────────
app.get("/api/politiloggen", async (req, res) => {
  try {
    // New RSS URL format from politiet.no/rss (updated May 11, 2026)
    // The URL is generated dynamically — try all known variants
    const rssUrls = [
      "https://api.politiet.no/politiloggen/v1/rss?districts=oslo&pageSize=10",
      "https://api.politiet.no/politiloggen/v1/rss?districts=Oslo&pageSize=10",
      "https://api.politiet.no/politiloggen/v1/rss?district=oslo",
      "https://api.politiet.no/politiloggen/v1/rss?distrikt=oslo",
      "https://api.politiet.no/politiloggen/v1/rss?distrikt=Oslo",
      "https://api.politiet.no/politiloggen/v2/rss?districts=oslo",
      "https://api.politiloggen.politiet.no/v1/rss?districts=oslo",
      "https://api.politiloggen.politiet.no/v2/rss?districts=oslo",
    ];

    for (const rssUrl of rssUrls) {
      try {
        const r = await fetch(rssUrl, {
          headers: {
            "User-Agent": "oslo-ops-center/1.0",
            "Accept": "application/rss+xml, application/xml, text/xml",
          },
          signal: AbortSignal.timeout(5000),
        });
        if (!r.ok) { console.log("Politiloggen " + r.status + ": " + rssUrl); continue; }
        const xml   = await r.text();
        const items = parseRssItems(xml, 10).map(m => ({
          ...m,
          category: (m.title || "").match(/^([^:,]{3,30}):/)?.[1]?.trim() || "",
          url:      m.url || "https://www.politiet.no/politiloggen?distrikt=oslo",
        }));
        if (items.length) {
          console.log("Politiloggen OK (" + items.length + " meldinger): " + rssUrl);
          res.setHeader("Access-Control-Allow-Origin", "*");
          return res.json({ ok: true, items });
        }
        console.log("Politiloggen 0 items: " + rssUrl);
      } catch(e) { console.log("Politiloggen feil " + rssUrl + ": " + e.message); }
    }

    throw new Error("Alle RSS-URLer feilet — sjekk politiet.no/rss for ny URL");
  } catch (e) {
    console.error("Politiloggen error:", e.message);
    res.status(502).json({ ok: false, error: e.message, items: [] });
  }
});

// ─── Politiloggen — offisielt RSS API ────────────────────────────────────────
app.get("/api/politiloggen", async (req, res) => {
  try {
    // Try official RSS endpoints
    const rssUrls = [
      "https://api.politiloggen.politiet.no/v1/rss?districts=oslo",
      "https://api.politiet.no/politiloggen/v1/rss?districts=oslo",
      "https://api.politiet.no/politiloggen/v1/rss?districts=Oslo",
    ];

    for (const rssUrl of rssUrls) {
      try {
        const r = await fetch(rssUrl, {
          headers: { "User-Agent": "oslo-ops-center/1.0", "Accept": "application/rss+xml, text/xml" },
          signal: AbortSignal.timeout(5000),
        });
        if (!r.ok) { console.log("Politiloggen RSS " + rssUrl + " svarte " + r.status); continue; }
        const xml   = await r.text();
        const items = parseRssItems(xml, 10).map(m => ({
          ...m,
          category: (m.title || "").match(/^([^:,]{3,30}):/)?.[1]?.trim() || "",
          url:      m.url || "https://www.politiet.no/politiloggen?distrikt=oslo",
        }));
        if (items.length) {
          console.log("Politiloggen RSS OK: " + items.length + " meldinger fra " + rssUrl);
          res.setHeader("Access-Control-Allow-Origin", "*");
          return res.json({ ok: true, items });
        }
      } catch(e) { console.log("Politiloggen RSS feil " + rssUrl + ": " + e.message); }
    }

    // Fallback: scrape HTML page
    const page = await fetch("https://www.politiet.no/politiloggen?distrikt=oslo", {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; oslo-ops-center/1.0)", "Accept": "text/html" }
    });
    if (!page.ok) throw new Error("politiet.no svarte " + page.status);
    const html = await page.text();

    // Try __NEXT_DATA__
    const ndMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (ndMatch) {
      const nd = JSON.parse(ndMatch[1]);
      const pp = nd?.props?.pageProps;
      const messages = pp?.messages || pp?.initialMessages ||
        pp?.dehydratedState?.queries?.[0]?.state?.data?.pages?.[0]?.messages || [];
      if (messages.length) {
        const items = messages.slice(0, 10).map(m => ({
          title:    m.title || m.header || m.message || "(ingen tittel)",
          date:     m.publishedAt || m.createdAt || m.updatedAt || "",
          category: m.category || m.tema || "",
          url:      m.id ? "https://www.politiet.no/politiloggen/hendelse/" + m.id
                         : "https://www.politiet.no/politiloggen?distrikt=oslo",
        }));
        console.log("Politiloggen Next.js: " + items.length + " meldinger");
        res.setHeader("Access-Control-Allow-Origin", "*");
        return res.json({ ok: true, items });
      }
    }

    throw new Error("Ingen meldinger funnet — politiet.no kan ha endret struktur");
  } catch (e) {
    console.error("Politiloggen error:", e.message);
    res.status(502).json({ ok: false, error: e.message, items: [] });
  }
});

// ─── Politiloggen — scraper politiet.no/politiloggen direkte ─────────────────
app.get("/api/politiloggen", async (req, res) => {
  try {
    // Fetch the politiloggen page and parse the Next.js __NEXT_DATA__ JSON
    // which contains the actual log entries server-rendered into the page
    const page = await fetch("https://www.politiet.no/politiloggen?distrikt=oslo", {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; oslo-ops-center/1.0)",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "no,en;q=0.9",
      }
    });
    if (!page.ok) throw new Error("politiet.no svarte " + page.status);
    const html = await page.text();

    // Extract __NEXT_DATA__ JSON blob embedded in the page
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (nextDataMatch) {
      const nextData = JSON.parse(nextDataMatch[1]);
      // Navigate to the messages array — path varies by Next.js version
      const pageProps = nextData?.props?.pageProps;
      const messages  = pageProps?.messages || pageProps?.initialMessages ||
                        pageProps?.dehydratedState?.queries?.[0]?.state?.data?.pages?.[0]?.messages || [];
      if (messages.length) {
        const items = messages.slice(0, 10).map(m => {
          const id  = m.id || m.slug || "";
          const url = id
            ? "https://www.politiet.no/politiloggen/hendelse/" + id
            : "https://www.politiet.no/politiloggen?distrikt=oslo";
          return {
            title:    m.title || m.header || m.message || "(ingen tittel)",
            date:     m.publishedAt || m.createdAt || m.updatedAt || "",
            category: m.category || m.tema || "",
            url,
          };
        });
        console.log("Politiloggen Next.js data: " + items.length + " meldinger");
        res.setHeader("Access-Control-Allow-Origin", "*");
        return res.json({ ok: true, items });
      }
    }

    // Fallback: try multiple HTML patterns for politiet.no
    const items = [];

    // Try __NEXT_DATA__ first (already tried above, try again with different paths)
    const jsonMatches = [...html.matchAll(/"title"\s*:\s*"([^"]{10,200})"/g)];
    const timeMatches = [...html.matchAll(/"(20\d{2}-\d{2}-\d{2}T[^"]+)"/g)];

    // Try to find log entries via common patterns in the HTML
    const patterns = [
      /<h[1-4][^>]*>([^<]{15,200})<\/h[1-4]>/gi,
      /<p[^>]*class="[^"]*title[^"]*"[^>]*>([^<]{10,200})<\/p>/gi,
      /<span[^>]*class="[^"]*title[^"]*"[^>]*>([^<]{10,200})<\/span>/gi,
      /data-testid="[^"]*title[^"]*"[^>]*>([^<]{10,200})</gi,
    ];

    for (const pattern of patterns) {
      const matches = [...html.matchAll(pattern)].slice(0, 10);
      for (const m of matches) {
        const title = m[1].replace(/<[^>]+>/g, "").trim();
        if (title.length > 10 && !title.includes("politiet.no") && !title.includes("cookie")) {
          const catM = title.match(/^([^:,]{3,30}):/);
          items.push({
            title,
            date: "",
            category: catM ? catM[1].trim() : "",
            url: "https://www.politiet.no/politiloggen?distrikt=oslo"
          });
        }
      }
      if (items.length >= 5) break;
    }

    if (!items.length) throw new Error("Fant ingen hendelser på siden");
    console.log("Politiloggen HTML-parse: " + items.length + " meldinger");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({ ok: true, items });
  } catch (e) {
    console.error("Politiloggen error:", e.message);
    res.status(502).json({ ok: false, error: e.message, items: [] });
  }
});

// ─── Helper: parse RSS item tags safely ──────────────────────────────────────
function rssTag(block, tagName) {
  // Try CDATA first, then plain text
  const cdataRe = new RegExp('<' + tagName + '[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/' + tagName + '>', 'i');
  const plainRe = new RegExp('<' + tagName + '[^>]*>([^<]*)<\\/' + tagName + '>', 'i');
  const m = block.match(cdataRe) || block.match(plainRe);
  return m ? m[1].trim() : '';
}

function parseRssItems(xml, limit) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) !== null && items.length < limit) {
    const b = m[1];
    const title = rssTag(b, 'title');
    if (title) {
      items.push({
        title,
        date:   rssTag(b, 'pubDate'),
        url:    rssTag(b, 'link') || rssTag(b, 'guid'),
        desc:   rssTag(b, 'description'),
      });
    }
  }
  return items;
}

// ─── VG Nyheter RSS ───────────────────────────────────────────────────────────
app.get("/api/vgnyheter", async (req, res) => {
  try {
    const upstream = await fetch("https://vg.no/rss/feed/?format=rss", {
      headers: { "User-Agent": "oslo-ops-center/1.0", "Accept": "application/rss+xml, text/xml" }
    });
    if (!upstream.ok) throw new Error("VG svarte " + upstream.status);
    const xml   = await upstream.text();
    const items = parseRssItems(xml, 10);
    console.log("VG nyheter: " + items.length + " saker");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({ ok: true, items });
  } catch (e) {
    console.error("VG error:", e.message);
    res.status(502).json({ ok: false, error: e.message, items: [] });
  }
});

// ─── NRK RSS ──────────────────────────────────────────────────────────────────
app.get("/api/dagbladet", async (req, res) => {
  try {
    const upstream = await fetch("https://www.nrk.no/toppsaker.rss", {
      headers: { "User-Agent": "oslo-ops-center/1.0", "Accept": "application/rss+xml, text/xml" }
    });
    if (!upstream.ok) throw new Error("NRK svarte " + upstream.status);
    const items = parseRssItems(await upstream.text(), 10);
    console.log("NRK: " + items.length + " saker");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({ ok: true, items });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message, items: [] });
  }
});

// ─── Nettavisen RSS ───────────────────────────────────────────────────────────
app.get("/api/nettavisen", async (req, res) => {
  try {
    const upstream = await fetch("https://e24.no/rss", {
      headers: { "User-Agent": "oslo-ops-center/1.0", "Accept": "application/rss+xml, text/xml" }
    });
    if (!upstream.ok) throw new Error("Nettavisen svarte " + upstream.status);
    const items = parseRssItems(await upstream.text(), 10);
    console.log("E24: " + items.length + " saker");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({ ok: true, items });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message, items: [] });
  }
});

// ─── Aftenposten RSS ──────────────────────────────────────────────────────────
app.get("/api/aftenposten", async (req, res) => {
  try {
    const upstream = await fetch("https://www.aftenposten.no/rss", {
      headers: { "User-Agent": "oslo-ops-center/1.0", "Accept": "application/rss+xml, text/xml" }
    });
    if (!upstream.ok) throw new Error("Aftenposten svarte " + upstream.status);
    const items = parseRssItems(await upstream.text(), 10);
    console.log("Aftenposten: " + items.length + " saker");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({ ok: true, items });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message, items: [] });
  }
});

// ─── TV2 RSS ──────────────────────────────────────────────────────────────────
app.get("/api/tv2", async (req, res) => {
  try {
    const upstream = await fetch("https://www.tv2.no/rss/nyheter", {
      headers: { "User-Agent": "oslo-ops-center/1.0", "Accept": "application/rss+xml, text/xml" }
    });
    if (!upstream.ok) throw new Error("TV2 svarte " + upstream.status);
    const items = parseRssItems(await upstream.text(), 10);
    console.log("TV2: " + items.length + " saker");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({ ok: true, items });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message, items: [] });
  }
});

// ─── Ambassade-nyhetsvarsel ────────────────────────────────────────────────────
// Søker RSS-feeds fra de siste 7 dagene (RSS inneholder typisk siste 30-50 saker)
const EMBASSY_KEYWORDS = [
  "amerikanske ambassaden", "amerikas ambassade", "usas ambassade",
  "den amerikanske ambassaden", "usa-ambassaden", "us-ambassaden",
  "american embassy", "us embassy oslo",
];

const NEWS_FEEDS = [
  "https://vg.no/rss/feed/?format=rss",
  "https://www.aftenposten.no/rss",
  "https://www.nrk.no/toppsaker.rss",
  "https://www.dagbladet.no/rss",
  "https://www.tv2.no/rss/nyheter",
  "https://e24.no/rss",
];

app.get("/api/ambassade", async (req, res) => {
  const results = [];
  await Promise.allSettled(NEWS_FEEDS.map(async feedUrl => {
    try {
      const r = await fetch(feedUrl, {
        headers: { "User-Agent": "oslo-ops-center/1.0", "Accept": "application/rss+xml, text/xml" },
        signal: AbortSignal.timeout(6000),
      });
      if (!r.ok) return;
      const xml    = await r.text();
      const source = feedUrl.match(/\/\/(www\.)?([^/]+)/)?.[2] || feedUrl;
      const items  = parseRssItems(xml, 100);
      for (const item of items) {
        const combined = (item.title + " " + item.desc).toLowerCase();
        if (EMBASSY_KEYWORDS.some(kw => combined.includes(kw))) {
          results.push({ title: item.title, date: item.date, url: item.url, source });
        }
      }
    } catch (_) {}
  }));
  results.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  console.log("Ambassade-varsel: " + results.length + " treff");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json({ ok: true, count: results.length, items: results.slice(0, 15) });
});


// ─── Google Maps key endpoint ────────────────────────────────────────────────
app.get("/api/gmkey", (_req, res) => {
  const key = process.env.GM_KEY || "";
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json({ key });
});

// ─── Road conditions (DATEX GetMeasuredWeatherData) ──────────────────────────
// Confirmed structure: <airTemperature><temperature>5.6</temperature>
//                      <roadSurfaceTemperature><temperature>0.0</temperature>
//                      <millimetresPerHourIntensity>0.0</millimetresPerHourIntensity>
//                      <windSpeed><windSpeed>0.0</windSpeed>
app.get("/roadweather", async (req, res) => {
  try {
    const xml = await datexGet("GetMeasuredWeatherData");
    const results = [];
    const records = [...xml.matchAll(/<siteMeasurements[^>]*>([\s\S]*?)<\/siteMeasurements>/gi)];

    for (const rec of records) {
      const block = rec[1];
      // ID is in measurementSiteReference id attribute
      const ref = block.match(/measurementSiteReference[^>]+id="([^"]+)"/i)?.[1] || "";

      const airTemp  = block.match(/<airTemperature><temperature>([^<]+)<\/temperature>/i)?.[1];
      const roadTemp = block.match(/<roadSurfaceTemperature><temperature>([^<]+)<\/temperature>/i)?.[1];
      const precip   = block.match(/<millimetresPerHourIntensity>([^<]+)<\/millimetresPerHourIntensity>/i)?.[1];
      const wind     = block.match(/<windSpeed><windSpeed>([^<]+)<\/windSpeed>/i)?.[1];
      const humidity = block.match(/<relativeHumidity><percentage>([^<]+)<\/percentage>/i)?.[1];
      const roadCond = block.match(/<weatherRelatedRoadConditionType>([^<]+)<\/weatherRelatedRoadConditionType>/i)?.[1];

      if (ref && (airTemp || roadTemp)) {
        results.push({ ref, airTemp, roadTemp, precip, wind, humidity, roadCond });
      }
    }

    const withRoad = results.filter(s => s.roadTemp);
    const display  = (withRoad.length >= 4 ? withRoad : results).slice(0, 6);
    console.log("Road weather: " + results.length + " stasjoner, " + withRoad.length + " med veitemp");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({ ok: true, count: display.length, stations: display });
  } catch (e) {
    console.error("Road weather error:", e.message);
    res.status(502).json({ ok: false, error: e.message, stations: [] });
  }
});

// ─── OpenSky Network flight data proxy ───────────────────────────────────────
app.get("/api/flights", async (req, res) => {
  try {
    const { lamin, lamax, lomin, lomax } = req.query;

    // Try OpenSky first
    try {
      const r = await fetch(
        "https://opensky-network.org/api/states/all?lamin=" + lamin + "&lamax=" + lamax + "&lomin=" + lomin + "&lomax=" + lomax,
        { headers: { "User-Agent": "oslo-ops-center/1.0" }, signal: AbortSignal.timeout(15000) }
      );
      if (r.ok) {
        const data = await r.json();
        console.log("Flights (OpenSky): " + (data.states?.length || 0) + " aircraft");
        res.setHeader("Access-Control-Allow-Origin", "*");
        return res.json(data);
      }
    } catch(_) {}

    // Fallback: ADS-B lol (free, no key needed)
    const r2 = await fetch(
      "https://api.adsb.lol/v2/lat/59.913/lon/10.752/dist/300",
      { headers: { "User-Agent": "oslo-ops-center/1.0" }, signal: AbortSignal.timeout(10000) }
    );
    if (!r2.ok) throw new Error("ADS-B lol svarte " + r2.status);
    const d = await r2.json();
    // Convert to OpenSky format
    const states = (d.ac || []).map(a => [
      a.hex, a.flight||a.hex, "", 0, 0, a.lon, a.lat, a.alt_baro||0, false,
      a.gs ? a.gs/3.6 : 0, a.track||0, 0, null, null, "", false, 0
    ]);
    console.log("Flights (ADS-B lol): " + states.length + " aircraft");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({ states });
  } catch (e) {
    console.error("Flights error:", e.message);
    res.status(502).json({ states: [], error: e.message });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok" }));


// ─── Blitzortung WebSocket proxy ─────────────────────────────────────────────
// Proxies wss://ws1.blitzortung.org:3000 → wss://osloops.xyz/ws/lightning
// This bypasses Cloudflare's port 3000 block
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (clientWS) => {
  const servers = ["ws1","ws3","ws5","ws7"];
  const server  = servers[Math.floor(Math.random() * servers.length)];
  const upstream = new WS("wss://" + server + ".blitzortung.org:3000/");

  upstream.on("open", () => {
    console.log("Blitzortung proxy connected: " + server);
    // No subscription needed — server streams data automatically after connect
  });

  let msgCount = 0;
  upstream.on("message", (data) => {
    if (msgCount < 3) { console.log("Blitzortung msg " + msgCount + ":", data.toString().slice(0, 100)); msgCount++; }
    if (clientWS.readyState === WS.OPEN) clientWS.send(data);
  });

  upstream.on("close", () => clientWS.close());
  upstream.on("error", (e) => { console.log("Blitzortung upstream error:", e.message, e.code); clientWS.close(); });

  clientWS.on("close", () => upstream.close());
  clientWS.on("message", (data) => { if (upstream.readyState === WS.OPEN) upstream.send(data); });
});

// ─── Catch-all → index.html (injects GM key from env) ───────────────────────
let _indexHtml = null;
function getIndex() {
  if (!_indexHtml) _indexHtml = readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
  return _indexHtml;
}
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const server = app.listen(PORT, () => console.log(`Oslo Ops Center running on http://localhost:${PORT}`));

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/ws/lightning") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});
