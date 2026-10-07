/* Individual management: list / filter / search per-run individuals. */

const PAGE_SIZE = 100;
let all = [];
let filtered = [];
let page = 0;
let columns = ["id", "type", "state", "x", "y"];
let selectedIds = new Set();   // cross-page selection used to jump to replay
let currentRunId = null;
let currentStep = 0;

async function refreshRuns() {
  const runs = await fillRunSelect(el("runSelect"));
  if (runs.length) {
    const r = runs[0];
    el("runSelect").value = r.id;
    el("stepInput").value = r.current_step;
  }
}

function nearestStep(steps, v) {
  if (!steps.length) return 0;
  return steps.reduce((p, c) => (Math.abs(c - v) < Math.abs(p - v) ? c : p), steps[0]);
}

async function load() {
  const runId = el("runSelect").value;
  if (!runId) { showNotice(el("summary"), "请先创建或选择一个运行。", "warn"); return; }
  if (runId !== currentRunId) selectedIds.clear();
  currentRunId = runId;
  let step = parseInt(el("stepInput").value || 0, 10);
  // Snap to a persisted snapshot (snapshots may be sharded at an interval > 1).
  const { steps } = await get(`/api/runs/${runId}/steps`);
  step = nearestStep(steps, step);
  el("stepInput").value = step;
  currentStep = step;
  const snap = await get(`/api/runs/${runId}/snapshot?step=${step}`);
  all = snap.individuals || [];
  // Drop stale selections (individuals that no longer exist / other run).
  const ids = new Set(all.map((a) => a.id));
  selectedIds = new Set([...selectedIds].filter((id) => ids.has(id)));

  // Build columns from extra keys on the first individual.
  const extra = [];
  if (all.length) {
    const first = all[0];
    for (const k of Object.keys(first)) {
      if (!["id", "type", "state", "x", "y"].includes(k)) extra.push(k);
    }
  }
  columns = ["id", "type", "state", "x", "y"].concat(extra.slice(0, 5));

  // Populate filter options.
  const types = [...new Set(all.map((a) => a.type))];
  const states = [...new Set(all.map((a) => a.state))];
  el("typeFilter").innerHTML = '<option value="">全部类型</option>' + types.map((t) => `<option>${esc(t)}</option>`).join("");
  el("stateFilter").innerHTML = '<option value="">全部状态</option>' + states.map((s) => `<option>${esc(s)}</option>`).join("");

  applyFilter();
  updateSelectionInfo();
}

function applyFilter() {
  const q = el("searchInput").value.trim().toLowerCase();
  const tf = el("typeFilter").value;
  const sf = el("stateFilter").value;
  filtered = all.filter((a) =>
    (!q || String(a.id).toLowerCase().includes(q)) &&
    (!tf || a.type === tf) &&
    (!sf || a.state === sf));
  page = 0;
  render();
}

function render() {
  const start = page * PAGE_SIZE;
  const rows = filtered.slice(start, start + PAGE_SIZE);
  const dataCols = columns;
  const head =
    '<th style="width:34px"><input type="checkbox" id="selAll" title="全选本页"></th>' +
    dataCols.map((c) => `<th class="${c === "x" || c === "y" ? "num" : ""}">${esc(c)}</th>`).join("") +
    '<th>操作</th>';
  const body = rows.map((a) => {
    const checked = selectedIds.has(a.id) ? "checked" : "";
    const cells = dataCols.map((c) => {
      const v = a[c];
      const cls = (c === "x" || c === "y" || typeof v === "number") ? "num" : "";
      return `<td class="${cls}">${fmt(v)}</td>`;
    }).join("");
    return `<tr data-ind="${esc(a.id)}" class="${selectedIds.has(a.id) ? "row-sel" : ""}">
      <td><input type="checkbox" class="sel-one" ${checked}></td>
      ${cells}
      <td><button class="btn small track-one">追踪</button></td>
    </tr>`;
  }).join("");
  const cols = dataCols.length + 2;
  el("itable").innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body || '<tr><td colspan="' + cols + '" class="muted">无数据</td></tr>'}</tbody>`;
  el("summary").textContent = `共 ${all.length} 个个体，筛选后 ${filtered.length} 个；类型列 = 车辆/动物/人，状态列 = 各自的状态标签。`;
  el("pageInfo").textContent = `第 ${page + 1} / ${Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))} 页`;
  el("prevBtn").disabled = page === 0;
  el("nextBtn").disabled = (page + 1) * PAGE_SIZE >= filtered.length;

  // Row interactions: checkbox, row click, single-track button.
  const tbody = el("itable").querySelector("tbody");
  tbody.addEventListener("change", (e) => {
    if (e.target.classList.contains("sel-one")) {
      const tr = e.target.closest("tr");
      const id = tr.dataset.ind;
      if (e.target.checked) selectedIds.add(id); else selectedIds.delete(id);
      tr.classList.toggle("row-sel", e.target.checked);
      updateSelectionInfo();
      syncSelAll();
    }
  });
  tbody.addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-ind]");
    if (!tr) return;
    if (e.target.closest(".track-one")) {
      goReplay([tr.dataset.ind]);
      return;
    }
    // Clicking a non-checkbox cell toggles selection.
    if (e.target.tagName !== "INPUT") {
      const id = tr.dataset.ind;
      if (selectedIds.has(id)) selectedIds.delete(id); else selectedIds.add(id);
      tr.classList.toggle("row-sel");
      const cb = tr.querySelector(".sel-one");
      if (cb) cb.checked = selectedIds.has(id);
      updateSelectionInfo();
      syncSelAll();
    }
  });

  el("selAll").onchange = (e) => {
    for (const a of rows) {
      if (e.target.checked) selectedIds.add(a.id); else selectedIds.delete(a.id);
    }
    render();
    updateSelectionInfo();
  };
  syncSelAll();
}

function syncSelAll() {
  const cb = el("selAll");
  if (!cb) return;
  const start = page * PAGE_SIZE;
  const rows = filtered.slice(start, start + PAGE_SIZE);
  cb.checked = rows.length > 0 && rows.every((a) => selectedIds.has(a.id));
}

function updateSelectionInfo() {
  const n = selectedIds.size;
  el("trackSelInfo").textContent = n
    ? `已选择 ${n} 个个体：${[...selectedIds].slice(0, 5).join("、")}${n > 5 ? " …" : ""}`
    : "未选择个体（点击表格行或勾选框选择，可跨页/跨筛选选择）";
  el("trackSelBtn").disabled = n === 0;
}

function goReplay(ids) {
  if (!currentRunId || !ids.length) return;
  const q = new URLSearchParams({ run: currentRunId, tracks: ids.slice(0, 30).join(",") });
  window.location.href = `/replay.html?${q.toString()}`;
}

function init() {
  el("loadBtn").onclick = load;
  el("prevBtn").onclick = () => { if (page > 0) { page--; render(); } };
  el("nextBtn").onclick = () => { if ((page + 1) * PAGE_SIZE < filtered.length) { page++; render(); } };
  el("searchInput").oninput = debounce(applyFilter, 200);
  el("typeFilter").onchange = applyFilter;
  el("stateFilter").onchange = applyFilter;
  el("clearSelBtn").onclick = () => { selectedIds.clear(); render(); updateSelectionInfo(); };
  el("trackSelBtn").onclick = () => goReplay([...selectedIds]);
  el("runSelect").onchange = async (e) => {
    if (!e.target.value) return;
    selectedIds.clear();
    const meta = await get(`/api/runs/${e.target.value}`);
    el("stepInput").value = meta.current_step;
    load();
  };
  refreshRuns().then(load).catch((e) => showNotice(el("summary"), "加载失败：" + e.message, "error"));
}

init();
