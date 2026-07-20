const DEST_LABEL = {
  toKawasaki: {
    keihinTohoku: { "無印": "大船", "磯": "磯子", "桜": "桜木町", "鶴": "鶴見", "神": "東神奈川" },
    tokaido: { "無印": "熱海", "小": "小田原", "平": "平塚", "国": "国府津", "下": "伊豆急下田", "伊": "伊東", "沼": "沼津", "修": "修善寺" },
  },
  toShinagawa: {
    keihinTohoku: { "無印": "大宮", "浦": "南浦和", "赤": "赤羽", "上": "上野" },
    tokaido: { "無印": "高崎", "宇": "宇都宮", "金": "小金井", "籠": "籠原", "東": "東京", "上": "上野", "古": "古河", "品": "品川", "前": "前橋" },
  },
};

const STORAGE_KEY_BUFFER = "skr_buffer_minutes";
const STORAGE_KEY_DAYTYPE = "skr_daytype_mode";
const STORAGE_KEY_DIRECTION = "skr_direction";

let dataset = null;

const el = (id) => document.getElementById(id);

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatHM(totalMin) {
  const h = Math.floor(totalMin / 60) % 24;
  const m = totalMin % 60;
  return `${pad2(h)}:${pad2(m)}`;
}

function nowInfo() {
  const d = new Date();
  return {
    date: d,
    minTotal: d.getHours() * 60 + d.getMinutes(),
    dayOfWeek: d.getDay(), // 0=Sun..6=Sat
  };
}

function resolveDayType(mode, dayOfWeek) {
  if (mode === "weekday") return "weekday";
  if (mode === "weekend") return "weekend";
  // auto: JS getDay 0=Sun, 6=Sat -> weekend; note this does not account for
  // Japanese public holidays, which also run weekend timetables.
  return dayOfWeek === 0 || dayOfWeek === 6 ? "weekend" : "weekday";
}

function currentDirection() {
  return document.querySelector(".direction-toggle button.active").dataset.direction;
}

// Finds the next N trains at or after `earliestMin`. Dataset entries carry
// depMinTotal that can exceed 1440 for the post-midnight tail of the service
// day, so if it's currently the small hours (before first train), we shift
// `earliestMin` into that same 1440+ space to line up correctly.
function findNextTrains(list, earliestMin, count) {
  const candidates = list.filter((t) => t.depMinTotal >= earliestMin);
  if (candidates.length > 0) return candidates.slice(0, count);
  if (earliestMin < 300) {
    const shifted = earliestMin + 1440;
    const tail = list.filter((t) => t.depMinTotal >= shifted);
    if (tail.length > 0) return tail.slice(0, count);
  }
  return [];
}

function render() {
  if (!dataset) return;

  const now = nowInfo();
  el("clock").textContent = `${pad2(now.date.getHours())}:${pad2(now.date.getMinutes())}:${pad2(now.date.getSeconds())}`;

  const direction = currentDirection();
  const dirData = dataset[direction];

  const mode = document.querySelector(".daytype-toggle button.active").dataset.mode;
  const dayType = resolveDayType(mode, now.dayOfWeek);

  const bufferMin = Math.max(0, parseInt(el("bufferInput").value, 10) || 0);
  const earliest = now.minTotal + bufferMin;

  const keihinList = dirData.keihinTohoku[dayType];
  const tokaidoList = dirData.tokaido[dayType];

  const keihinNext = findNextTrains(keihinList, earliest, 4);
  const tokaidoNext = findNextTrains(tokaidoList, earliest, 4);

  renderLine("keihin", direction, "keihinTohoku", keihinNext);
  renderLine("tokaido", direction, "tokaido", tokaidoNext);

  const banner = el("resultBanner");
  const cardKeihin = el("cardKeihin");
  const cardTokaido = el("cardTokaido");
  cardKeihin.classList.remove("winner");
  cardTokaido.classList.remove("winner");
  banner.classList.remove("win-keihin", "win-tokaido");

  const toStation = dirData.toStation;

  if (keihinNext.length === 0 && tokaidoNext.length === 0) {
    banner.innerHTML = "本日の運行は終了しました";
  } else if (keihinNext.length === 0) {
    banner.innerHTML = "東海道線のみ運行中";
    cardTokaido.classList.add("winner");
    banner.classList.add("win-tokaido");
  } else if (tokaidoNext.length === 0) {
    banner.innerHTML = "京浜東北線のみ運行中";
    cardKeihin.classList.add("winner");
    banner.classList.add("win-keihin");
  } else {
    const k = keihinNext[0];
    const t = tokaidoNext[0];
    const diff = k.arrMinTotal - t.arrMinTotal;
    if (diff === 0) {
      banner.innerHTML = `${toStation}に同時着です`;
    } else if (diff > 0) {
      banner.innerHTML = `東海道線が ${diff}分早く ${toStation}に到着<span class="diff">京浜東北線 ${formatHM(k.arrMinTotal)}着 / 東海道線 ${formatHM(t.arrMinTotal)}着</span>`;
      cardTokaido.classList.add("winner");
      banner.classList.add("win-tokaido");
    } else {
      banner.innerHTML = `京浜東北線が ${-diff}分早く ${toStation}に到着<span class="diff">京浜東北線 ${formatHM(k.arrMinTotal)}着 / 東海道線 ${formatHM(t.arrMinTotal)}着</span>`;
      cardKeihin.classList.add("winner");
      banner.classList.add("win-keihin");
    }
  }
}

function renderLine(prefix, direction, lineKey, nextTrains) {
  const depEl = el(`${prefix}Dep`);
  const arrEl = el(`${prefix}Arr`);
  const destEl = el(`${prefix}Dest`);
  const subEl = el(`${prefix}Sub`);
  const upcomingEl = el(`${prefix}Upcoming`);

  if (nextTrains.length === 0) {
    depEl.textContent = "--:--";
    arrEl.textContent = "--:--";
    destEl.textContent = "";
    subEl.textContent = "本日の運行終了";
    upcomingEl.innerHTML = "";
    return;
  }

  const labels = DEST_LABEL[direction][lineKey];
  const first = nextTrains[0];
  depEl.textContent = formatHM(first.depMinTotal);
  arrEl.textContent = formatHM(first.arrMinTotal);
  destEl.textContent = labels[first.dest] ? `${labels[first.dest]}行` : "";
  subEl.textContent = "";

  upcomingEl.innerHTML = nextTrains
    .slice(1)
    .map(
      (t) =>
        `<li><span class="dep">${formatHM(t.depMinTotal)}発</span><span class="arr">${formatHM(t.arrMinTotal)}着</span></li>`
    )
    .join("");
}

function updateStationLabels() {
  const direction = currentDirection();
  const dirData = dataset ? dataset[direction] : null;
  const fromStation = dirData ? dirData.fromStation : direction === "toKawasaki" ? "品川" : "川崎";
  const toStation = dirData ? dirData.toStation : direction === "toKawasaki" ? "川崎" : "品川";
  el("routeTitle").textContent = `${fromStation} → ${toStation}`;
  el("keihinDepLabel").textContent = `${fromStation}発`;
  el("keihinArrLabel").textContent = `${toStation}着`;
  el("tokaidoDepLabel").textContent = `${fromStation}発`;
  el("tokaidoArrLabel").textContent = `${toStation}着`;
}

function setupDirectionToggle() {
  const container = el("directionToggle");
  const saved = localStorage.getItem(STORAGE_KEY_DIRECTION) || "toKawasaki";
  container.querySelectorAll("button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.direction === saved);
  });
  container.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      container.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      localStorage.setItem(STORAGE_KEY_DIRECTION, btn.dataset.direction);
      updateStationLabels();
      render();
    });
  });
}

function setupDaytypeToggle() {
  const container = el("daytypeToggle");
  const saved = localStorage.getItem(STORAGE_KEY_DAYTYPE) || "auto";
  container.querySelectorAll("button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === saved);
    btn.addEventListener("click", () => {
      container.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      localStorage.setItem(STORAGE_KEY_DAYTYPE, btn.dataset.mode);
      render();
    });
  });
}

function setupBufferInput() {
  const input = el("bufferInput");
  const saved = localStorage.getItem(STORAGE_KEY_BUFFER);
  if (saved !== null) input.value = saved;

  const commit = () => {
    let v = parseInt(input.value, 10);
    if (Number.isNaN(v)) v = 0;
    v = Math.min(15, Math.max(0, v));
    input.value = v;
    localStorage.setItem(STORAGE_KEY_BUFFER, String(v));
    render();
  };

  input.addEventListener("change", commit);
  el("bufferMinus").addEventListener("click", () => {
    input.value = Math.max(0, (parseInt(input.value, 10) || 0) - 1);
    commit();
  });
  el("bufferPlus").addEventListener("click", () => {
    input.value = Math.min(15, (parseInt(input.value, 10) || 0) + 1);
    commit();
  });
}

async function init() {
  setupDirectionToggle();
  setupDaytypeToggle();
  setupBufferInput();
  updateStationLabels();

  try {
    const res = await fetch("data/timetable.json");
    dataset = await res.json();
    updateStationLabels();
    const genDate = new Date(dataset.generatedAt);
    el("datasetNote").textContent = `時刻表データ取得日: ${genDate.getFullYear()}/${genDate.getMonth() + 1}/${genDate.getDate()}`;
  } catch (e) {
    el("resultBanner").textContent = "時刻表データの読み込みに失敗しました";
    return;
  }

  render();
  setInterval(render, 15000);
  setInterval(() => {
    const d = new Date();
    el("clock").textContent = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }, 1000);
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
}

init();
