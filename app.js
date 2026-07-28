const STORAGE_KEY_BUFFER = "skr_buffer_minutes";
const STORAGE_KEY_DAYTYPE = "skr_daytype_mode";
const STORAGE_KEY_FROM = "skr_from_station";
const STORAGE_KEY_TO = "skr_to_station";

const LINES = [
  { key: "keihinTohoku", label: "京浜東北線", colorClass: "keihin" },
  { key: "tokaido", label: "東海道線", colorClass: "tokaido" },
  { key: "keikyu", label: "京急線", colorClass: "keikyu" },
  { key: "yokosuka", label: "横須賀線", colorClass: "yokosuka" },
];

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

// Which of LINES actually run between the current from/to (Keikyu only
// covers the shinagawa/kawasaki/yokohama overlap, so it drops out otherwise).
function activeLines(from, to, dir) {
  return LINES.filter((line) => dataset.lines[line.key]?.[dir]?.[from]);
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
  const lines = activeLines(from, to, dir);

  const mode = document.querySelector(".daytype-toggle button.active").dataset.mode;
  const dayType = resolveDayType(mode, now.dayOfWeek);

  const bufferMin = parseInt(el("bufferInput").value, 10) || 0;
  const earliest = now.totalSeconds + bufferMin * 60;

  const toLabel = dataset.stationLabels[to];
  let results = lines.map((line) => {
    const list = (dataset.lines[line.key][dir][from] || {})[dayType] || [];
    const next = findNextTrains(list, to, earliest, 4);
    return { line, next };
  });

  // Fastest-first, left to right; lines with no more trains today sink to the end.
  results = results.sort((a, b) => {
    if (a.next.length === 0 && b.next.length === 0) return 0;
    if (a.next.length === 0) return 1;
    if (b.next.length === 0) return -1;
    return a.next[0].arrivals[to] - b.next[0].arrivals[to];
  });

  renderCards(results.map((r) => r.line));
  for (const { line, next } of results) renderLine(line.key, to, next);

  const banner = el("resultBanner");
  for (const { line } of results) el(`card-${line.key}`).classList.remove("winner");
  banner.className = "result-banner";

  const running = results.filter((r) => r.next.length > 0);
  if (running.length === 0) {
    banner.innerHTML = "本日の運行は終了しました";
  } else if (running.length < results.length) {
    const names = running.map((r) => r.line.label).join("・");
    banner.innerHTML = `${names}のみ運行中`;
    for (const r of running) {
      el(`card-${r.line.key}`).classList.add("winner");
      banner.classList.add(`win-${r.line.colorClass}`);
    }
  } else {
    const bestTime = Math.min(...running.map((r) => r.next[0].arrivals[to]));
    const winners = running.filter((r) => r.next[0].arrivals[to] === bestTime);
    const detail = running
      .map((r) => `${r.line.label} ${formatHM(r.next[0].arrivals[to])}着`)
      .join(" / ");
    if (winners.length > 1) {
      banner.innerHTML = `${toLabel}に同時着です<span class="diff">${detail}</span>`;
    } else {
      const winner = winners[0];
      const runnerUpTime = Math.min(
        ...running.filter((r) => r !== winner).map((r) => r.next[0].arrivals[to])
      );
      const diff = runnerUpTime - bestTime;
      banner.innerHTML = `${winner.line.label}が ${diff}分早く ${toLabel}に到着<span class="diff">${detail}</span>`;
    }
    for (const w of winners) {
      el(`card-${w.line.key}`).classList.add("winner");
      banner.classList.add(`win-${w.line.colorClass}`);
    }
  }
}

function renderCards(lines) {
  const container = el("cardsContainer");
  const upcoming = el("upcomingContainer");
  container.innerHTML = lines
    .map(
      (line) => `
    <div class="card" id="card-${line.key}">
      <div class="card-title">
        <div class="card-title-name"><span class="line-dot ${line.colorClass}"></span>${line.label}</div>
        <span class="badge-dest" id="${line.key}Dest"></span>
      </div>
      <div class="card-times">
        <div class="time-block">
          <span class="time-label" id="${line.key}DepLabel"></span>
          <span class="time-value" id="${line.key}Dep">--:--</span>
        </div>
        <div class="arrow">↓</div>
        <div class="time-block">
          <span class="time-label" id="${line.key}ArrLabel"></span>
          <span class="time-value" id="${line.key}Arr">--:--</span>
        </div>
      </div>
      <div class="card-sub" id="${line.key}Sub"></div>
    </div>`
    )
    .join("");
  upcoming.innerHTML = lines
    .map(
      (line) => `
    <div class="upcoming-col">
      <div class="upcoming-col-title"><span class="line-dot ${line.colorClass}"></span>${line.label}</div>
      <ul id="${line.key}Upcoming"></ul>
    </div>`
    )
    .join("");
}

function renderLine(lineKey, to, nextTrains) {
  const depEl = el(`${lineKey}Dep`);
  const arrEl = el(`${lineKey}Arr`);
  const destEl = el(`${lineKey}Dest`);
  const subEl = el(`${lineKey}Sub`);
  const upcomingEl = el(`${lineKey}Upcoming`);

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
  for (const line of LINES) {
    const depLabelEl = el(`${line.key}DepLabel`);
    const arrLabelEl = el(`${line.key}ArrLabel`);
    if (depLabelEl) depLabelEl.textContent = `${fromLabel}発`;
    if (arrLabelEl) arrLabelEl.textContent = `${toLabel}着`;
  }
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
