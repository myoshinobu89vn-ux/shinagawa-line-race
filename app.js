const STORAGE_KEY_BUFFER = "skr_buffer_minutes";
const STORAGE_KEY_DAYTYPE = "skr_daytype_mode";
const STORAGE_KEY_FROM = "skr_from_station";
const STORAGE_KEY_TO = "skr_to_station";

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
    totalSeconds: d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds(),
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

function currentFromTo() {
  return { from: el("fromSelect").value, to: el("toSelect").value };
}

function direction(from, to) {
  return dataset.stations.indexOf(to) > dataset.stations.indexOf(from) ? "south" : "north";
}

// Finds the next N trains (that actually reach `to`) at or after
// `earliestSeconds`. Trains depart at second :00 of their listed minute, so
// this compares in seconds rather than minutes — otherwise a train scheduled
// for the current minute would still show as "next" for the rest of that
// minute even after it has actually left.
// depMinTotal can exceed 1440 for the post-midnight tail of the service day,
// so if it's currently the small hours (before first train), we shift
// `earliestSeconds` into that same range to line up correctly.
function findNextTrains(list, to, earliestSeconds, count) {
  const reaches = (t) => t.arrivals[to] != null;
  const candidates = list.filter((t) => reaches(t) && t.depMinTotal * 60 >= earliestSeconds);
  if (candidates.length > 0) return candidates.slice(0, count);
  if (earliestSeconds < 300 * 60) {
    const shifted = earliestSeconds + 1440 * 60;
    const tail = list.filter((t) => reaches(t) && t.depMinTotal * 60 >= shifted);
    if (tail.length > 0) return tail.slice(0, count);
  }
  return [];
}

function render() {
  if (!dataset) return;

  const now = nowInfo();
  el("clock").textContent = `${pad2(now.date.getHours())}:${pad2(now.date.getMinutes())}:${pad2(now.date.getSeconds())}`;

  const { from, to } = currentFromTo();
  const dir = direction(from, to);

  const mode = document.querySelector(".daytype-toggle button.active").dataset.mode;
  const dayType = resolveDayType(mode, now.dayOfWeek);

  const bufferMin = parseInt(el("bufferInput").value, 10) || 0;
  const earliest = now.totalSeconds + bufferMin * 60;

  const keihinList = (dataset.lines.keihinTohoku[dir][from] || {})[dayType] || [];
  const tokaidoList = (dataset.lines.tokaido[dir][from] || {})[dayType] || [];

  const keihinNext = findNextTrains(keihinList, to, earliest, 4);
  const tokaidoNext = findNextTrains(tokaidoList, to, earliest, 4);

  renderLine("keihin", to, keihinNext);
  renderLine("tokaido", to, tokaidoNext);

  const banner = el("resultBanner");
  const cardKeihin = el("cardKeihin");
  const cardTokaido = el("cardTokaido");
  cardKeihin.classList.remove("winner");
  cardTokaido.classList.remove("winner");
  banner.classList.remove("win-keihin", "win-tokaido");

  const toLabel = dataset.stationLabels[to];

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
    const diff = k.arrivals[to] - t.arrivals[to];
    if (diff === 0) {
      banner.innerHTML = `${toLabel}に同時着です`;
    } else if (diff > 0) {
      banner.innerHTML = `東海道線が ${diff}分早く ${toLabel}に到着<span class="diff">京浜東北線 ${formatHM(k.arrivals[to])}着 / 東海道線 ${formatHM(t.arrivals[to])}着</span>`;
      cardTokaido.classList.add("winner");
      banner.classList.add("win-tokaido");
    } else {
      banner.innerHTML = `京浜東北線が ${-diff}分早く ${toLabel}に到着<span class="diff">京浜東北線 ${formatHM(k.arrivals[to])}着 / 東海道線 ${formatHM(t.arrivals[to])}着</span>`;
      cardKeihin.classList.add("winner");
      banner.classList.add("win-keihin");
    }
  }
}

function renderLine(prefix, to, nextTrains) {
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

  const first = nextTrains[0];
  depEl.textContent = formatHM(first.depMinTotal);
  arrEl.textContent = formatHM(first.arrivals[to]);
  destEl.textContent = first.destLabel ? `${first.destLabel}行` : "";
  subEl.textContent = "";

  upcomingEl.innerHTML = nextTrains
    .slice(1)
    .map(
      (t) =>
        `<li><span class="dep">${formatHM(t.depMinTotal)}発</span><span class="arr">${formatHM(t.arrivals[to])}着</span></li>`
    )
    .join("");
}

function updateStationLabels() {
  const { from, to } = currentFromTo();
  const fromLabel = dataset ? dataset.stationLabels[from] : from;
  const toLabel = dataset ? dataset.stationLabels[to] : to;
  el("routeTitle").textContent = `${fromLabel} → ${toLabel}`;
  el("keihinDepLabel").textContent = `${fromLabel}発`;
  el("keihinArrLabel").textContent = `${toLabel}着`;
  el("tokaidoDepLabel").textContent = `${fromLabel}発`;
  el("tokaidoArrLabel").textContent = `${toLabel}着`;
}

function populateStationSelects() {
  const fromSelect = el("fromSelect");
  const toSelect = el("toSelect");
  fromSelect.innerHTML = "";
  toSelect.innerHTML = "";
  for (const key of dataset.stations) {
    const label = dataset.stationLabels[key];
    fromSelect.appendChild(new Option(label, key));
    toSelect.appendChild(new Option(label, key));
  }

  const savedFrom = localStorage.getItem(STORAGE_KEY_FROM);
  const savedTo = localStorage.getItem(STORAGE_KEY_TO);
  fromSelect.value = savedFrom && dataset.stations.includes(savedFrom) ? savedFrom : "shinagawa";
  toSelect.value = savedTo && dataset.stations.includes(savedTo) ? savedTo : "kawasaki";
  if (fromSelect.value === toSelect.value) {
    toSelect.value = dataset.stations.find((s) => s !== fromSelect.value);
  }

  const onChange = (changed) => {
    if (fromSelect.value === toSelect.value) {
      // keep them distinct: bump the other select to the next station
      const other = changed === "from" ? toSelect : fromSelect;
      const stations = dataset.stations;
      const curIdx = stations.indexOf(other.value);
      other.value = stations[(curIdx + 1) % stations.length];
    }
    localStorage.setItem(STORAGE_KEY_FROM, fromSelect.value);
    localStorage.setItem(STORAGE_KEY_TO, toSelect.value);
    updateStationLabels();
    render();
  };

  fromSelect.addEventListener("change", () => onChange("from"));
  toSelect.addEventListener("change", () => onChange("to"));
}

function swapStations() {
  const fromSelect = el("fromSelect");
  const toSelect = el("toSelect");
  const tmp = fromSelect.value;
  fromSelect.value = toSelect.value;
  toSelect.value = tmp;
  localStorage.setItem(STORAGE_KEY_FROM, fromSelect.value);
  localStorage.setItem(STORAGE_KEY_TO, toSelect.value);
  updateStationLabels();
  render();
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
    v = Math.min(15, Math.max(-15, v));
    input.value = v;
    localStorage.setItem(STORAGE_KEY_BUFFER, String(v));
    render();
  };

  input.addEventListener("change", commit);
  el("bufferMinus").addEventListener("click", () => {
    input.value = Math.max(-15, (parseInt(input.value, 10) || 0) - 1);
    commit();
  });
  el("bufferPlus").addEventListener("click", () => {
    input.value = Math.min(15, (parseInt(input.value, 10) || 0) + 1);
    commit();
  });
}

async function init() {
  setupDaytypeToggle();
  setupBufferInput();
  el("swapStations").addEventListener("click", swapStations);

  try {
    const res = await fetch("data/timetable.json");
    dataset = await res.json();
    populateStationSelects();
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
