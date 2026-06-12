"""CPB SSE adapter for Hermes agents.

Async generator yielding parsed events from a CPB streaming server.
Supports auto-reconnect with exponential backoff, project filtering,
and clean shutdown.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import AsyncIterator

import aiohttp

logger = logging.getLogger("cpb.adapter")

DEFAULT_URL = "http://127.0.0.1:9741/stream"
MAX_BACKOFF = 30.0


class CPBStream:
    """Connect to a CPB streaming server and yield parsed events."""

    def __init__(
        self,
        url: str = DEFAULT_URL,
        project: str | None = None,
        reconnect_interval: float = 3.0,
    ) -> None:
        self._base_url = url
        self._project = project
        self._reconnect_interval = reconnect_interval
        self._stopped = False

    def stop(self) -> None:
        """Signal the stream to stop after the current event."""
        self._stopped = True

    async def events(self) -> AsyncIterator[dict]:
        """Yield parsed event dicts. Reconnects on failure with backoff."""
        backoff = self._reconnect_interval
        while not self._stopped:
            try:
                async for event in self._connect():
                    yield event
                    backoff = self._reconnect_interval
            except Exception as exc:
                if self._stopped:
                    break
                logger.warning("cpb stream error: %s; reconnecting in %.1fs", exc, backoff)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, MAX_BACKOFF)

    async def _connect(self) -> AsyncIterator[dict]:
        params = {}
        if self._project:
            params["project"] = self._project

        async with aiohttp.ClientSession() as session:
            async with session.get(self._base_url, params=params) as resp:
                resp.raise_for_status()
                buffer = ""
                async for chunk in resp.content:
                    if self._stopped:
                        return
                    buffer += chunk.decode(errors="replace")
                    while "\n" in buffer:
                        line, buffer = buffer.split("\n", 1)
                        text = line.strip()
                        if not text.startswith("data: "):
                            continue
                        payload = text[len("data: "):]
                        try:
                            event = json.loads(payload)
                        except json.JSONDecodeError:
                            logger.debug("skipping non-json line: %s", payload[:120])
                            continue
                        if event.get("type") == "ping":
                            continue
                        yield event


async def stream_events(
    project: str | None = None,
    port: int = 9741,
) -> AsyncIterator[dict]:
    """Convenience entry point: connect and yield events until cancelled."""
    cpb = CPBStream(url=f"http://127.0.0.1:{port}/stream", project=project)
    async for event in cpb.events():
        yield event


async def get_job_state(project: str, job_id: str, port: int = 9741) -> dict:
    """Fetch materialized job state from the HTTP endpoint."""
    async with aiohttp.ClientSession() as session:
        url = f"http://127.0.0.1:{port}/jobs/{project}/{job_id}"
        async with session.get(url) as resp:
            resp.raise_for_status()
            return await resp.json()
