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

  // Whitelist check — never proxy arbitrary URLs
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
    res.setHeader("Access-Control-Allow-Origin", "*"); // safe — public traffic data
    res.send(xml);
  } catch (err) {
    console.error("DATEX fetch error:", err.message);
    res.status(502).json({ error: "Could not reach Vegvesen DATEX server" });
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
