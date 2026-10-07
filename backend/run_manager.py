"""Run lifecycle management: real-time stepping, batch runs, interventions.

A :class:`RunManager` owns the in-memory engines for the current server
process.  Every mutation funnels through :mod:`backend.storage` so the
atomic-write / time-step-sharding guarantees hold whether a step comes from the
UI or a background batch.  Engines are kept in memory while a run exists in
this process so a run can be stepped interactively; batch runs that belong to a
comparison experiment can drop their engine on completion to bound memory.

Concurrency: each run has its own re-entrant lock, so long batch runs on one
scene never block interactive stepping on another.
"""

from __future__ import annotations

import threading
from typing import Any, Dict, List, Optional

from . import models, storage, util
from .engine import make_engine
from .engine.base import Engine


class RunManager:
    def __init__(self) -> None:
        self._engines: Dict[str, Engine] = {}
        self._locks: Dict[str, threading.RLock] = {}
        self._abort: set = set()
        self._lock = threading.RLock()

    # ------------------------------------------------------------------ #
    # Internals
    # ------------------------------------------------------------------ #
    def _lock_for(self, run_id: str) -> threading.RLock:
        with self._lock:
            return self._locks.setdefault(run_id, threading.RLock())

    def _engine(self, run_id: str) -> Optional[Engine]:
        with self._lock:
            return self._engines.get(run_id)

    def _require(self, run_id: str) -> tuple:
        eng = self._engine(run_id)
        meta = storage.load_run_meta(run_id)
        if meta is None:
            raise KeyError(f"run not found: {run_id}")
        return eng, meta

    # ------------------------------------------------------------------ #
    # Create
    # ------------------------------------------------------------------ #
    def create_run(self, scene: models.Scene, name: Optional[str] = None,
                   seed: Optional[int] = None,
                   snapshot_interval: int = 1) -> Dict[str, Any]:
        config = models.resolve_config(scene)
        if seed is None:
            seed = int(config.get("seed", 0))
        engine = make_engine(scene.domain, scene.model, config=config, seed=seed)
        run_id = util.new_id("run")
        now = util.now_iso()
        meta: Dict[str, Any] = {
            "id": run_id,
            "name": name or f"{scene.name} · 运行",
            "scene_id": scene.id,
            "scene_name": scene.name,
            "domain": scene.domain,
            "model": scene.model,
            "config": config,
            "interventions": [{**i, "applied": False}
                              for i in scene.interventions],
            "snapshot_interval": max(1, int(snapshot_interval)),
            "status": "ready",
            "current_step": 0,
            "total_steps": 0,
            "seed": seed,
            "created_at": now,
            "updated_at": now,
        }
        storage.create_run_dir(run_id)
        storage.save_step(run_id, 0, engine.snapshot())
        storage.save_series(run_id, [{"step": 0, **engine.stats()}])
        storage.save_events(run_id, [])
        storage.save_run_meta(meta)
        with self._lock:
            self._engines[run_id] = engine
        return meta

    # ------------------------------------------------------------------ #
    # Stepping
    # ------------------------------------------------------------------ #
    def _apply_due(self, run_id: str, engine: Engine,
                   meta: Dict[str, Any], step: int) -> None:
        """Apply any scheduled intervention whose ``at_step`` has been reached."""
        events = storage.load_events(run_id)
        changed = False
        for itv in meta["interventions"]:
            if itv.get("applied"):
                continue
            if int(itv.get("at_step", 0)) <= step:
                result = engine.apply_intervention(itv)
                itv["applied"] = True
                events.append({"step": step, "type": itv["type"],
                               "params": itv.get("params", {}),
                               "scheduled": True, "result": result})
                changed = True
        if changed:
            storage.save_events(run_id, events)
            storage.save_run_meta(meta)

    def step(self, run_id: str, n: int = 1) -> Dict[str, Any]:
        """Advance ``n`` steps and return the current snapshot + stats."""
        with self._lock_for(run_id):
            engine, meta = self._require(run_id)
            if engine is None:
                raise RuntimeError("该运行未载入内存（服务器重启后不可续跑），请重开新运行")
            if meta["status"] in ("finished", "stopped"):
                meta["status"] = "ready"
            for _ in range(int(n)):
                self._apply_due(run_id, engine, meta, engine.step_count)
                engine.step()
                meta["current_step"] = engine.step_count
                meta["updated_at"] = util.now_iso()
                storage.append_series(run_id, {"step": engine.step_count,
                                               **engine.stats()})
                if engine.step_count % meta["snapshot_interval"] == 0:
                    storage.save_step(run_id, engine.step_count, engine.snapshot())
            storage.save_run_meta(meta)
            return {"step": engine.step_count, "stats": engine.stats(),
                    "snapshot": engine.snapshot()}

    def run_batch(self, run_id: str, steps: int,
                  snapshot_interval: Optional[int] = None,
                  keep_engine: bool = True) -> Dict[str, Any]:
        """Run ``steps`` steps to completion, returning final stats.

        Series rows are accumulated in memory and flushed periodically (and at
        the end) so the per-step write cost stays O(1) amortised even for very
        long runs.
        """
        with self._lock_for(run_id):
            engine, meta = self._require(run_id)
            if engine is None:
                raise RuntimeError("该运行未载入内存，请重开新运行")
            if snapshot_interval is not None:
                meta["snapshot_interval"] = max(1, int(snapshot_interval))
            meta["status"] = "running"
            storage.save_run_meta(meta)

            series = storage.load_series(run_id)
            self._abort.discard(run_id)
            for _ in range(int(steps)):
                if run_id in self._abort:
                    break
                self._apply_due(run_id, engine, meta, engine.step_count)
                engine.step()
                meta["current_step"] = engine.step_count
                series.append({"step": engine.step_count, **engine.stats()})
                if engine.step_count % meta["snapshot_interval"] == 0:
                    storage.save_step(run_id, engine.step_count, engine.snapshot())
                if engine.step_count % 50 == 0:
                    storage.save_series(run_id, series)
                    meta["updated_at"] = util.now_iso()
                    storage.save_run_meta(meta)

            meta["status"] = "stopped" if run_id in self._abort else "finished"
            meta["updated_at"] = util.now_iso()
            storage.save_series(run_id, series)
            storage.save_run_meta(meta)
            self._abort.discard(run_id)

            final = engine.snapshot()
            if not keep_engine:
                with self._lock:
                    self._engines.pop(run_id, None)
            return {"step": engine.step_count, "stats": engine.stats(),
                    "snapshot": final}

    # ------------------------------------------------------------------ #
    # Control
    # ------------------------------------------------------------------ #
    def pause(self, run_id: str) -> Dict[str, Any]:
        with self._lock_for(run_id):
            _, meta = self._require(run_id)
            meta["status"] = "paused"
            meta["updated_at"] = util.now_iso()
            storage.save_run_meta(meta)
            return meta

    def resume(self, run_id: str) -> Dict[str, Any]:
        with self._lock_for(run_id):
            _, meta = self._require(run_id)
            meta["status"] = "ready"
            meta["updated_at"] = util.now_iso()
            storage.save_run_meta(meta)
            return meta

    def stop(self, run_id: str) -> Dict[str, Any]:
        with self._lock_for(run_id):
            _, meta = self._require(run_id)
            with self._lock:
                self._abort.add(run_id)
            meta["status"] = "stopped"
            meta["updated_at"] = util.now_iso()
            storage.save_run_meta(meta)
            return meta

    def reset(self, run_id: str) -> Dict[str, Any]:
        with self._lock_for(run_id):
            _, meta = self._require(run_id)
            seed = meta.get("seed", 0)
            engine = make_engine(meta["domain"], meta["model"],
                                 config=meta["config"], seed=seed)
            with self._lock:
                self._engines[run_id] = engine
            for itv in meta["interventions"]:
                itv["applied"] = False
            meta["current_step"] = 0
            meta["status"] = "ready"
            meta["updated_at"] = util.now_iso()
            # Drop every shard of the previous run so the reset run can never
            # leak old trajectories into its timeline.
            storage.clear_steps(run_id)
            storage.save_step(run_id, 0, engine.snapshot())
            storage.save_series(run_id, [{"step": 0, **engine.stats()}])
            storage.save_events(run_id, [])
            storage.save_run_meta(meta)
            return meta

    def delete_run(self, run_id: str) -> bool:
        with self._lock_for(run_id):
            with self._lock:
                self._engines.pop(run_id, None)
                self._locks.pop(run_id, None)
                self._abort.discard(run_id)
            return storage.delete_run(run_id)

    # ------------------------------------------------------------------ #
    # Interventions
    # ------------------------------------------------------------------ #
    def apply_intervention(self, run_id: str,
                           itv: Dict[str, Any]) -> Dict[str, Any]:
        with self._lock_for(run_id):
            engine, meta = self._require(run_id)
            if engine is None:
                raise RuntimeError("该运行未载入内存，请重开新运行")
            result = engine.apply_intervention(itv)
            events = storage.load_events(run_id)
            events.append({"step": engine.step_count, "type": itv["type"],
                           "params": itv.get("params", {}),
                           "scheduled": False, "result": result})
            storage.save_events(run_id, events)
            meta["updated_at"] = util.now_iso()
            storage.save_run_meta(meta)
            return result

    # ------------------------------------------------------------------ #
    # Reads
    # ------------------------------------------------------------------ #
    def status(self, run_id: str) -> Dict[str, Any]:
        with self._lock_for(run_id):
            _, meta = self._require(run_id)
            out = dict(meta)
            engine = self._engine(run_id)
            if engine is not None:
                out["stats"] = engine.stats()
            return out

    def get_snapshot(self, run_id: str, step: Optional[int] = None) -> Dict[str, Any]:
        with self._lock_for(run_id):
            engine, meta = self._require(run_id)
            if step is None:
                step = meta["current_step"]
            if engine is not None and int(step) == engine.step_count:
                return engine.snapshot()
            snap = storage.load_step(run_id, int(step))
            if snap is None:
                raise KeyError(f"snapshot not found: step {step}")
            return snap

    def get_series(self, run_id: str) -> List[Dict[str, Any]]:
        with self._lock_for(run_id):
            self._require(run_id)
            return storage.load_series(run_id)

    def get_events(self, run_id: str) -> List[Dict[str, Any]]:
        with self._lock_for(run_id):
            self._require(run_id)
            return storage.load_events(run_id)

    def get_individuals(self, run_id: str, step: Optional[int] = None) -> List[Dict[str, Any]]:
        return self.get_snapshot(run_id, step).get("individuals", [])

    def get_trajectories(self, run_id: str, ids: List[str],
                         step_from: int = 0,
                         step_to: Optional[int] = None) -> Dict[str, Any]:
        """Join per-step snapshots into one trajectory per individual id.

        Joining is done *strictly by the stable ``id`` field* — never by
        position/state proximity — so two individuals that happen to occupy the
        same cell (or share a state, or one of which has already vanished) can
        never be stitched into the same polyline.  A step where an id is absent
        from the snapshot is simply missing from its ``points`` sequence; the
        frontend uses the gap to break the polyline and mark the birth/death
        endpoint (vehicle leaving the road, death, recovery of a removed
        individual, mid-run spawn, …).

        The most recent step may live only in the in-memory engine (the run is
        still stepping and the next sharding interval has not arrived), so it
        is merged from the engine whenever it falls inside the requested range.
        """
        with self._lock_for(run_id):
            engine, meta = self._require(run_id)
            wanted = set(ids)
            from_step = max(0, int(step_from))
            to_step = int(step_to) if step_to is not None else meta["current_step"]
            tracks: Dict[str, List[Dict[str, Any]]] = {i: [] for i in wanted}

            observed: List[int] = []
            for s in storage.list_steps(run_id):
                if s < from_step or s > to_step:
                    continue
                snap = storage.load_step(run_id, s)
                if snap is None:
                    continue
                observed.append(int(snap.get("step", s)))
                for a in snap.get("individuals", []):
                    aid = a.get("id")
                    if aid in wanted:
                        tracks[aid].append({**a, "step": int(snap.get("step", s))})

            live_step = engine.step_count if engine is not None else None
            if live_step is not None and from_step <= live_step <= to_step \
                    and live_step not in observed:
                observed.append(live_step)
                for a in engine.individuals():
                    aid = a.get("id")
                    if aid in wanted:
                        tracks[aid].append({**a, "step": live_step})

            observed.sort()
            return {"ids": list(wanted), "step_from": from_step,
                    "step_to": to_step, "observed_steps": observed,
                    "tracks": tracks}


# Global singleton used by the Flask app.
manager = RunManager()
