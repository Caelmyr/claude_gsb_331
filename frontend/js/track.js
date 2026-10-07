/* Individual trajectory tracking.
 *
 * A track is reconstructed server-side by joining per-step snapshots **by the
 * stable individual id** (never by proximity/state), so each polyline belongs
 * to exactly one individual even when neighbours overlap.  This module:
 *
 *   1. fetches /tracks for one or several ids of a run and caches per run;
 *   2. draws the step-0..current polylines on top of the snapshot canvas,
 *      breaking lines at "absent" gaps (birth / death / drive-off / re-entry)
 *      and at "wrap" gaps (periodic ring/torus seam crossings);
 *   3. renders the tracked list (color chips, lifecycle badges) and the
 *      per-individual state-change sequence panel.
 *
 * Coordinates are projected with the same geometry the base renderer uses
 * (ring strip / multi-lane CA / lattice cells / continuous points).
 */

const TRACK_COLORS = [
  "#ffd166", "#06d6a0", "#ef476f", "#a78bfa", "#f97316",
  "#22d3ee", "#f472b6", "#a3e635", "#e879f9", "#facc15",
  "#38bdf8", "#fb7185", "#4ade80", "#c084fc", "#fbbf24",
];

const trackState = {
  runId: null,
  domain: null,
  model: null,
  palette: {},
  topology: { wrap_x: false, wrap_y: false },
  order: [],          // tracked ids in add order
  map: {},            // id -> server track
  colors: {},         // id -> assigned color
  focusId: null,
  maxStep: 0,         // server data covers steps up to this
  loading: null,      // in-flight promise
};

function trackColor(id) {
  if (!trackState.colors[id]) {
    const used = new Set(Object.values(trackState.colors));
    trackState.colors[id] =
      TRACK_COLORS.find((c) => !used.has(c)) ||
      TRACK_COLORS[trackState.order.length % TRACK_COLORS.length];
  }
  return trackState.colors[id];
}

function resetTracks(runId, domain, model) {
  trackState.runId = runId;
  trackState.domain = domain;
  trackState.model = model;
  trackState.palette = {};
  trackState.topology = { wrap_x: false, wrap_y: false };
  trackState.order = [];
  trackState.map = {};
  trackState.colors = {};
  trackState.focusId = null;
  trackState.maxStep = 0;
  trackState.loading = null;
}

function trackedList() {
  return trackState.order.map((id) => ({ id, track: trackState.map[id] }));
}

/* ------------------------------------------------------------------ */
/* Data fetching                                                       */
/* ------------------------------------------------------------------ */
async function ensureTracks(ids, toStep) {
  const missing = ids.filter((id) => !(id in trackState.map));
  const needFetch = missing.length > 0 || toStep > trackState.maxStep;
  if (!needFetch) return;
  if (trackState.loading) await trackState.loading;
  // After the lock resolves, another caller may already have fetched enough.
  if (missing.every((id) => id in trackState.map) && toStep <= trackState.maxStep) {
    return;
  }
  const runId = trackState.runId;
  const qIds = [...new Set([...trackState.order, ...ids])];
  const promise = (async () => {
    const q = encodeURIComponent(qIds.join(","));
    const url = `/api/runs/${runId}/tracks?ids=${q}&to_step=${toStep}`;
    const data = await get(url);
    if (trackState.runId !== runId) return;  // run switched meanwhile
    trackState.topology = data.topology || trackState.topology;
    trackState.maxStep = data.to_step;
    for (const t of data.tracks) {
      trackState.map[t.id] = t;
      if (t.found && !trackState.order.includes(t.id)) {
        trackState.order.push(t.id);
        trackColor(t.id);
      }
    }
  })();
  trackState.loading = promise;
  try {
    await promise;
  } finally {
    trackState.loading = null;
  }
}

async function addTrack(id, toStep) {
  id = String(id).trim();
  if (!id) return;
  if (!trackState.order.includes(id)) trackState.order.push(id);
  trackState.focusId = id;
  trackColor(id);
  renderTrackPanel();
  await ensureTracks([id], toStep);
  const t = trackState.map[id];
  if (t && t.found === false) {
    showTrackNotice(`未在已保存快照中找到个体「${esc(id)}」：可能 id 不存在，或在第 0 步之前已消失。`, "warn");
  } else {
    showTrackNotice("");
  }
  renderTrackPanel();
}

function removeTrack(id) {
  trackState.order = trackState.order.filter((x) => x !== id);
  delete trackState.map[id];
  delete trackState.colors[id];
  if (trackState.focusId === id) {
    trackState.focusId = trackState.order[trackState.order.length - 1] || null;
  }
  showTrackNotice("");
}

function focusTrack(id) {
  trackState.focusId = id;
  renderTrackPanel();
}

/* ------------------------------------------------------------------ */
/* Geometry projection (mirrors render.js layout)                      */
/* ------------------------------------------------------------------ */
function viewGeometry(canvas, snap) {
  const bounds = snap.bounds || { width: 100, height: 100 };
  const W = Math.max(1, bounds.width), H = Math.max(1, bounds.height);
  const wrap = canvas.parentElement;
  const cw = canvas.clientWidth || Math.max(320, wrap.clientWidth || 900);
  const isRing = trackState.domain === "traffic" && trackState.model === "abm";
  const isTrafficCA = trackState.domain === "traffic" && trackState.model === "ca";
  let ch;
  if (isRing) ch = 70;
  else if (isTrafficCA) ch = Math.max(3, H) * 26;
  else if (snap.substrate) {
    const gh = snap.substrate.length, gw = snap.substrate[0].length || 1;
    ch = Math.round(cw * gh / gw);
  } else ch = Math.round(cw * H / W);
  return { cw, ch, W, H, isRing, isTrafficCA };
}

function projectPoint(p, g) {
  if (g.isRing) {
    return { x: p.x / g.W * g.cw, y: g.ch / 2 };
  }
  if (g.isTrafficCA) {
    // Cell rectangles are centered in their lane band / cell column.
    return { x: (p.x + 0.5) / g.W * g.cw, y: (p.y + 0.5) / g.H * g.ch };
  }
  return { x: p.x / g.W * g.cw, y: p.y / g.H * g.ch };
}

function unproject(mx, my, g) {
  if (g.isRing) return { x: mx / g.cw * g.W, y: 0 };
  if (g.isTrafficCA) return { x: mx / g.cw * g.W, y: my / g.ch * g.H };
  return { x: mx / g.cw * g.W, y: my / g.ch * g.H };
}

/* ------------------------------------------------------------------ */
/* Overlay drawing                                                     */
/* ------------------------------------------------------------------ */
function drawTracksOverlay(canvas, snap, currentStep) {
  trackState.palette = snap.palette || trackState.palette;
  const g = viewGeometry(canvas, snap);
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  for (const id of trackState.order) {
    const t = trackState.map[id];
    if (!t || !t.found) continue;
    const color = trackColor(id);
    const focused = id === trackState.focusId;
    const pts = t.points.filter((p) => p.step <= currentStep);
    if (!pts.length) continue;

    // Polyline: break at both absence gaps and periodic-seam wrap jumps.
    ctx.lineWidth = focused ? 2.4 : 1.4;
    ctx.strokeStyle = color;
    ctx.globalAlpha = focused ? 0.95 : 0.6;
    ctx.beginPath();
    let pen = false;
    for (const p of pts) {
      const q = projectPoint(p, g);
      if (!pen || p.gap === "absent" || p.gap === "wrap") {
        ctx.moveTo(q.x, q.y);
      } else {
        ctx.lineTo(q.x, q.y);
      }
      pen = true;
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Start marker of every life episode (birth / re-entry).
    const episodeStarts = pts.filter((p) => p.gap === "absent");
    if (pts[0].step === t.first_step) episodeStarts.unshift(pts[0]);
    for (const p of episodeStarts) {
      const q = projectPoint(p, g);
      ctx.fillStyle = p.step > t.sim_first_step ? "#ffffff" : color;
      ctx.strokeStyle = "#0a0e12";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(q.x, q.y, focused ? 4.5 : 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // End marker: last visible vertex (death/leave = ×, alive = ring).
    const last = pts[pts.length - 1];
    const lq = projectPoint(last, g);
    const r = focused ? 5.5 : 4.5;
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    if (t.gone_before_end && last.step === t.last_step && last.step <= currentStep) {
      ctx.beginPath();
      ctx.moveTo(lq.x - r, lq.y - r); ctx.lineTo(lq.x + r, lq.y + r);
      ctx.moveTo(lq.x + r, lq.y - r); ctx.lineTo(lq.x - r, lq.y + r);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(lq.x, lq.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(lq.x, lq.y, 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // Label near the latest visible vertex for the focused track.
    if (focused) {
      ctx.font = "11px " + (getComputedStyle(document.body).fontFamily || "sans-serif");
      ctx.fillStyle = "#fff";
      const label = t.id;
      let lx = lq.x + 8, ly = lq.y - 6;
      const tw = ctx.measureText(label).width;
      if (lx + tw > g.cw) lx = lq.x - 8 - tw;
      if (ly < 10) ly = lq.y + 16;
      ctx.fillStyle = "rgba(10,14,18,0.75)";
      ctx.fillRect(lx - 3, ly - 10, tw + 6, 14);
      ctx.fillStyle = color;
      ctx.fillText(label, lx, ly);
    }
  }
  ctx.restore();
}

/* Hit test: nearest individual in the current snapshot, used for click-to-track. */
function pickIndividual(mx, my, canvas, snap) {
  const g = viewGeometry(canvas, snap);
  const click = unproject(mx, my, g);
  let best = null, bestD = 14;   // screen-pixel tolerance
  for (const a of snap.individuals || []) {
    const q = projectPoint(a, g);
    const d = Math.hypot(q.x - mx, q.y - my);
    if (d < bestD) { bestD = d; best = a; }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Panel: tracked list + lifecycle badges + state-change sequence      */
/* ------------------------------------------------------------------ */
function stateColor(state, type) {
  const c = (trackState.palette[state] || trackState.palette[type] || {}).color;
  return c || "#cccccc";
}

function stateLabel(state) {
  return (trackState.palette[state] || {}).label || state;
}

function lifecycleBadges(t) {
  const b = [];
  if (t.born_after_start) {
    b.push(`<span class="track-badge born">第 ${t.first_step} 步新增</span>`);
  }
  if (t.gone_before_end) {
    b.push(`<span class="track-badge gone">第 ${t.last_step} 步${esc(t.end_reason)}</span>`);
  }
  if (!t.born_after_start && !t.gone_before_end) {
    b.push(`<span class="track-badge alive">全程在统</span>`);
  }
  if (t.segments && t.segments.length > 1) {
    b.push(`<span class="track-badge seg">${t.segments.length} 段（曾消失后重现）</span>`);
  }
  return b.join(" ");
}

function renderTrackPanel() {
  const listEl = el("trackList");
  const seqEl = el("trackSequence");
  if (!listEl || !seqEl) return;

  if (!trackState.order.length) {
    listEl.innerHTML = '<span class="muted small">尚未追踪任何个体。点击画布上的个体，或在下方输入 id 后回车。</span>';
    seqEl.innerHTML = "";
    return;
  }

  listEl.innerHTML = trackState.order.map((id) => {
    const t = trackState.map[id];
    const color = trackState.colors[id];
    const focused = id === trackState.focusId;
    if (!t || t.found === undefined) {
      return `<span class="track-chip ${focused ? "focus" : ""}" data-track="${esc(id)}">
        <span class="track-line" style="background:${color}"></span>
        <span class="mono">${esc(id)}</span>
        <span class="muted small">加载中…</span>
        <button class="track-x" data-remove="${esc(id)}" title="取消追踪">×</button></span>`;
    }
    if (t.found === false) {
      return `<span class="track-chip ${focused ? "focus" : ""}" data-track="${esc(id)}">
        <span class="track-line" style="background:${color}"></span>
        <span class="mono">${esc(id)}</span>
        <span class="track-badge gone">未找到</span>
        <button class="track-x" data-remove="${esc(id)}" title="取消追踪">×</button></span>`;
    }
    return `<span class="track-chip ${focused ? "focus" : ""}" data-track="${esc(id)}"
        title="第 ${t.first_step}–${t.last_step} 步，共 ${t.points.length} 个观测点">
      <span class="track-line" style="background:${color}"></span>
      <span class="mono">${esc(t.id)}</span>
      <span class="muted small">${esc(t.type || "")} · ${t.points.length}点</span>
      <button class="track-x" data-remove="${esc(id)}" title="取消追踪">×</button>
    </span>`;
  }).join("");

  const focusId = trackState.focusId;
  const t = focusId ? trackState.map[focusId] : null;
  if (!t || t.found !== true) {
    seqEl.innerHTML = focusId ? '<p class="muted small">该个体无可用轨迹数据。</p>' : "";
    return;
  }

  const color = trackState.colors[focusId];
  const runRows = t.states.map((r) => {
    const range = r.from === r.to ? `第 ${r.from} 步` : `第 ${r.from}–${r.to} 步`;
    return `<div class="state-run">
      <span class="state-dot" style="background:${stateColor(r.state)}"></span>
      <span class="mono">${esc(stateLabel(r.state))}</span>
      <span class="muted small">${range} · 持续 ${r.steps} 步</span></div>`;
  }).join("");

  // Detailed per-step sequence (newest first), highlighting the viewed step.
  const extraKeys = (() => {
    const keys = new Set();
    for (const p of t.points) {
      for (const k of Object.keys(p)) {
        if (!["step", "x", "y", "state", "type", "gap"].includes(k)) keys.add(k);
      }
    }
    return [...keys];
  })();

  const detailRows = t.points.slice().reverse().map((p) => {
    const gapTag = p.gap === "absent"
      ? '<span class="track-badge born">重新出现（前段已结束）</span>'
      : p.gap === "wrap" ? '<span class="track-badge seg">跨越环界</span>' : "";
    const extra = extraKeys.map((k) =>
      `<td class="num">${fmt(p[k])}</td>`).join("");
    return `<tr data-step="${p.step}">
      <td class="num">${p.step}</td>
      <td><span class="state-dot" style="background:${stateColor(p.state, p.type)}"></span>${esc(stateLabel(p.state))}</td>
      <td class="num">${fmt(p.x)}</td>
      <td class="num">${fmt(p.y)}</td>
      ${extra}
      <td>${gapTag}</td>
    </tr>`;
  }).join("");
  const extraHeads = extraKeys.map((k) => `<th class="num">${esc(k)}</th>`).join("");

  seqEl.innerHTML = `
    <div class="seq-head">
      <span class="track-line-lg" style="background:${color}"></span>
      <strong class="mono">${esc(t.id)}</strong>
      <span class="muted small">${esc(t.type || "")} · 观测第 ${t.first_step}–${t.last_step} 步 · ${t.points.length} 个位置点</span>
      <span style="flex:1"></span>${lifecycleBadges(t)}
    </div>
    <div class="seq-runs">${runRows}</div>
    <details class="seq-details">
      <summary class="muted small">查看逐步状态明细（${t.points.length} 行）</summary>
      <div style="overflow-x:auto;max-height:300px;overflow-y:auto;margin-top:8px">
        <table class="seq-table">
          <thead><tr><th class="num">步</th><th>状态</th><th class="num">x</th><th class="num">y</th>${extraHeads}<th>轨迹事件</th></tr></thead>
          <tbody>${detailRows}</tbody>
        </table>
      </div>
    </details>`;
}

function highlightSequenceStep(step) {
  const seqEl = el("trackSequence");
  if (!seqEl) return;
  seqEl.querySelectorAll("tr[data-step]").forEach((tr) => {
    tr.classList.toggle("at-step", parseInt(tr.dataset.step, 10) === step);
  });
  // Highlight the state run covering the current step.
  const t = trackState.focusId ? trackState.map[trackState.focusId] : null;
  if (!t || t.found !== true) return;
  const runs = seqEl.querySelectorAll(".state-run");
  t.states.forEach((r, i) => {
    if (runs[i]) runs[i].classList.toggle("at-step", r.from <= step && step <= r.to);
  });
}

function showTrackNotice(html, kind) {
  const n = el("trackNotice");
  if (!n) return;
  n.innerHTML = html || "";
  n.style.display = html ? "block" : "none";
  n.className = "notice " + (kind || "");
}

/* Bind the shared chip panel events once (event delegation). */
function bindTrackPanel() {
  const listEl = el("trackList");
  if (!listEl || listEl.dataset.bound) return;
  listEl.dataset.bound = "1";
  listEl.addEventListener("click", (e) => {
    const rm = e.target.closest("[data-remove]");
    if (rm) {
      e.stopPropagation();
      removeTrack(rm.dataset.remove);
      renderTrackPanel();
      if (window.onTracksChanged) window.onTracksChanged();
      return;
    }
    const chip = e.target.closest("[data-track]");
    if (chip) {
      focusTrack(chip.dataset.track);
      if (window.onTracksChanged) window.onTracksChanged();
    }
  });
  const input = el("trackIdInput");
  if (input) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && input.value.trim()) {
        const ids = input.value.split(",").map((s) => s.trim()).filter(Boolean);
        input.value = "";
        if (window.onAddTracks) window.onAddTracks(ids);
      }
    });
  }
  const clearBtn = el("trackClearBtn");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      [...trackState.order].forEach(removeTrack);
      renderTrackPanel();
      if (window.onTracksChanged) window.onTracksChanged();
    });
  }
}
