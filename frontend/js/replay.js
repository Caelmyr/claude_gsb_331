/* Replay & timeline: scrub through sharded per-step snapshots. */

let runId = null;
let meta = null;
let savedSteps = [];
let maxIdx = 0;
let playing = false;
let playTimer = null;
let currentSnap = null;
let currentStep = 0;

function renderStats(stats) {
  el("statTiles").innerHTML = Object.entries(stats || {}).map(([k, v]) => `
    <div class="stat"><div class="k">${esc(k)}</div><div class="v">${fmt(v)}</div></div>`).join("");
}

function drawCurrent() {
  if (!currentSnap) return;
  renderSnapshot(el("canvas"), currentSnap, meta.domain, meta.model);
  drawTracksOverlay(el("canvas"), currentSnap, currentStep);
  highlightSequenceStep(currentStep);
}

async function loadStep(idx) {
  const step = savedSteps[idx];
  const snap = await get(`/api/runs/${runId}/snapshot?step=${step}`);
  currentSnap = snap;
  currentStep = step;
  renderSnapshot(el("canvas"), snap, meta.domain, meta.model);
  renderLegend(el("legend"), snap.palette);
  renderStats(snap.stats);
  el("stepLabel").textContent = `第 ${step} 步`;
  el("timeline").value = idx;
  // Extend tracks if the run gained new steps since the last fetch.
  if (trackState.order.length && step > trackState.maxStep) {
    ensureTracks(trackState.order, step).then(() => {
      drawTracksOverlay(el("canvas"), currentSnap, currentStep);
      renderTrackPanel();
    }).catch(() => {});
  }
  drawTracksOverlay(el("canvas"), snap, step);
  highlightSequenceStep(step);
}

async function loadRun(id, trackIds = []) {
  runId = id;
  stopPlay();
  meta = await get(`/api/runs/${id}`);
  resetTracks(id, meta.domain, meta.model);
  showTrackNotice("");
  const { steps } = await get(`/api/runs/${id}/steps`);
  savedSteps = steps.length ? steps : [0];
  maxIdx = savedSteps.length - 1;
  el("timeline").max = maxIdx;
  el("t0").textContent = String(savedSteps[0]);
  el("t1").textContent = String(savedSteps[maxIdx]);
  renderTrackPanel();
  await loadStep(maxIdx);
  if (trackIds.length) {
    await addTracks(trackIds, savedSteps[maxIdx]);
  }
}

async function addTracks(ids, toStep) {
  const step = toStep != null ? toStep : currentStep;
  for (const id of ids) {
    if (!trackState.order.includes(id)) trackState.order.push(id);
    trackState.focusId = id;
    trackColor(id);
  }
  renderTrackPanel();
  await ensureTracks(ids, step);
  // Report unknown ids.
  const unknown = ids.filter((id) => trackState.map[id] && trackState.map[id].found === false);
  if (unknown.length) {
    showTrackNotice(`未在已保存快照中找到：${unknown.map(esc).join("、")}（id 不存在，或在第 0 步前已消失）。`, "warn");
  } else {
    showTrackNotice("");
  }
  renderTrackPanel();
  drawCurrent();
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
    playTimer = setTimeout(loop, 120);
  };
  loop();
}

function stopPlay() {
  playing = false;
  if (playTimer) clearTimeout(playTimer);
  const btn = el("playBtn");
  if (btn) btn.textContent = "▶ 播放";
}

function bindCanvasPicking() {
  const canvas = el("canvas");
  canvas.style.cursor = "crosshair";
  canvas.addEventListener("click", (e) => {
    if (!currentSnap) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const hit = pickIndividual(mx, my, canvas, currentSnap);
    if (hit) addTracks([hit.id]);
  });
}

async function init() {
  bindTrackPanel();
  bindCanvasPicking();
  window.onAddTracks = (ids) => addTracks(ids);
  window.onTracksChanged = () => drawCurrent();

  el("runSelect").onchange = (e) => { if (e.target.value) loadRun(e.target.value); };
  el("refreshBtn").onclick = async () => { await fillRunSelect(el("runSelect")); };
  el("playBtn").onclick = play;
  el("timeline").oninput = debounce((e) => loadStep(parseInt(e.target.value, 10)), 120);

  await fillRunSelect(el("runSelect"));
  const qRun = new URLSearchParams(window.location.search).get("run");
  const qTracks = (new URLSearchParams(window.location.search).get("tracks") || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (qRun && el("runSelect").querySelector(`option[value="${qRun}"]`)) {
    el("runSelect").value = qRun;
    await loadRun(qRun, qTracks);
  } else if (el("runSelect").options.length > 1) {
    el("runSelect").selectedIndex = 1;
    await loadRun(el("runSelect").value, qTracks);
  }
}

init().catch((e) => console.error(e));
