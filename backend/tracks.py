"""Per-individual trajectory reconstruction from sharded step snapshots.

Each persisted snapshot lists the individuals alive *at that step* as dicts
with a stable ``id``.  Tracking an individual therefore means joining the
snapshots **by id only** — proximity and equal state are deliberately never
used as matching keys, because two different individuals can stand on adjacent
cells and share the same state for long stretches (and a tracked individual
may itself disappear).  This guarantees every polyline vertex belongs to one
and the same individual: there is no "line switching".

From the join we derive, per requested id:

* ``points``  — one vertex per snapshot in which the individual is present.
  Each vertex carries a ``gap`` flag: ``"none"`` for a normal move,
  ``"absent"`` when the individual was missing in an intervening snapshot
  (death / leaving / later re-entry), and ``"wrap"`` when consecutive
  positions jump across a periodic-world seam (ring road / torus) so the
  overlay can break the polyline instead of drawing across the map.
* ``segments`` — the points split *only* at ``"absent"`` gaps, i.e. the
  continuous life episodes of the individual (a re-entrant animal gets
  several episodes).
* ``states`` — run-length encoded state-change sequence (state at each step
  the individual is observed, compressed into ranges) for the compact
  timeline; the full per-step points still carry ``v``/``energy``/… for the
  detailed table.
* lifecycle markers — ``first_step``/``last_step``, whether it was born after
  step 0, whether it is gone by the final snapshot, and the status / final
  position used for the end-of-track marker.

Snapshots may be sharded at an interval > 1; joining by id across whatever
snapshots exist is still exact — a missing *snapshot* is not confused with a
missing *individual*, because the absence check only fires when some snapshot
between two observations exists and does not contain the id.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence

from . import storage

# Extra per-individual attributes worth surfacing in the state table.
_EXTRA_KEYS = ("v", "energy", "age", "days", "heading", "vx", "vy",
               "hx", "hy", "hr")


def _slim(ind: Dict[str, Any], step: int) -> Dict[str, Any]:
    """Keep the fields the trajectory view needs from one snapshot record."""
    out: Dict[str, Any] = {
        "step": step,
        "x": ind.get("x"),
        "y": ind.get("y"),
        "state": ind.get("state"),
        "type": ind.get("type"),
    }
    for key in _EXTRA_KEYS:
        if key in ind:
            out[key] = ind[key]
    return out


def _is_wrap_jump(ax: float, ay: float, bx: float, by: float,
                  width: float, height: float,
                  wrap_x: bool, wrap_y: bool) -> bool:
    """True when moving a -> b crosses a periodic boundary seam."""
    if wrap_x and width > 0 and abs(bx - ax) > width / 2.0:
        return True
    if wrap_y and height > 0 and abs(by - ay) > height / 2.0:
        return True
    return False


def _collect(snapshots: Sequence[Dict[str, Any]],
             ids: Sequence[str]) -> Dict[str, List[Dict[str, Any]]]:
    """Single pass over all snapshots: group slim records by requested id.

    Iterating the (typically few hundred) snapshots once, and within each only
    the requested ids, keeps the cost at O(snapshots × tracked) rather than
    O(snapshots × population × tracked).
    """
    wanted = set(ids)
    by_id: Dict[str, List[Dict[str, Any]]] = {i: [] for i in ids}
    for snap in snapshots:
        step = int(snap.get("step", 0))
        for ind in snap.get("individuals", []):
            iid = ind.get("id")
            if iid in wanted:
                by_id[iid].append(_slim(ind, step))
    return by_id


def build_track(individual_id: str,
                points: List[Dict[str, Any]],
                present: Dict[int, bool],
                intermediate_steps: Sequence[int],
                sim_first: int, sim_last: int,
                width: float, height: float,
                topology: Dict[str, bool]) -> Optional[Dict[str, Any]]:
    """Annotate one individual's chronological points with gaps/lifecycle."""
    if not points:
        return None

    wrap_x = bool(topology.get("wrap_x"))
    wrap_y = bool(topology.get("wrap_y"))

    points[0]["gap"] = "none"
    for i in range(1, len(points)):
        prev, cur = points[i - 1], points[i]
        # A persisted snapshot strictly between the two observations that does
        # not contain this id => the individual truly vanished in between
        # (died / drove off / was culled), possibly reappearing later.
        was_absent = any(not present.get(s) for s in intermediate_steps
                         if prev["step"] < s < cur["step"])
        if was_absent:
            cur["gap"] = "absent"
        elif _is_wrap_jump(float(prev["x"]), float(prev["y"]),
                           float(cur["x"]), float(cur["y"]),
                           width, height, wrap_x, wrap_y):
            cur["gap"] = "wrap"
        else:
            cur["gap"] = "none"

    # Contiguous life episodes — split only at real absences; wrap crossings
    # stay in the same episode but break the drawn polyline.
    segments: List[List[Dict[str, Any]]] = [[points[0]]]
    for p in points[1:]:
        if p["gap"] == "absent":
            segments.append([p])
        else:
            segments[-1].append(p)

    # Run-length encoded state timeline (a state run also restarts after an
    # absence gap, since re-entry is a new life episode).
    state_runs: List[Dict[str, Any]] = []
    for p in points:
        if state_runs and state_runs[-1]["state"] == p["state"] \
                and p["gap"] != "absent":
            state_runs[-1]["to"] = p["step"]
            state_runs[-1]["steps"] += 1
        else:
            state_runs.append({"state": p["state"], "from": p["step"],
                               "to": p["step"], "steps": 1})

    first_step, last_step = points[0]["step"], points[-1]["step"]
    born = first_step > sim_first
    gone = last_step < sim_last
    if not gone:
        end_reason = "present"
    elif points[-1].get("type") == "vehicle":
        end_reason = "驶离/移除"
    elif points[-1].get("state") in ("rabbit", "boid"):
        end_reason = "死亡（被捕食/清除）"
    else:
        end_reason = "消失"

    return {
        "id": individual_id,
        "type": points[-1].get("type") or points[0].get("type"),
        "points": points,
        "segments": segments,
        "states": state_runs,
        "first_step": first_step,
        "last_step": last_step,
        "sim_first_step": sim_first,
        "sim_last_step": sim_last,
        "born_after_start": born,
        "gone_before_end": gone,
        "end_reason": end_reason,
        "final": points[-1],
        "initial": points[0],
        "found": True,
    }


def build_tracks(run_id: str, individual_ids: Sequence[str],
                 to_step: Optional[int] = None,
                 from_step: Optional[int] = None) -> Dict[str, Any]:
    """Load persisted snapshots of a run and rebuild tracks for several ids.

    Returns ``{"steps", "topology", "tracks"}`` with tracks in request order;
    ids never observed still get a ``"found": false`` entry so the UI can
    report an unknown / already-vanished id.
    """
    available = storage.list_steps(run_id)
    if not available:
        raise KeyError(f"no snapshots for run: {run_id}")
    if to_step is None:
        to_step = available[-1]
    wanted = [s for s in available if s <= int(to_step)]
    if from_step is not None:
        wanted = [s for s in wanted if s >= int(from_step)]
    if not wanted:
        wanted = [available[0]]

    snapshots: List[Dict[str, Any]] = []
    topology = {"wrap_x": False, "wrap_y": False}
    for s in wanted:
        snap = storage.load_step(run_id, s)
        if snap is None:
            continue
        snapshots.append(snap)
        topo = snap.get("topology")
        if topo:
            topology = {"wrap_x": bool(topo.get("wrap_x")),
                        "wrap_y": bool(topo.get("wrap_y"))}

    sim_first = int(snapshots[0].get("step", 0)) if snapshots else 0
    sim_last = int(snapshots[-1].get("step", 0)) if snapshots else 0
    bounds = (snapshots[-1].get("bounds") if snapshots else None) or {}
    width = float(bounds.get("width", 0) or 0)
    height = float(bounds.get("height", 0) or 0)
    step_numbers = [int(s.get("step", 0)) for s in snapshots]

    by_id = _collect(snapshots, individual_ids)
    tracks: List[Dict[str, Any]] = []
    for iid in individual_ids:
        pts = by_id.get(iid) or []
        present = {p["step"]: True for p in pts}
        track = build_track(iid, pts, present, step_numbers,
                            sim_first, sim_last, width, height, topology)
        tracks.append(track or {"id": iid, "found": False})

    return {
        "run_id": run_id,
        "from_step": sim_first,
        "to_step": sim_last,
        "available_steps": available,
        "topology": topology,
        "tracks": tracks,
    }
