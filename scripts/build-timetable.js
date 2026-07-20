// Rebuilds data/timetable.json from JR East's official station timetable
// pages (https://timetables.jreast.co.jp/). Run with: node scripts/build-timetable.js
//
// This re-derives everything from scratch each run (no incremental state),
// so it stays correct across JR's annual dia revisions (usually mid-March)
// without needing manual updates to this script — only the STATIONS table
// below would need touching if JR renumbers a station's timetable pages.
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");

const OUT_PATH = path.join(__dirname, "..", "data", "timetable.json");

// South order: index ascending = further south/toward Yokohama.
const STATIONS = ["ueno", "tokyo", "shimbashi", "shinagawa", "kawasaki", "yokohama"];
const STATION_LABELS = {
  ueno: "上野",
  tokyo: "東京",
  shimbashi: "新橋",
  shinagawa: "品川",
  kawasaki: "川崎",
  yokohama: "横浜",
};

// Per-station JR East timetable page codes, discovered by browsing
// https://timetables.jreast.co.jp/timetable/list<code>.html for each station
// and reading off the direction-specific sub-page codes. Only the directions
// that are actually usable are listed (e.g. Ueno is the northern end of our
// shared segment, so it only needs its southbound page).
// Each direction code is the 2-digit prefix shared by the weekday/weekend
// page pair, e.g. shinagawa keihinTohoku south "09" -> 0788090.html (weekday)
// / 0788091.html (weekend).
const STATION_PAGES = {
  ueno: { code: "0204", keihinTohoku: { south: "12" }, tokaido: { south: "14" } },
  tokyo: { code: "1039", keihinTohoku: { south: "14", north: "15" }, tokaido: { south: "10", north: "16" } },
  shimbashi: { code: "0877", keihinTohoku: { south: "07", north: "08" }, tokaido: { south: "01", north: "02" } },
  shinagawa: { code: "0788", keihinTohoku: { south: "09", north: "10" }, tokaido: { south: "03", north: "04" } },
  kawasaki: { code: "0526", keihinTohoku: { south: "04", north: "05" }, tokaido: { south: "01", north: "02" } },
  yokohama: { code: "1638", keihinTohoku: { north: "09" }, tokaido: { north: "02" } },
};

// How far a given destination code actually reaches, expressed as a position
// on the STATIONS index line (fractional values sit between two selectable
// stations, e.g. Kamata/蒲田 is between shinagawa(3) and kawasaki(4)). For
// "south" this is the furthest-south index reached (train reaches TO if
// toIdx <= reach); for "north" it's the furthest-north index reached (train
// reaches TO if toIdx >= reach). +-99 means "far beyond our station range".
const DEST_REACH = {
  keihinTohoku: {
    south: { "蒲": 3.5, "鶴": 4.3, "神": 4.6, "無印": 99, "磯": 99, "桜": 99 },
    north: { "蒲": 3.5, "無印": -99, "浦": -99, "赤": -99, "上": 0 },
  },
  tokaido: {
    south: { "無印": 3, "熱": 99, "小": 99, "平": 99, "国": 99, "下": 99, "伊": 99, "沼": 99, "修": 99, "出": 99, "高": 99, "琴": 99 },
    north: { "品": 3, "東": 1, "無印": -99, "宇": -99, "金": -99, "籠": -99, "上": 0, "古": -99, "前": -99 },
  },
};

function get(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          res.resume();
          return;
        }
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(data));
      })
      .on("error", reject);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function toMin(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function parseDepartureList(html) {
  const trains = [];
  const rows = html.split(/<tr id="time_(\d+)">/).slice(1);
  for (let i = 0; i < rows.length; i += 2) {
    const hour = parseInt(rows[i], 10);
    const body = rows[i + 1];
    const blocks = body.split('<div class="timetable_time"').slice(1);
    for (const b of blocks) {
      const destMatch = b.match(/data-dest="([^"]*)"/);
      const trainMatch = b.match(/data-train="([^"]*)"/);
      const minMatch = b.match(/<span class="minute">(\d{1,2})<\/span>/);
      const linkMatch = b.match(/href="(\.\.\/\.\.\/train\/[^"]+)"/);
      if (!minMatch || !linkMatch) continue;
      trains.push({
        hour,
        minute: parseInt(minMatch[1], 10),
        dest: destMatch ? destMatch[1] : "",
        train: trainMatch ? trainMatch[1] : "",
        link: linkMatch[1].replace("../../train/", ""),
      });
    }
  }
  // JR lists post-midnight departures under id="time_0", always trailing
  // after time_23 (service never actually starts at 0時). Normalize to 24+
  // so ordering/comparison stays chronological.
  for (const t of trains) {
    if (t.hour === 0) t.hour = 24;
  }
  return trains;
}

function filterTrains(lineKey, trains) {
  if (lineKey === "tokaido") {
    // Plain local (普通) only — 快速/特別快速/特急 etc can skip stations we
    // care about (e.g. 特別快速 skips 新橋・川崎), too risky to mix in.
    return trains.filter((t) => t.train === "無印");
  }
  return trains;
}

function sampleByHour(list) {
  const byHour = {};
  for (const t of list) {
    if (!(t.hour in byHour)) byHour[t.hour] = t;
  }
  return Object.values(byHour);
}

function extractAllStopTimes(html) {
  const rows = html.split(/<tr class="time">/).slice(1);
  const times = {};
  for (const r of rows) {
    const stMatch = r.match(/list\d+\.html">([^<]+)</);
    if (!stMatch) continue;
    const timeMatch = r.match(/(\d{1,2}:\d{2})\s*(発|着)/);
    if (timeMatch) times[stMatch[1]] = timeMatch[1];
  }
  return times;
}

// Fetches one representative train per hour bucket and records how many
// minutes later it reaches every other shared station it stops at. Travel
// time isn't constant across the day (rush hour dwell adds a couple of
// minutes), so this is calibrated per hour rather than once globally.
async function calibrateOffsets(fromStation, weekdayTrains) {
  const fromLabel = STATION_LABELS[fromStation];
  const samples = sampleByHour(weekdayTrains);
  const offsetsByHour = {};
  for (const t of samples) {
    const html = await get(`https://timetables.jreast.co.jp/2607/train/${t.link}`);
    const times = extractAllStopTimes(html);
    const fromTime = times[fromLabel];
    if (!fromTime) {
      await sleep(200);
      continue;
    }
    const fromMin = toMin(fromTime);
    const offsets = {};
    for (const stKey of STATIONS) {
      if (stKey === fromStation) continue;
      const label = STATION_LABELS[stKey];
      if (times[label]) {
        let diff = toMin(times[label]) - fromMin;
        if (diff < 0) diff += 24 * 60;
        offsets[stKey] = diff;
      }
    }
    offsetsByHour[t.hour % 24] = offsets;
    await sleep(200);
  }
  return offsetsByHour;
}

function nearestOffset(offsetsByHour, hour, target) {
  const h = hour % 24;
  if (offsetsByHour[h] && target in offsetsByHour[h]) return offsetsByHour[h][target];
  let best = null;
  let bestDist = 99;
  for (const k of Object.keys(offsetsByHour)) {
    if (!(target in offsetsByHour[k])) continue;
    const kh = parseInt(k, 10);
    const dist = Math.min(Math.abs(kh - h), 24 - Math.abs(kh - h));
    if (dist < bestDist) {
      bestDist = dist;
      best = offsetsByHour[k][target];
    }
  }
  return best;
}

function isReachable(line, dir, dest, toIdx) {
  const reach = DEST_REACH[line][dir][dest];
  if (reach === undefined) return true; // unknown code: don't silently drop, allow it through
  return dir === "south" ? toIdx <= reach : toIdx >= reach;
}

async function buildStationLineDirection(station, line, dir) {
  const stationCfg = STATION_PAGES[station][line];
  if (!stationCfg || !stationCfg[dir]) return null;
  const stationCode = STATION_PAGES[station].code;
  const dirCode = stationCfg[dir];
  const base = `https://timetables.jreast.co.jp/2607/timetable/tt${stationCode}`;

  const [wdHtml, weHtml] = await Promise.all([
    get(`${base}/${stationCode}${dirCode}0.html`),
    get(`${base}/${stationCode}${dirCode}1.html`),
  ]);

  const weekday = filterTrains(line, parseDepartureList(wdHtml));
  const weekend = filterTrains(line, parseDepartureList(weHtml));

  const offsetsByHour = await calibrateOffsets(station, weekday);
  const fromIdx = STATIONS.indexOf(station);

  const buildTrains = (trains) => {
    const out = trains.map((t) => {
      const depMinTotal = t.hour * 60 + t.minute;
      const arrivals = {};
      for (const toStation of STATIONS) {
        if (toStation === station) continue;
        const toIdx = STATIONS.indexOf(toStation);
        if (dir === "south" && toIdx <= fromIdx) continue;
        if (dir === "north" && toIdx >= fromIdx) continue;
        if (!isReachable(line, dir, t.dest, toIdx)) continue;
        const offset = nearestOffset(offsetsByHour, t.hour, toStation);
        if (offset == null) continue;
        arrivals[toStation] = depMinTotal + offset;
      }
      return { dep: `${pad2(t.hour % 24)}:${pad2(t.minute)}`, depMinTotal, dest: t.dest, arrivals };
    });
    out.sort((a, b) => a.depMinTotal - b.depMinTotal);
    return out;
  };

  return { weekday: buildTrains(weekday), weekend: buildTrains(weekend) };
}

async function main() {
  const result = {
    generatedAt: new Date().toISOString(),
    source: "https://timetables.jreast.co.jp/ (JR東日本 各駅時刻表)",
    note: "区間ごとの所要時間は時間帯別にサンプル列車で実測した値を使用（平日ダイヤの実測値を平日・土休日共通で使用）。行き先が短い列車（蒲田止まり等）は到達しない駅の組み合わせでは自動的に除外されます。",
    stations: STATIONS,
    stationLabels: STATION_LABELS,
    lines: { keihinTohoku: { south: {}, north: {} }, tokaido: { south: {}, north: {} } },
  };

  for (const line of ["keihinTohoku", "tokaido"]) {
    for (const dir of ["south", "north"]) {
      for (const station of STATIONS) {
        if (!STATION_PAGES[station][line][dir]) continue;
        process.stdout.write(`fetching ${station} ${line} ${dir}...\n`);
        const built = await buildStationLineDirection(station, line, dir);
        if (built) result.lines[line][dir][station] = built;
      }
    }
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(result));
  console.log("Wrote", OUT_PATH);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
