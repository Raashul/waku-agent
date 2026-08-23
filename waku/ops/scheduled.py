"""`python -m waku job ...` — recurring tasks that run through the normal harness.

A job is a JOB.md file: frontmatter (`name`, `schedule`, optional `source`)
plus a body that's sent to Waku verbatim as the user message. Same shape as
SKILL.md (see waku/memory/procedural/loader.py) — if you've written a skill,
you already know how to write a job.

Nothing here runs on a timer. `schedule` is a cron expression for humans and
for `job cron` to echo back — cron (or launchd) is the actual scheduler:

    $ python -m waku job cron
    0 9 * * 1  cd /path/to/waku-agent && python3 -m waku job run weekly-analysis

Paste that into `crontab -e` yourself; Waku never touches your crontab. `job
run` does exactly what a gateway does — one `waku.respond()` call through the
full loop (tools, memory, tracing) — and saves the reply to the outbox, so it
shows up in the dashboard next to everything else.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from waku.app import Waku

JOBS_DIR = Path(__file__).resolve().parents[2] / "jobs"


@dataclass
class Job:
    name: str
    schedule: str
    source: str
    prompt: str
    path: Path


def _parse(path: Path) -> Job | None:
    text = path.read_text(encoding="utf-8")
    match = re.match(r"^---\n(.*?)\n---\n(.*)$", text, re.DOTALL)
    if not match:
        return None
    front, body = match.groups()
    fields = {
        k.strip(): v.strip().strip("'\"")
        for k, _, v in (line.partition(":") for line in front.splitlines() if ":" in line)
    }
    if "name" not in fields or "schedule" not in fields or not body.strip():
        return None
    return Job(
        name=fields["name"],
        schedule=fields["schedule"],
        source=fields.get("source", f"job:{fields['name']}"),
        prompt=body.strip(),
        path=path,
    )


def load_jobs() -> list[Job]:
    if not JOBS_DIR.is_dir():
        return []
    jobs = []
    for f in sorted(JOBS_DIR.rglob("JOB.md")):
        job = _parse(f)
        if job:
            jobs.append(job)
    return jobs


def _execute(job: Job) -> tuple[str, Path]:
    """One `waku.respond()` call through the full loop, reply saved to the
    outbox. Shared by the CLI and the dashboard's "run now" button so both
    paths behave identically."""
    waku = Waku()
    result = waku.respond(job.prompt, source=job.source)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    out = waku.settings.home / "outbox" / f"{job.name}-{stamp}.txt"
    out.write_text(result.reply + "\n", encoding="utf-8")
    return result.reply, out


def run_job(name: str) -> int:
    jobs = {job.name: job for job in load_jobs()}
    job = jobs.get(name)
    if job is None:
        available = ", ".join(sorted(jobs)) or "none found"
        print(f"No job named {name!r}. Available: {available}", file=sys.stderr)
        return 1
    reply, out = _execute(job)
    print(reply)
    print(f"saved to {out}", file=sys.stderr)
    return 0


def run_job_action(payload: dict) -> dict:
    """The dashboard's "run now" button — same path as `waku job run <name>`,
    JSON in/out so `dashboard.py` can wire it straight into its routes table."""
    name = (payload.get("name") or "").strip()
    jobs = {job.name: job for job in load_jobs()}
    job = jobs.get(name)
    if job is None:
        return {"error": f"No job named {name!r}"}
    reply, out = _execute(job)
    return {"ok": True, "reply": reply, "outbox": out.name}


def list_jobs() -> int:
    jobs = load_jobs()
    if not jobs:
        print(f"No jobs found under {JOBS_DIR}/. Add a JOB.md under {JOBS_DIR}/<name>/.")
        return 0
    for job in sorted(jobs, key=lambda j: j.name):
        print(f"{job.name:<24} {job.schedule:<16} {job.path.relative_to(JOBS_DIR.parent)}")
    return 0


def print_cron() -> int:
    """Suggested crontab lines for every job found — printed, never installed."""
    repo = JOBS_DIR.parent
    jobs = load_jobs()
    if not jobs:
        print(f"No jobs found under {JOBS_DIR}/.")
        return 0
    for job in sorted(jobs, key=lambda j: j.name):
        print(f"{job.schedule}  cd {repo} && {sys.executable} -m waku job run {job.name}")
    return 0


def main() -> None:
    args = sys.argv[1:]
    if args[:1] == ["run"] and len(args) == 2:
        sys.exit(run_job(args[1]))
    elif args[:1] == ["list"]:
        sys.exit(list_jobs())
    elif args[:1] == ["cron"]:
        sys.exit(print_cron())
    else:
        print("usage: waku job [run <name> | list | cron]", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
