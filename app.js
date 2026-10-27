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

// Standard seion gojuon table (no dakuten/handakuten yet — none of today's
// station readings need them). null = no character at that grid position.
const GOJUON_ROWS = [
  ["あ", "い", "う", "え", "お"],
  ["か", "き", "く", "け", "こ"],
  ["さ", "し", "す", "せ", "そ"],
  ["た", "ち", "つ", "て", "と"],
  ["な", "に", "ぬ", "ね", "の"],
  ["は", "ひ", "ふ", "へ", "ほ"],
  ["ま", "み", "む", "め", "も"],
  ["や", null, "ゆ", null, "よ"],
  ["ら", "り", "る", "れ", "ろ"],
  ["わ", null, null, "を", "ん"],
];

let dataset = null;
let stationsMaster = null;

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
  };
}

function dateKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function nthMonday(year, month, n) {
  const firstDow = new Date(year, month - 1, 1).getDay();
  return 1 + ((8 - firstDow) % 7) + (n - 1) * 7;
}

// Holidays fixed by date or rule under 国民の祝日に関する法律 (before 振替休日
// / 国民の休日, which isJapaneseHoliday layers on top). Equinox formulas are
// the standard approximation, valid 1980-2099.
function isBaseHoliday(d) {
  const y = d.getFullYear();
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  const fixed = ["1/1", "2/11", "2/23", "4/29", "5/3", "5/4", "5/5", "8/11", "11/3", "11/23"];
  if (fixed.includes(md)) return true;
  const shift = Math.floor((y - 1980) / 4);
  const vernal = Math.floor(20.8431 + 0.242194 * (y - 1980)) - shift;
  const autumnal = Math.floor(23.2488 + 0.242194 * (y - 1980)) - shift;
  return [
    `1/${nthMonday(y, 1, 2)}`, // 成人の日
    `3/${vernal}`, // 春分の日
    `7/${nthMonday(y, 7, 3)}`, // 海の日
    `9/${nthMonday(y, 9, 3)}`, // 敬老の日
    `9/${autumnal}`, // 秋分の日
    `10/${nthMonday(y, 10, 2)}`, // スポーツの日
  ].includes(md);
}

function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function isJapaneseHoliday(d) {
  if (isBaseHoliday(d)) return true;
  // 振替休日: the first non-holiday after a holiday that fell on a Sunday.
  for (let k = 1; isBaseHoliday(addDays(d, -k)); k++) {
    if (addDays(d, -k).getDay() === 0) return true;
  }
  // 国民の休日: a day sandwiched between two holidays.
  return isBaseHoliday(addDays(d, -1)) && isBaseHoliday(addDays(d, 1));
}

// JR (and Keikyu) also run the 土休日 timetable over the New Year break.
function isYearEndBreak(d) {
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return (m === 12 && day >= 30) || (m === 1 && day <= 3);
}

function resolveDayType(mode, date) {
  if (mode === "weekday") return "weekday";
  if (mode === "weekend") return "weekend";
  const dow = date.getDay(); // 0=Sun, 6=Sat
  const weekend = dow === 0 || dow === 6 || isJapaneseHoliday(date) || isYearEndBreak(date);
  return weekend ? "weekend" : "weekday";
}

function currentFromTo() {
  return { from: el("fromSelect").value, to: el("toSelect").value };
}

function direction(from, to) {
  return dataset.stations.indexOf(to) > dataset.stations.indexOf(from) ? "south" : "north";
}

// Which of LINES actually run between the current from/to (Keikyu only
// covers the shinagawa/kawasaki/yokohama overlap, and the Yokosuka Line
// doesn't stop at kawasaki, so those drop out for pairs they don't serve).
function activeLines(from, to, dir) {
  return LINES.filter((line) => lineReachesStation(line.key, dir, from, to));
}

// Does this line have at least one actual train from->to (not just a data
// block for `from` in this direction — an individual train's destination
// may fall short of `to` even when the line generally passes through it).
function lineReachesStation(lineKey, dir, from, to) {
  const data = dataset.lines[lineKey]?.[dir]?.[from];
  if (!data) return false;
  const trains = [...(data.weekday || []), ...(data.weekend || [])];
  return trains.some((t) => t.arrivals[to] != null);
}

// Stations reachable from `from` where 2+ lines actually compete (a pair
// only one line serves isn't a race, so the station picker shouldn't offer
// it as a destination).
function competingStations(from) {
  return dataset.stations.filter((to) => {
    if (to === from) return false;
    const dir = direction(from, to);
    const linesReaching = LINES.filter((line) => lineReachesStation(line.key, dir, from, to));
    return linesReaching.length >= 2;
  });
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

  const mode = currentDaytypeMode();
  const dayType = resolveDayType(mode, now.date);

  const bufferMin = parseInt(el("bufferInput").value, 10) || 0;
  const earliest = now.totalSeconds + bufferMin * 60;

  const toLabel = dataset.stationLabels[to];
  let results = lines.map((line) => {
    const list = (dataset.lines[line.key][dir][from] || {})[dayType] || [];
    const next = findNextTrains(list, to, earliest, 4);
    return { line, next, noData: list.length === 0 };
  });

  // Fastest-first, left to right; lines with no more trains today sink to the end.
  results = results.sort((a, b) => {
    if (a.next.length === 0 && b.next.length === 0) return 0;
    if (a.next.length === 0) return 1;
    if (b.next.length === 0) return -1;
    return a.next[0].arrivals[to] - b.next[0].arrivals[to];
  });

  renderCards(results.map((r) => r.line));
  for (const { line, next, noData } of results) renderLine(line.key, to, next, noData);

  const banner = el("resultBanner");
  for (const { line } of results) el(`card-${line.key}`).classList.remove("winner");
  banner.className = "result-banner";

  // Compare whichever lines still have a train today; lines that have
  // finished for the day just drop out of the comparison (their cards
  // already show "本日の運行終了" individually via renderLine).
  const running = results.filter((r) => r.next.length > 0);
  if (running.length === 0) {
    banner.innerHTML = "本日の運行は終了しました";
  } else if (running.length === 1) {
    const only = running[0];
    banner.innerHTML = `${only.line.label}のみ運行中<span class="diff">${formatHM(only.next[0].arrivals[to])}着</span>`;
    el(`card-${only.line.key}`).classList.add("winner");
    banner.classList.add(`win-${only.line.colorClass}`);
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

// Cards and their "later trains" lists share one horizontally-scrolling row
// (one column per line) so scrolling to see a line's card also brings its
// upcoming-trains list along, instead of two independently-scrolling rows.
function renderCards(lines) {
  const container = el("cardsContainer");
  container.innerHTML = lines
    .map(
      (line) => `
    <div class="line-col">
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
      </div>
      <ul class="upcoming-col" id="${line.key}Upcoming"></ul>
    </div>`
    )
    .join("");
}

// noData: this day type's list is empty altogether (e.g. a scrape that came
// back with no trains), which shouldn't read as "service has ended".
function renderLine(lineKey, to, nextTrains, noData) {
  const depEl = el(`${lineKey}Dep`);
  const arrEl = el(`${lineKey}Arr`);
  const destEl = el(`${lineKey}Dest`);
  const subEl = el(`${lineKey}Sub`);
  const upcomingEl = el(`${lineKey}Upcoming`);

  if (nextTrains.length === 0) {
    depEl.textContent = "--:--";
    arrEl.textContent = "--:--";
    destEl.textContent = "";
    subEl.textContent = noData ? "時刻表データなし" : "本日の運行終了";
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

// --- Station picker (区間選択): 五十音 -> (候補1件なら即確定 / 複数なら一覧から選択) ---
// One persistent screen: confirmed from/to show as slots at the top, tapping
// a kana narrows candidates into a list shown just above the kana grid, and
// picking (or narrowing to) a single candidate confirms it immediately.

const picker = {
  from: null,
  to: null,
  step: "from", // "from" | "to" -- which slot is currently being filled
  candidates: [], // station keys matching the last-tapped kana, for the current step
};

function stationsStartingWith(kana, candidateKeys) {
  return candidateKeys.filter((key) => stationsMaster[key].kana.startsWith(kana));
}

// Stations worth offering as a starting point at all (dead-end stations
// with no competing destination are excluded from the "from" list).
function candidateFromStations() {
  return dataset.stations.filter((s) => competingStations(s).length > 0);
}

function currentStepCandidates() {
  return picker.step === "from" ? candidateFromStations() : competingStations(picker.from);
}

function validInitials() {
  return new Set(currentStepCandidates().map((key) => stationsMaster[key].kana[0]));
}

function applyStationSelection(from, to) {
  el("fromSelect").value = from;
  el("toSelect").value = to;
  localStorage.setItem(STORAGE_KEY_FROM, from);
  localStorage.setItem(STORAGE_KEY_TO, to);
  updateStationLabels();
  render();
}

function openPicker() {
  picker.from = null;
  picker.to = null;
  picker.step = "from";
  picker.candidates = [];
  el("stationPicker").classList.remove("hidden");
  renderPickerScreen();
}

function closePicker() {
  el("stationPicker").classList.add("hidden");
}

function pickerBack() {
  if (picker.candidates.length > 0) {
    picker.candidates = [];
  } else if (picker.step === "to") {
    picker.step = "from";
    picker.from = null;
  } else {
    closePicker();
    return;
  }
  renderPickerScreen();
}

// Confirms `key` for the current step; if that was "from" and there's more
// than one competing destination, advances to the "to" step instead of
// closing. Also the target of kana-narrows-to-one-candidate auto-confirm.
function confirmStation(key) {
  if (picker.step === "from") {
    picker.from = key;
    const competing = competingStations(key);
    if (competing.length === 1) {
      applyStationSelection(key, competing[0]);
      closePicker();
      return;
    }
    picker.step = "to";
    picker.candidates = [];
    renderPickerScreen();
  } else {
    picker.to = key;
    applyStationSelection(picker.from, key);
    closePicker();
  }
}

function selectKana(kana) {
  const matches = stationsStartingWith(kana, currentStepCandidates());
  if (matches.length === 1) {
    confirmStation(matches[0]);
    return;
  }
  picker.candidates = matches;
  renderPickerScreen();
}

function renderPickerScreen() {
  const backBtn = el("pickerBack");
  const kanaGrid = el("kanaGrid");
  const stationList = el("stationList");
  const fromSlot = el("pickerFromSlot");
  const toSlot = el("pickerToSlot");

  backBtn.classList.toggle("hidden", picker.step === "from" && picker.candidates.length === 0);

  el("pickerFromValue").textContent = picker.from ? stationsMaster[picker.from].label : "選択してください";
  fromSlot.classList.toggle("active", picker.step === "from");
  fromSlot.classList.toggle("filled", !!picker.from);

  el("pickerToValue").textContent = picker.to
    ? stationsMaster[picker.to].label
    : picker.step === "to"
    ? "選択してください"
    : "―";
  toSlot.classList.toggle("active", picker.step === "to");
  toSlot.classList.toggle("filled", !!picker.to);
  toSlot.classList.toggle("pending", picker.step === "from");

  if (picker.candidates.length > 0) {
    stationList.classList.remove("hidden");
    stationList.innerHTML = picker.candidates
      .map((key) => `<li><button class="station-item" data-station="${key}">${stationsMaster[key].label}</button></li>`)
      .join("");
  } else {
    stationList.classList.add("hidden");
    stationList.innerHTML = "";
  }

  const valid = validInitials();
  kanaGrid.innerHTML = GOJUON_ROWS.map((row) =>
    row
      .map((ch) => {
        if (!ch) return `<span class="kana-btn empty"></span>`;
        const enabled = valid.has(ch);
        return enabled
          ? `<button class="kana-btn" data-kana="${ch}">${ch}</button>`
          : `<button class="kana-btn disabled" disabled>${ch}</button>`;
      })
      .join("")
  ).join("");
}

function setupStationPicker() {
  el("openPicker").addEventListener("click", openPicker);
  el("pickerClose").addEventListener("click", closePicker);
  el("pickerBack").addEventListener("click", pickerBack);
  el("kanaGrid").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-kana]");
    if (btn) selectKana(btn.dataset.kana);
  });
  el("stationList").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-station]");
    if (btn) confirmStation(btn.dataset.station);
  });
}

function updateStationLabels() {
  const { from, to } = currentFromTo();
  const fromLabel = dataset ? dataset.stationLabels[from] : from;
  const toLabel = dataset ? dataset.stationLabels[to] : to;
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

// A manual 平日/土休日 pick is stored with the date it was made and only
// applies for that day — otherwise a one-off 土休日 override (or an old
// plain-string value from before this) would silently stick to every
// following weekday. Anything stale falls back to 自動.
function savedDaytypeMode() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY_DAYTYPE));
    if (saved && saved.date === dateKey(new Date())) return saved.mode;
  } catch (e) {
    // unparseable legacy value: treat as stale
  }
  return "auto";
}

function markDaytypeButton(mode) {
  el("daytypeToggle").querySelectorAll("button").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === mode);
  });
}

// Re-checked on every render so an app left open past midnight drops a
// previous day's override too.
function currentDaytypeMode() {
  const mode = savedDaytypeMode();
  markDaytypeButton(mode);
  return mode;
}

function setupDaytypeToggle() {
  markDaytypeButton(savedDaytypeMode());
  el("daytypeToggle").querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.mode;
      localStorage.setItem(STORAGE_KEY_DAYTYPE, JSON.stringify({ mode, date: dateKey(new Date()) }));
      markDaytypeButton(mode);
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

// A hung network request (bad signal underground, a stuck service worker,
// etc.) would otherwise leave the "読み込み中…" placeholder forever with no
// feedback. Race the fetch against a timeout so a slow/dead connection shows
// a retry button instead of spinning silently.
function fetchWithTimeout(url, ms) {
  return Promise.race([
    fetch(url),
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

async function loadDataset() {
  try {
    const [res, stationsRes] = await Promise.all([
      fetchWithTimeout("data/timetable.json", 8000),
      fetchWithTimeout("data/stations.json", 8000),
    ]);
    dataset = await res.json();
    stationsMaster = await stationsRes.json();
    populateStationSelects();
    updateStationLabels();
    const genDate = new Date(dataset.generatedAt);
    el("datasetNote").textContent = `時刻表データ取得日: ${genDate.getFullYear()}/${genDate.getMonth() + 1}/${genDate.getDate()}`;
    return true;
  } catch (e) {
    const banner = el("resultBanner");
    banner.innerHTML = "";
    const msg = document.createElement("span");
    msg.textContent = "時刻表データを読み込めませんでした（通信状況を確認してください）";
    const retry = document.createElement("button");
    retry.textContent = "再読み込み";
    retry.className = "retry-btn";
    retry.addEventListener("click", () => location.reload());
    banner.appendChild(msg);
    banner.appendChild(retry);
    return false;
  }
}

async function init() {
  setupDaytypeToggle();
  setupBufferInput();
  setupStationPicker();
  el("swapStations").addEventListener("click", swapStations);

  if (!(await loadDataset())) return;

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
