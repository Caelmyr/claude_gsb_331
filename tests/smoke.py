"""Smoke tests for the simulation engines, storage and run lifecycle.

Run directly::

    python3 tests/smoke.py

Each check is independent and prints PASS / FAIL; the script exits non-zero on
the first failure so it can be wired into CI or a pre-commit hook.
"""

from __future__ import annotations

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend import models, report, storage, tracks  # noqa: E402
from backend.engine import make_engine  # noqa: E402
from backend.run_manager import manager  # noqa: E402

_ENGINES = ["traffic/ca", "traffic/abm", "ecology/ca", "ecology/abm",
            "epidemic/ca", "epidemic/abm"]


def check(name: str, fn) -> None:
    try:
        fn()
        print(f"PASS  {name}")
    except AssertionError as exc:
        print(f"FAIL  {name}: {exc}")
        sys.exit(1)
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL  {name}: {exc}")
        sys.exit(1)


def engines_step() -> None:
    for key in _ENGINES:
        d, m = key.split("/")
        eng = make_engine(d, m, seed=42)
        for _ in range(5):
            eng.step()
        assert eng.step_count == 5, key
        assert len(eng.individuals()) > 0, f"{key} has no individuals"
        stats = eng.stats()
        assert stats, f"{key} produced empty stats"
        snap = eng.snapshot()
        assert snap["step"] == 5
        assert snap["stats"] == stats


def interventions_apply() -> None:
    eng = make_engine("epidemic", "abm", seed=1)
    before = eng.stats()["susceptible"]
    res = eng.apply_intervention({"type": "vaccinate", "params": {"fraction": 1.0}})
    assert res["applied"], res
    assert eng.stats()["susceptible"] == 0
    assert before > 0


def storage_atomic_roundtrip() -> None:
    with tempfile.TemporaryDirectory() as td:
        # Redirect the module's DATA_DIR for this isolated check.
        old = storage.DATA_DIR
        storage.DATA_DIR = td
        try:
            storage.ensure_dirs()
            storage.save_scene({"id": "x", "name": "t", "updated_at": "z"})
            assert storage.load_scene("x")["name"] == "t"
            storage.save_step("r1", 0, {"step": 0, "v": 1})
            storage.save_step("r1", 7, {"step": 7, "v": 2})
            assert storage.load_step("r1", 7)["v"] == 2
            assert storage.list_steps("r1") == [0, 7]
        finally:
            storage.DATA_DIR = old


def run_lifecycle() -> None:
    scene = models.Scene(domain="epidemic", model="abm",
                         config={"n": 200, "width": 300, "height": 300,
                                 "initial_infected": 5})
    meta = manager.create_run(scene, seed=1, snapshot_interval=2)
    rid = meta["id"]
    try:
        r = manager.step(rid, 6)
        assert r["step"] == 6
        series = manager.get_series(rid)
        assert series[0]["step"] == 0 and series[-1]["step"] == 6
        assert len(manager.get_individuals(rid, 6)) == 200
        # snapshot_interval=2 -> full snapshots persisted at 0,2,4,6
        steps = storage.list_steps(rid)
        assert steps == [0, 2, 4, 6], steps
        rpt = report.generate_report(rid)
        assert rpt["steps"] == 7
    finally:
        manager.delete_run(rid)


def trajectory_lifecycle() -> None:
    # Ecology CA has births (reproduction) and deaths (predation/starvation).
    scene = models.Scene(domain="ecology", model="ca",
                         config={"width": 30, "height": 30, "n_rabbits": 200,
                                 "n_foxes": 40})
    meta = manager.create_run(scene, seed=3, snapshot_interval=1)
    rid = meta["id"]
    try:
        manager.run_batch(rid, 40)
        s0 = storage.load_step(rid, 0)
        s_end = storage.load_step(rid, 40)
        ids0 = {a["id"] for a in s0["individuals"]}
        ids_end = {a["id"] for a in s_end["individuals"]}
        assert ids0 - ids_end, "expected some animals to die"
        assert ids_end - ids0, "expected some animals to be born"
        dead = next(iter(ids0 - ids_end))
        born = next(iter(ids_end - ids0))
        survivor = next(iter(ids0 & ids_end))
        res = manager.get_tracks(rid, [survivor, dead, born, "ghost_id"])
        t_surv, t_dead, t_born, t_ghost = res["tracks"]
        assert res["topology"] == {"wrap_x": True, "wrap_y": True}

        # Survivor: observed at every step, single segment, present at end.
        assert t_surv["first_step"] == 0 and t_surv["last_step"] == 40
        assert not t_surv["gone_before_end"]
        assert len(t_surv["points"]) == 41
        assert len(t_surv["segments"]) == 1
        assert sum(r["steps"] for r in t_surv["states"]) == 41

        # Dead: stops at its last observed step and is flagged gone.
        assert t_dead["gone_before_end"]
        assert t_dead["last_step"] < 40
        assert t_dead["end_reason"]

        # Born: first observed strictly after step 0.
        assert t_born["born_after_start"]
        assert t_born["first_step"] > 0

        # Unknown id is reported, not invented.
        assert t_ghost["found"] is False
    finally:
        manager.delete_run(rid)


def trajectory_identity_and_gaps() -> None:
    """Joining is by id only; absence -> segments; torus crossing -> wrap gap."""
    with tempfile.TemporaryDirectory() as td:
        old = storage.DATA_DIR
        storage.DATA_DIR = td
        try:
            storage.ensure_dirs()

            def mk(step, ids_pos):
                return {"step": step,
                        "bounds": {"width": 100, "height": 100},
                        "topology": {"wrap_x": False, "wrap_y": False},
                        "individuals": [
                            {"id": i, "type": "p", "state": "s", "x": x, "y": y}
                            for i, x, y in ids_pos]}

            storage.save_step("r", 0, mk(0, [("A", 0, 0), ("B", 1, 0)]))
            storage.save_step("r", 1, mk(1, [("A", 1, 0), ("B", 2, 0)]))
            storage.save_step("r", 2, mk(2, [("A", 2, 0)]))          # B gone
            storage.save_step("r", 3, mk(3, [("A", 3, 0)]))
            storage.save_step("r", 4, mk(4, [("A", 4, 0), ("B", 4, 0)]))  # B returns
            res = tracks.build_tracks("r", ["A", "B"])
            ta, tb = res["tracks"]
            # A keeps its own path despite B standing at the same cell/state.
            assert [p["x"] for p in ta["points"]] == [0, 1, 2, 3, 4]
            assert len(ta["segments"]) == 1
            # B has two life episodes and an absence gap on re-entry.
            assert [p["step"] for p in tb["points"]] == [0, 1, 4]
            assert len(tb["segments"]) == 2
            assert tb["points"][2]["gap"] == "absent"

            # Periodic seam crossing (wrapped x): one step from 90 -> 5.
            storage.save_step("w", 0,
                {"step": 0, "bounds": {"width": 100, "height": 100},
                 "topology": {"wrap_x": True, "wrap_y": True},
                 "individuals": [{"id": "Z", "type": "p", "state": "s",
                                  "x": 90, "y": 0}]})
            storage.save_step("w", 1,
                {"step": 1, "bounds": {"width": 100, "height": 100},
                 "topology": {"wrap_x": True, "wrap_y": True},
                 "individuals": [{"id": "Z", "type": "p", "state": "s",
                                  "x": 5, "y": 0}]})
            tw = tracks.build_tracks("w", ["Z"])["tracks"][0]
            assert tw["points"][1]["gap"] == "wrap"
            assert len(tw["segments"]) == 1  # wrap is a drawing break only
        finally:
            storage.DATA_DIR = old


def predator_ids_unique_after_cull() -> None:
    scene = models.Scene(domain="ecology", model="abm",
                         config={"width": 200, "height": 200,
                                 "n_boids": 40, "n_predators": 3})
    meta = manager.create_run(scene, seed=1)
    rid = meta["id"]
    try:
        eng = manager._engine(rid)
        manager.step(rid, 1)
        eng.apply_intervention({"type": "cull_foxes", "params": {"fraction": 1.0}})
        eng.apply_intervention({"type": "release_predators", "params": {"count": 3}})
        ids = [p["id"] for p in eng.predators]
        assert len(set(ids)) == 3, ids                    # no duplicates
        assert all(i not in {f"p{j:04d}" for j in range(3)} for i in ids), ids
    finally:
        manager.delete_run(rid)


def main() -> None:
    check("six engines step and snapshot", engines_step)
    check("interventions apply", interventions_apply)
    check("atomic sharded storage", storage_atomic_roundtrip)
    check("run lifecycle + report", run_lifecycle)
    check("trajectory lifecycle (birth/death/present)", trajectory_lifecycle)
    check("trajectory identity + absence/wrap gaps", trajectory_identity_and_gaps)
    check("predator ids unique after cull+release", predator_ids_unique_after_cull)
    print("\nall smoke tests passed")


if __name__ == "__main__":
    main()
