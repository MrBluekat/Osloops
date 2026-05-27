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

    // Fallback: parse rendered HTML — extract article/section headings
    const items = [];
    // Match pattern: "Tema: Sted time Description"
    const articlePattern = /<article[^>]*>([\s\S]*?)<\/article>/gi;
    const articles = [...html.matchAll(articlePattern)].slice(0, 10);
    for (const a of articles) {
      const text = a[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      const titleM = a[1].match(/<h[123][^>]*>([^<]+)<\/h[123]>/i);
      const title = titleM ? titleM[1].trim() : text.slice(0, 100);
      const timeM = text.match(/(\d{1,2}:\d{2})/);
      const catM  = title.match(/^([^:,]+):/);
      if (title.length > 5) {
        items.push({ title, date: timeM ? timeM[1] : "", category: catM ? catM[1].trim() : "", url: "https://www.politiet.no/politiloggen?distrikt=oslo" });
      }
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

// ─── VG Nyheter RSS ───────────────────────────────────────────────────────────
app.get("/api/vgnyheter", async (req, res) => {
  try {
    const upstream = await fetch("https://vg.no/rss/feed/?format=rss", {
      headers: { "User-Agent": "oslo-ops-center/1.0", "Accept": "application/rss+xml, text/xml" }
    });
    if (!upstream.ok) throw new Error("VG svarte " + upstream.status);
    const xml  = await upstream.text();
    const items = [];
    for (const m of [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0, 10)) {
      const b = m[1];
      const tag = t => {
        const r = b.match(new RegExp("<" + t + "[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/" + t + ">")) ||
                  b.match(new RegExp("<" + t + "[^>]*>([\s\S]*?)<\/" + t + ">"));
        return r ? r[1].trim() : "";
      };
      const title = tag("title");
      if (title) items.push({ title, date: tag("pubDate"), url: tag("link") || tag("guid") });
    }
    console.log("VG nyheter: " + items.length + " saker");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({ ok: true, items });
  } catch (e) {
    console.error("VG error:", e.message);
    res.status(502).json({ ok: false, error: e.message, items: [] });
  }
});

// ─── Ambassade-nyhetsvarsel — søker i norske RSS-feeds ────────────────────────
const EMBASSY_KEYWORDS = [
  "amerikanske ambassaden", "amerikas ambassade", "usas ambassade",
  "den amerikanske ambassaden", "usa-ambassaden", "us-ambassaden",
  "american embassy", "us embassy oslo"
];

const NEWS_FEEDS = [
  "https://vg.no/rss/feed/?format=rss",
  "https://www.aftenposten.no/rss",
  "https://www.nrk.no/toppsaker.rss",
  "https://www.dagbladet.no/feed/rss",
  "https://www.tv2.no/rss",
  "https://www.nettavisen.no/rss.xml",
];

app.get("/api/ambassade", async (req, res) => {
  const results = [];
  await Promise.allSettled(NEWS_FEEDS.map(async feedUrl => {
    try {
      const r = await fetch(feedUrl, {
        headers: { "User-Agent": "oslo-ops-center/1.0", "Accept": "application/rss+xml, text/xml" },
        signal: AbortSignal.timeout(5000)
      });
      if (!r.ok) return;
      const xml = await r.text();
      const source = feedUrl.match(/\/\/(www\.)?([^/]+)/)?.[2] || feedUrl;
      for (const m of [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)]) {
        const b = m[1];
        const tag = t => {
          const r2 = b.match(new RegExp("<" + t + "[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/" + t + ">")) ||
                     b.match(new RegExp("<" + t + "[^>]*>([\s\S]*?)<\/" + t + ">"));
          return r2 ? r2[1].trim() : "";
        };
        const title = tag("title");
        const desc  = tag("description");
        const combined = (title + " " + desc).toLowerCase();
        if (EMBASSY_KEYWORDS.some(kw => combined.includes(kw))) {
          results.push({
            title,
            date:   tag("pubDate"),
            url:    tag("link") || tag("guid"),
            source,
          });
        }
      }
    } catch (_) {}
  }));
  // Sort newest first
  results.sort((a, b) => new Date(b.date||0) - new Date(a.date||0));
  console.log("Ambassade-varsel: " + results.length + " treff");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json({ ok: true, count: results.length, items: results.slice(0, 10) });
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ─── Catch-all → index.html ───────────────────────────────────────────────────
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log(`Oslo Ops Center running on http://localhost:${PORT}`));
