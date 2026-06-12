"""
CPB OpenClaw Adapter — SSE/HTTP client for CodePatchbay streaming interface.

Usage:
    from adapter import CPBClient

    client = CPBClient("http://127.0.0.1:9741")

    # Stream events in real time
    for event in client.stream(project="my-app"):
        print(event)

    # Read a wiki file
    verdict = client.wiki("my-app", "outputs/verdict-42.md")

    # Get job state
    job = client.job("my-app", "job-abc123")
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Iterator
from urllib.request import Request, urlopen
from urllib.error import URLError


# ── Structured event objects ──────────────────────────────────────

@dataclass
class CPBEvent:
    """A single event from the CPB streaming interface."""
    type: str          # "event" | "wiki" | "ping"
    ts: str
    project: str | None = None
    job_id: str | None = field(default=None, repr=False)
    event: dict | None = field(default=None, repr=False)
    path: str | None = field(default=None, repr=False)
    action: str | None = None  # wiki: "create" | "update" | "delete"

    @property
    def is_job_event(self) -> bool:
        return self.type == "event" and self.event is not None

    @property
    def is_wiki_event(self) -> bool:
        return self.type == "wiki"

    @property
    def event_name(self) -> str | None:
        """The CPB event type (job_created, phase_started, etc.)."""
        return self.event.get("type") if self.event else None

    @classmethod
    def from_json(cls, raw: str) -> CPBEvent:
        data = json.loads(raw)
        return cls(
            type=data.get("type", "unknown"),
            ts=data.get("ts", ""),
            project=data.get("project"),
            job_id=data.get("jobId"),
            event=data.get("event"),
            path=data.get("path"),
            action=data.get("action"),
        )


# ── HTTP helpers ──────────────────────────────────────────────────

def _http_get(url: str, timeout: float = 10) -> bytes:
    req = Request(url, headers={"Accept": "application/json"})
    with urlopen(req, timeout=timeout) as resp:
        return resp.read()


def _http_get_text(url: str, timeout: float = 10) -> str:
    return _http_get(url, timeout).decode("utf-8")


# ── SSE line parser ───────────────────────────────────────────────

def _parse_sse_lines(body: str) -> list[str]:
    """Extract data payloads from an SSE response body."""
    payloads = []
    for line in body.splitlines():
        if line.startswith("data: "):
            payloads.append(line[6:])
    return payloads


# ── Client ────────────────────────────────────────────────────────

class CPBClient:
    """Synchronous client for the CPB streaming interface."""

    def __init__(self, base_url: str = "http://127.0.0.1:9741") -> None:
        self.base_url = base_url.rstrip("/")

    # ── Streaming ─────────────────────────────────────────────────

    def stream(
        self,
        project: str | None = None,
        reconnect_delay: float = 2.0,
        max_retries: int = 5,
    ) -> Iterator[CPBEvent]:
        """
        Yield structured events from the SSE endpoint.

        Handles reconnection with exponential backoff. Yields CPBEvent
        objects; ping events are filtered out.
        """
        url = f"{self.base_url}/stream"
        if project:
            url += f"?project={project}"

        retries = 0
        while retries < max_retries:
            try:
                req = Request(url, headers={"Accept": "text/event-stream"})
                with urlopen(req, timeout=30) as resp:
                    retries = 0  # reset on successful connect
                    buf = ""
                    while True:
                        chunk = resp.read(4096)
                        if not chunk:
                            break
                        buf += chunk.decode("utf-8")
                        while "\n" in buf:
                            line, buf = buf.split("\n", 1)
                            if line.startswith("data: "):
                                raw = line[6:]
                                try:
                                    event = CPBEvent.from_json(raw)
                                except (json.JSONDecodeError, KeyError):
                                    continue
                                if event.type != "ping":
                                    yield event
            except (URLError, OSError):
                retries += 1
                delay = reconnect_delay * (2 ** min(retries - 1, 4))
                time.sleep(delay)

    # ── Wiki ──────────────────────────────────────────────────────

    def wiki(self, project: str, path: str) -> str:
        """Read a wiki file as markdown text."""
        url = f"{self.base_url}/wiki/{project}/{path.lstrip('/')}"
        return _http_get_text(url)

    def verdict(self, project: str, job_id: str) -> str | None:
        """Extract VERDICT line from a verdict file. Returns PASS|FAIL|PARTIAL or None."""
        try:
            content = self.wiki(project, f"outputs/verdict-{job_id}.md")
        except (URLError, OSError):
            return None
        for line in content.splitlines():
            if line.startswith("VERDICT:"):
                return line.split(":", 1)[1].strip()
        return None

    # ── Jobs ──────────────────────────────────────────────────────

    def jobs(self) -> list[dict]:
        """List active jobs across all projects."""
        data = _http_get_text(f"{self.base_url}/jobs")
        return json.loads(data)

    def job(self, project: str, job_id: str) -> dict:
        """Get full materialized job state."""
        data = _http_get_text(f"{self.base_url}/jobs/{project}/{job_id}")
        return json.loads(data)

    # ── Server info ───────────────────────────────────────────────

    def server_info(self) -> dict:
        """Get server version, client count, and uptime."""
        data = _http_get_text(self.base_url + "/")
        return json.loads(data)
