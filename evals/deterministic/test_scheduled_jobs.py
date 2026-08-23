"""DETERMINISTIC EVAL — recurring jobs (JOB.md) parse, list, and run through Waku."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from waku.ops import scheduled


def _write_job(jobs_dir: Path, name: str, schedule: str = "0 9 * * 1",
                source: str | None = None, prompt: str = "Do the thing.") -> None:
    front = f"---\nname: {name}\nschedule: {schedule}\n"
    if source:
        front += f"source: {source}\n"
    front += "---\n"
    d = jobs_dir / name
    d.mkdir(parents=True)
    (d / "JOB.md").write_text(front + prompt + "\n", encoding="utf-8")


def test_load_jobs_parses_frontmatter_and_defaults_source(tmp_path, monkeypatch):
    monkeypatch.setattr(scheduled, "JOBS_DIR", tmp_path)
    _write_job(tmp_path, "weekly-analysis", prompt="Analyze my portfolio.")

    jobs = scheduled.load_jobs()

    assert len(jobs) == 1
    job = jobs[0]
    assert (job.name, job.schedule, job.source, job.prompt) == (
        "weekly-analysis", "0 9 * * 1", "job:weekly-analysis", "Analyze my portfolio.",
    )


def test_load_jobs_missing_dir_returns_empty(tmp_path, monkeypatch):
    monkeypatch.setattr(scheduled, "JOBS_DIR", tmp_path / "does-not-exist")
    assert scheduled.load_jobs() == []


def test_parse_rejects_files_missing_name_schedule_or_body(tmp_path):
    no_schedule = tmp_path / "no_schedule.md"
    no_schedule.write_text("---\nname: incomplete\n---\nsome body\n", encoding="utf-8")
    assert scheduled._parse(no_schedule) is None

    empty_body = tmp_path / "empty_body.md"
    empty_body.write_text("---\nname: incomplete\nschedule: 0 9 * * 1\n---\n\n", encoding="utf-8")
    assert scheduled._parse(empty_body) is None


def test_run_job_unknown_name_lists_available(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(scheduled, "JOBS_DIR", tmp_path)
    _write_job(tmp_path, "weekly-analysis")

    code = scheduled.run_job("nope")

    assert code == 1
    assert "weekly-analysis" in capsys.readouterr().err


def test_run_job_runs_through_waku_and_saves_outbox(tmp_path, monkeypatch):
    monkeypatch.setattr(scheduled, "JOBS_DIR", tmp_path)
    _write_job(tmp_path, "weekly-analysis", source="job:weekly-analysis",
               prompt="Analyze my portfolio.")
    home = tmp_path / "home"
    (home / "outbox").mkdir(parents=True)
    calls = {}

    class FakeWaku:
        def __init__(self):
            self.settings = SimpleNamespace(home=home)

        def respond(self, prompt, source="cli"):
            calls["prompt"], calls["source"] = prompt, source
            return SimpleNamespace(reply="you're up 3% this week")

    monkeypatch.setattr(scheduled, "Waku", FakeWaku)

    code = scheduled.run_job("weekly-analysis")

    assert code == 0
    assert calls == {"prompt": "Analyze my portfolio.", "source": "job:weekly-analysis"}
    saved = list((home / "outbox").glob("weekly-analysis-*.txt"))
    assert len(saved) == 1
    assert saved[0].read_text(encoding="utf-8") == "you're up 3% this week\n"


def test_print_cron_prints_schedule_and_run_command(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(scheduled, "JOBS_DIR", tmp_path)
    _write_job(tmp_path, "weekly-analysis")

    scheduled.print_cron()

    out = capsys.readouterr().out
    assert "0 9 * * 1" in out
    assert "waku job run weekly-analysis" in out


def test_shipped_weekly_analysis_job_is_valid():
    """A broken JOB.md fails silently (load_jobs just skips it) — this catches
    the shipped example itself rotting."""
    repo_root = Path(__file__).resolve().parents[2]
    job = scheduled._parse(repo_root / "jobs" / "weekly-analysis" / "JOB.md")
    assert job is not None
    assert job.name == "weekly-analysis"
