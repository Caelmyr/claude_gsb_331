/* Replay & timeline: scrub through sharded per-step snapshots, with
 * multi-individual trajectory tracking (strict id-based join; see render.js). */

let runId = null;
let meta = null;
let savedSteps = [];
let maxIdx = 0;
let playing = false;
let playTimer = null;

// --- tracking state ------------------------------------------------------- //
const trackedIds = [];          // tracked ids in selection order (for colors)
const trackCache = {};          // id -> fetched point list
let cacheTo = null;             // cached coverage: all points in [0..cacheTo]
let cacheObserved = [];         // observed_steps of the last range fetch
let cacheVersion = 0;           // bumped on run switch (invalidates in-flight)
let curSnap = null;
let curView = null;
let curStep = 0;
let selectedDetailId = null;    // id whose state sequence is expanded

function renderStats(stats) {
  el("statTiles").innerHTML = Object.entries(stats || {}).map(([k, v]) => `
    <div class="stat"><div class="k">${esc(k)}</div><div class="v">${fmt(v)}</div></div>`).join("");
}

function nearestStep(steps, v) {
  if (!steps.length) return 0;
  return steps.reduce((p, c) => (Math.abs(c - v) < Math.abs(p - v) ? c : p), steps[0]);
}

function colorFor(id) {
  const i = trackedIds.indexOf(id);
  return i >= 0 ? trackColorAt(i) : "#cccccc";
}

// --- trajectory cache ----------------------------------------------------- //
// Coverage invariant: once fetched, trackCache holds every observed point in
// [0 .. cacheTo] for ALL currently tracked ids.  Adding a new id (or switching
// runs) invalidates coverage and forces one full refetch; playing forward
// extends it incrementally.  Scrubbing backwards never refetches.
async function ensureTracks() {
  const version = cacheVersion;
  if (!trackedIds.length) return;
  const end = Math.max(savedSteps[savedSteps.length - 1] ?? curStep,
                       meta.current_step ?? 0);
  let from, to;
  if (cacheTo === null) { from = 0; to = end; }
  else if (curStep <= cacheTo) { return; }
  else { from = cacheTo; to = end; }
  const qs = `ids=${trackedIds.map(encodeURIComponent).join(",")}&from=${from}&to=${to}`;
  const data = await get(`/api/runs/${runId}/trajectories?${qs}`);
  if (version !== cacheVersion) return; // user switched runs meanwhile
  for (const [id, pts] of Object.entries(data.tracks || {})) {
    const have = trackCache[id] || [];
    const byStep = new Map(have.map((p) => [p.step, p]));
    for (const p of pts) byStep.set(p.step, p);
    trackCache[id] = [...byStep.values()].sort((a, b) => a.step - b.step);
  }
  if (cacheTo === null) {
    cacheObserved = data.observed_steps || [];
  } else {
    // Merge newly observed shard steps, ordered, without duplicates.
    const merged = new Set(cacheObserved);
    for (const s of data.observed_steps || []) merged.add(s);
    cacheObserved = [...merged].sort((a, b) => a - b);
  }
  cacheTo = data.step_to;
}

// --- drawing -------------------------------------------------------------- //
async function loadStep(idx) {
  const step = savedSteps[idx];
  const version = cacheVersion;
  await ensureTracks();
  if (version !== cacheVersion) return;
  const snap = await get(`/api/runs/${runId}/snapshot?step=${step}`);
  if (version !== cacheVersion) return;
  curSnap = snap;
  curStep = step;
  curView = renderSnapshot(el("canvas"), snap, meta.domain, meta.model);
  if (el("showTracks").checked && trackedIds.length) {
    const tracks = trackedIds
      .filter((id) => (trackCache[id] || []).some((p) => p.step <= step))
      .map((id) => ({ id, color: colorFor(id), points: trackCache[id] }));
    renderTracks(el("canvas"), tracks, curView, cacheObserved, step,
                 snap.palette);
  }
  renderLegend(el("legend"), snap.palette);
  renderStats(snap.stats);
  el("stepLabel").textContent = `第 ${step} 步`;
  el("timeline").value = idx;
  renderTrackPanel(step, snap);
}

// --- track side panel ----------------------------------------------------- //
function stateColor(state, type) {
  if (!curSnap || !curSnap.palette) return "#888";
  return colorOf(curSnap.palette, state, type);
}

function renderTrackPanel(step, snap) {
  const box = el("trackChips");
  if (!trackedIds.length) {
    box.innerHTML = '<p class="muted small">尚未追踪任何个体。点击画布中的个体，或在上方输入 id。</p>';
    el("trackDetail").innerHTML = "";
    return;
  }
  box.innerHTML = trackedIds.map((id) => {
    const upTo = (trackCache[id] || []).filter((p) => p.step <= step);
    const last = upTo.length ? upTo[upTo.length - 1] : null;
    // Presence is evaluated AT the displayed shard: every live individual has
    // a point there; a smaller step number means it has already vanished.
    const present = last && last.step === step;
    const status = !last ? '<span class="tag muted">未出现</span>'
      : present ? '<span class="tag green">在场</span>'
      : '<span class="tag red">已消失</span>';
    const sel = id === selectedDetailId ? " selected" : "";
    const stateTxt = last
      ? `<span class="swatch" style="background:${stateColor(last.state, last.type)}"></span>${esc(last.state)}`
      : "";
    return `<div class="track-chip${sel}" data-id="${esc(id)}">
      <span class="dot" style="background:${colorFor(id)}"></span>
      <span class="id">${esc(id)}</span>${status}${stateTxt}
      <button class="x" data-remove="${esc(id)}" title="取消追踪">✕</button>
    </div>`;
  }).join("");

  if (!selectedDetailId || !trackedIds.includes(selectedDetailId)) {
    selectedDetailId = trackedIds[trackedIds.length - 1];
  }
  renderTrackDetail(selectedDetailId, step);
}

const DETAIL_EXTRA = new Set(["id", "type", "state", "x", "y", "step"]);

function renderTrackDetail(id, step) {
  const box = el("trackDetail");
  const all = trackCache[id] || [];
  const pts = all.filter((p) => p.step <= step);
  const observedIdx = new Map(cacheObserved.map((s, i) => [s, i]));
  if (!all.length) {
    box.innerHTML = `<h4 class="track-h"><span class="dot" style="background:${colorFor(id)}"></span>${esc(id)}</h4>
      <p class="muted small">该 id 在已保存的快照中从未出现（可能已输错，或运行尚未运行到其出现的时间步）。</p>`;
    return;
  }
  if (!pts.length) {
    const firstAt = all[0].step;
    box.innerHTML = `<h4 class="track-h"><span class="dot" style="background:${colorFor(id)}"></span>${esc(id)}</h4>
      <p class="muted small">该个体在第 ${firstAt} 步才中途出现；当前查看的第 ${step} 步尚无它的轨迹。向右拖动时间轴即可看到其起点。</p>`;
    return;
  }

  // Build state-change rows; annotate appearance / disappearance events.
  const rows = [];
  const firstObs = cacheObserved[0];
  pts.forEach((p, i) => {
    const prev = i ? pts[i - 1] : null;
    const prevIdx = prev ? observedIdx.get(prev.step) : null;
    const thisIdx = observedIdx.get(p.step);
    const reappeared = prev && thisIdx !== prevIdx + 1;
    const changed = !prev || p.state !== prev.state;
    let event = "";
    if (!prev && p.step > firstObs) event = '<span class="ev green">中途出现</span>';
    else if (reappeared) event = '<span class="ev green">再次出现</span>';
    if (changed) {
      rows.push(`<tr class="change${event ? " has-ev" : ""}">
        <td class="num">${p.step}</td>
        <td><span class="swatch" style="background:${stateColor(p.state, p.type)}"></span><strong>${esc(p.state)}</strong></td>
        <td class="num">${fmt(p.x)}, ${fmt(p.y)}</td><td>${event}</td></tr>`);
    }
  });
  const last = pts[pts.length - 1];
  const present = last.step === step;
  const extraKeys = [...new Set(pts.flatMap((p) =>
    Object.keys(p).filter((k) => !DETAIL_EXTRA.has(k) && typeof p[k] !== "object")))];
  const extra = last && extraKeys.length
    ? `<p class="muted small" style="margin:8px 0 0">${extraKeys
        .map((k) => `${esc(k)}=${fmt(last[k])}`).join(" · ")}</p>`
    : "";
  let fateLine;
  if (present) {
    fateLine = `<p class="ev-line green">从第 ${pts[0].step} 步${pts[0].step > firstObs ? "（中途出现）" : ""}持续追踪至当前第 ${last.step} 步，当前在场。</p>`;
  } else {
    fateLine = `<p class="ev-line red">在第 ${last.step} 步的快照后消失（驶离 / 被吃 / 被捕杀 / 移除等），轨迹到此为止。</p>`;
  }

  box.innerHTML = `
    <h4 class="track-h"><span class="dot" style="background:${colorFor(id)}"></span>${esc(id)}
      <span class="muted small">状态变化序列（截至第 ${last.step} 步）</span></h4>
    <div class="seq-scroll">
      <table class="seq-table">
        <thead><tr><th>步</th><th>状态</th><th>位置 (x, y)</th><th>事件</th></tr></thead>
        <tbody>${rows.join("") || '<tr><td colspan="4" class="muted">无变化</td></tr>'}</tbody>
      </table>
    </div>
    ${fateLine}
    ${extra}`;
}

// --- selection interactions ----------------------------------------------- //
function untrack(id) {
  const i = trackedIds.indexOf(id);
  if (i >= 0) trackedIds.splice(i, 1);
  delete trackCache[id];
  if (selectedDetailId === id) selectedDetailId = trackedIds[trackedIds.length - 1] || null;
  loadStep(parseInt(el("timeline").value, 10));
}

function toggleTrack(id) {
  const i = trackedIds.indexOf(id);
  if (i >= 0) {
    // Clicking a tracked individual untracks it (keep others untouched).
    trackedIds.splice(i, 1);
    delete trackCache[id];
    if (selectedDetailId === id) selectedDetailId = trackedIds[trackedIds.length - 1] || null;
  } else {
    trackedIds.push(id);
    selectedDetailId = id;
    // New id is not covered by any earlier range fetch -> refetch full range.
    cacheTo = null;
  }
  loadStep(parseInt(el("timeline").value, 10));
}

async function addTrackById() {
  const id = el("trackIdInput").value.trim();
  if (!id) return;
  el("trackIdInput").value = "";
  if (!trackedIds.includes(id)) {
    trackedIds.push(id);
    selectedDetailId = id;
    cacheTo = null;
  }
  await loadStep(parseInt(el("timeline").value, 10));
}

// --- run / playback ------------------------------------------------------- //
async function loadRun(id, wantStep) {
  runId = id;
  cacheVersion += 1;
  trackedIds.length = 0;
  for (const k of Object.keys(trackCache)) delete trackCache[k];
  cacheTo = null;
  cacheObserved = [];
  selectedDetailId = null;
  meta = await get(`/api/runs/${id}`);
  const { steps } = await get(`/api/runs/${id}/steps`);
  savedSteps = steps.length ? steps : [0];
  maxIdx = savedSteps.length - 1;
  el("timeline").max = maxIdx;
  el("t0").textContent = String(savedSteps[0]);
  el("t1").textContent = String(savedSteps[maxIdx]);

  // Deep link: replay.html?run=..&step=..&track=id1,id2
  const q = new URLSearchParams(window.location.search);
  let idx = maxIdx;
  if (wantStep != null) idx = savedSteps.indexOf(nearestStep(savedSteps, wantStep));
  else if (q.get("step") != null) idx = savedSteps.indexOf(nearestStep(savedSteps, +q.get("step")));
  const t = (q.get("track") || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (t.length) { trackedIds.push(...new Set(t)); selectedDetailId = trackedIds[0]; }
  await loadStep(idx < 0 ? maxIdx : idx);
}

function play() {
  if (!runId) return;
  if (playing) { stopPlay(); return; }
  let s = parseInt(el("timeline").value, 10);
  if (s >= maxIdx) s = 0;
  playing = true;
  el("playBtn").textContent = "⏸ 暂停";
  const loop = () => {
    if (!playing) return;
    loadStep(s);
    s = s + 1 > maxIdx ? 0 : s + 1;
    playTimer = setTimeout(loop, 160);
  };
  loop();
}

function stopPlay() {
  playing = false;
  if (playTimer) clearTimeout(playTimer);
  el("playBtn").textContent = "▶ 播放";
}

async function init() {
  el("runSelect").onchange = (e) => { if (e.target.value) loadRun(e.target.value); };
  el("refreshBtn").onclick = async () => { await fillRunSelect(el("runSelect")); };
  el("playBtn").onclick = play;
  el("timeline").oninput = debounce((e) => loadStep(parseInt(e.target.value, 10)), 120);

  el("showTracks").onchange = () => loadStep(parseInt(el("timeline").value, 10));
  el("clearTracksBtn").onclick = () => {
    trackedIds.length = 0;
    for (const k of Object.keys(trackCache)) delete trackCache[k];
    cacheTo = null; cacheObserved = [];
    selectedDetailId = null;
    loadStep(parseInt(el("timeline").value, 10));
  };
  el("trackIdBtn").onclick = addTrackById;
  el("trackIdInput").onkeydown = (e) => { if (e.key === "Enter") addTrackById(); };

  el("trackChips").addEventListener("click", (e) => {
    const rm = e.target.closest("[data-remove]");
    if (rm) { untrack(rm.dataset.remove); e.stopPropagation(); return; }
    const chip = e.target.closest(".track-chip");
    if (chip) { selectedDetailId = chip.dataset.id; renderTrackPanel(curStep, curSnap); }
  });

  el("canvas").addEventListener("click", (e) => {
    if (!curView || !curSnap) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const hit = pickIndividual(curView, curSnap.individuals || [],
                               e.clientX - rect.left, e.clientY - rect.top);
    if (hit) toggleTrack(hit.id);
  });

  await fillRunSelect(el("runSelect"));
  const q = new URLSearchParams(window.location.search).get("run");
  if (q && el("runSelect").querySelector(`option[value="${q}"]`)) {
    el("runSelect").value = q;
    const step = new URLSearchParams(window.location.search).get("step");
    await loadRun(q, step == null ? undefined : +step);
  } else if (el("runSelect").options.length > 1) {
    el("runSelect").selectedIndex = 1;
    await loadRun(el("runSelect").value);
  }
}

init().catch((e) => console.error(e));
