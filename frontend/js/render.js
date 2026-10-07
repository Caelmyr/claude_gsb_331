/* Canvas renderer shared by the real-time visualization and replay pages.

 * `renderSnapshot(canvas, snap, domain, model)` draws a simulation snapshot
 * (bounds + palette + individuals + optional substrate) onto a 2D canvas.  It
 * is domain-agnostic: colors come from the snapshot palette, and the drawing
 * mode (road strip / lattice cells / continuous points) is chosen from the
 * domain/model plus the coordinate type of the individuals.
 */

function colorOf(palette, state, type) {
  const c = (palette[state] || palette[type] || {}).color;
  return c || "#cccccc";
}

function isCellLike(inds) {
  if (!inds.length) return false;
  const sample = inds.slice(0, 10);
  return sample.every((a) => Number.isInteger(a.x) && Number.isInteger(a.y));
}

function drawPoints(ctx, inds, cw, ch, W, H, palette) {
  const r = Math.max(1.5, Math.min(4, cw / 320));
  for (const a of inds) {
    ctx.fillStyle = colorOf(palette, a.state, a.type);
    ctx.beginPath();
    ctx.arc(a.x / W * cw, a.y / H * ch, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawCells(ctx, inds, cw, ch, W, H, palette) {
  const cw1 = cw / W, ch1 = ch / H;
  for (const a of inds) {
    ctx.fillStyle = colorOf(palette, a.state, a.type);
    ctx.fillRect(a.x * cw1, a.y * ch1, Math.max(1, cw1), Math.max(1, ch1));
  }
}

function drawLanes(ctx, cw, ch, lanes) {
  ctx.strokeStyle = "#1f2a37";
  ctx.lineWidth = 1;
  for (let i = 1; i < lanes; i++) {
    const y = i / lanes * ch;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cw, y); ctx.stroke();
  }
}

function drawRing(ctx, inds, cw, ch, L, palette) {
  const mid = ch / 2;
  ctx.strokeStyle = "#26313f";
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(cw, mid); ctx.stroke();
  for (const a of inds) {
    ctx.fillStyle = colorOf(palette, a.state, a.type);
    ctx.fillRect(a.x / L * cw - 2, mid - 5, 4, 10);
  }
}

function drawSubstrate(ctx, substrate, cw, ch) {
  const gh = substrate.length, gw = substrate[0].length || 1;
  const cw1 = cw / gw, ch1 = ch / gh;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      ctx.fillStyle = substrate[y][x] ? "#1e3b2a" : "#0c1116";
      ctx.fillRect(x * cw1, y * ch1, cw1 + 0.5, ch1 + 0.5);
    }
  }
}

function renderSnapshot(canvas, snap, domain, model) {
  const ctx = canvas.getContext("2d");
  const bounds = snap.bounds || { width: 100, height: 100 };
  const W = Math.max(1, bounds.width), H = Math.max(1, bounds.height);
  const inds = snap.individuals || [];
  const palette = snap.palette || {};
  const substrate = snap.substrate || null;
  const wrap = canvas.parentElement;
  const maxW = Math.max(320, wrap.clientWidth || 900);
  const dpr = window.devicePixelRatio || 1;

  let cw, ch;
  const isRing = domain === "traffic" && model === "abm";
  const isTrafficCA = domain === "traffic" && model === "ca";

  if (isRing) {
    cw = maxW; ch = 70;
  } else if (isTrafficCA) {
    const laneH = 26;
    cw = maxW; ch = Math.max(3, H) * laneH;
  } else if (substrate) {
    const gh = substrate.length, gw = substrate[0].length || 1;
    cw = maxW; ch = Math.round(cw * gh / gw);
  } else {
    cw = maxW; ch = Math.round(cw * H / W);
  }

  canvas.width = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
  canvas.style.height = ch + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#0a0e12";
  ctx.fillRect(0, 0, cw, ch);

  if (isRing) {
    drawRing(ctx, inds, cw, ch, W, palette);
  } else if (isTrafficCA) {
    drawLanes(ctx, cw, ch, H);
    drawCells(ctx, inds, cw, ch, W, H, palette);
  } else if (substrate) {
    drawSubstrate(ctx, substrate, cw, ch);
    drawCells(ctx, inds, cw, ch, W, H, palette);
  } else if (isCellLike(inds)) {
    drawCells(ctx, inds, cw, ch, W, H, palette);
  } else {
    drawPoints(ctx, inds, cw, ch, W, H, palette);
  }

  /* View descriptor shared by the trajectory overlay and canvas hit-testing
   * (tracks must project with exactly the same geometry as the snapshot). */
  return { cw, ch, W, H, mode: isRing ? "ring" : isTrafficCA ? "trafficCells"
    : substrate || isCellLike(inds) ? "cells" : "points" };
}

function renderLegend(container, palette) {
  if (!container) return;
  container.innerHTML = Object.entries(palette)
    .map(([key, v]) => `<span class="item"><span class="swatch" style="background:${v.color}"></span>${esc(v.label || key)}</span>`)
    .join("");
}

/* ==========================================================================
 * Individual trajectory tracking overlay
 *
 * A "track" is the point sequence of ONE id, joined strictly by id on the
 * backend.  The renderer never re-associates points with another individual:
 * polyline segments are only drawn between two snapshots that are consecutive
 * in the *observed* shard list AND in the same world copy of a toroidal world.
 * Any other gap (id missing mid-run = vehicle gone / eaten / culled; torus
 * wrap = crossed the periodic boundary) starts a new, disconnected segment.
 * ========================================================================== */

/* High-contrast palette assigned per tracked individual (distinct from the
 * state palette so two tracked agents never blend into one line). */
const TRACK_COLORS = [
  "#f1c40f", "#00e5ff", "#ff79c6", "#a3e635", "#fb923c",
  "#c084fc", "#22d3ee", "#facc15", "#f472b6", "#4ade80",
  "#60a5fa", "#fda4af", "#bef264", "#e879f9", "#2dd4bf",
];

function trackColorAt(i) {
  return TRACK_COLORS[i % TRACK_COLORS.length];
}

const TRACK_LABEL_FONT =
  '-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

function trackProject(view, p) {
  const { cw, ch, W, H, mode } = view;
  if (mode === "ring") {
    return { px: p.x / W * cw, py: ch / 2 };
  }
  if (mode === "trafficCells" || mode === "cells") {
    const cw1 = cw / W, ch1 = ch / H;
    return { px: p.x * cw1 + cw1 / 2, py: p.y * ch1 + ch1 / 2 };
  }
  return { px: p.x / W * cw, py: p.y / H * ch };
}

/* A jump larger than half the torus is a wrap-around crossing, not real
 * motion — the polyline must break there instead of slashing across canvas. */
function torusWrapped(view, a, b) {
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  if (view.mode === "ring") return dx > view.W / 2;
  return dx > view.W / 2 || dy > view.H / 2;
}

/* Split one id's points into drawable segments over [observedSteps].
 * Each segment records why it starts: ``"first"`` (first segment), ``"gap"``
 * (id was absent in an intermediate shard: death/departure then reappearance)
 * or ``"wrap"`` (torus boundary crossing — same individual, new screen line). */
function buildTrackSegments(points, observedSteps, view) {
  const idxOf = new Map(observedSteps.map((s, i) => [s, i]));
  const segments = [];
  let cur = null;
  for (const p of points) {
    if (!cur) {
      cur = { reason: "first", points: [p] };
      continue;
    }
    const prev = cur.points[cur.points.length - 1];
    const adjacent = idxOf.has(prev.step) && idxOf.has(p.step) &&
      idxOf.get(p.step) === idxOf.get(prev.step) + 1;
    if (adjacent && !torusWrapped(view, prev, p)) {
      cur.points.push(p);
    } else {
      segments.push(cur);
      cur = { reason: !adjacent ? "gap" : "wrap", points: [p] };
    }
  }
  if (cur) segments.push(cur);
  return segments;
}

/* Draw all tracked trajectories (up to step `windowEnd`) over a snapshot. */
function renderTracks(canvas, tracks, view, observedSteps, windowEnd, palette) {
  if (!view) return;
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const firstObs = observedSteps.length ? observedSteps[0] : 0;
  // A last point older than the displayed shard means the id has vanished
  // (vehicle driven off / eaten / culled …); compare against windowEnd only.
  const newestShard = windowEnd;
  const built = [];

  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // --- pass 1: polylines ------------------------------------------------ //
  for (const tr of tracks) {
    const pts = (tr.points || []).filter((p) => p.step <= windowEnd);
    if (!pts.length) continue;
    const segs = buildTrackSegments(pts, observedSteps, view);
    built.push({ tr, pts, segs });
    ctx.strokeStyle = tr.color;
    ctx.lineWidth = 1.8;
    ctx.globalAlpha = 0.85;
    for (const seg of segs) {
      ctx.beginPath();
      seg.points.forEach((p, i) => {
        const { px, py } = trackProject(view, p);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;

  // --- pass 2: per-step vertices (state-colored, track-colored ring) ---- //
  for (const { tr, pts } of built) {
    for (const p of pts) {
      const { px, py } = trackProject(view, p);
      ctx.beginPath();
      ctx.arc(px, py, 2.4, 0, Math.PI * 2);
      ctx.fillStyle = colorOf(palette || {}, p.state, p.type);
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = tr.color;
      ctx.stroke();
    }
  }

  // --- pass 3: endpoint markers ----------------------------------------- //
  for (const { tr, pts, segs } of built) {
    segs.forEach((seg, si) => {
      const segPts = seg.points;
      const a = segPts[0];
      // A real appearance mid-run: first segment but the id is not in the
      // first observed snapshot, or a later segment started after a shard gap
      // (a torus "wrap" segment is the same individual — no birth marker).
      const born = seg.reason === "wrap" ? false
        : si === 0 ? a.step > firstObs
        : seg.reason === "gap";
      const ap = trackProject(view, a);
      ctx.beginPath();
      ctx.arc(ap.px, ap.py, born ? 5 : 3.5, 0, Math.PI * 2);
      ctx.lineWidth = born ? 2 : 1.2;
      ctx.strokeStyle = born ? "#2ecc71" : tr.color;
      ctx.stroke();

      const z = segPts[segPts.length - 1];
      const isLastSeg = si === segs.length - 1;
      const dead = isLastSeg && seg.reason !== "wrap" && z.step < newestShard;
      const current = isLastSeg && z.step === windowEnd;
      const zp = trackProject(view, z);
      if (dead) {
        // Vanished mid-run (driven off / eaten / culled): red ✕.
        ctx.strokeStyle = "#e74c3c";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(zp.px - 4, zp.py - 4); ctx.lineTo(zp.px + 4, zp.py + 4);
        ctx.moveTo(zp.px + 4, zp.py - 4); ctx.lineTo(zp.px - 4, zp.py + 4);
        ctx.stroke();
      } else if (current) {
        // Alive at the displayed step: white halo + track-colored dot + id.
        ctx.beginPath();
        ctx.arc(zp.px, zp.py, 5.5, 0, Math.PI * 2);
        ctx.fillStyle = tr.color;
        ctx.fill();
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = "#ffffff";
        ctx.stroke();
        ctx.font = `600 10px ${TRACK_LABEL_FONT}`;
        ctx.fillStyle = "#ffffff";
        ctx.fillText(tr.id, zp.px + 7, zp.py - 6);
      } else {
        ctx.beginPath();
        ctx.arc(zp.px, zp.py, 3, 0, Math.PI * 2);
        ctx.fillStyle = tr.color;
        ctx.fill();
      }
    });
  }
}

/* Hit-test a canvas click against individuals (wrap-aware on the ring road). */
function pickIndividual(view, inds, mx, my) {
  let best = null;
  let bestD = Infinity;
  for (const a of inds) {
    const { px, py } = trackProject(view, a);
    let d;
    if (view.mode === "ring") {
      // Shortest arc along the ring, vertical distance to the centerline.
      const arc = Math.min(Math.abs(mx - px), view.cw - Math.abs(mx - px));
      d = Math.hypot(arc, my - py);
    } else {
      d = Math.hypot(mx - px, my - py);
    }
    if (d < bestD) { bestD = d; best = a; }
  }
  const threshold = view.mode === "points" || view.mode === "ring" ? 10
    : Math.max(8, Math.min(view.cw / view.W, view.ch / view.H));
  return bestD <= threshold ? best : null;
}
