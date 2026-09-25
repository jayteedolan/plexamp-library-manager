"""In-process Server-Sent Events broadcaster.

Every connected browser tab gets its own queue. Publishers call `publish(type, data)`; slow or dead
subscribers are dropped rather than blocking the publisher.
"""

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any

_subscribers: set[asyncio.Queue[str]] = set()
_loop: asyncio.AbstractEventLoop | None = None


def bind_loop(loop: asyncio.AbstractEventLoop) -> None:
    global _loop
    _loop = loop


def _format(event_type: str, data: Any) -> str:
    return f"event: {event_type}\ndata: {json.dumps(data, default=str)}\n\n"


def publish(event_type: str, data: Any = None) -> None:
    """Safe to call from the event loop or from worker threads."""
    msg = _format(event_type, data)

    def _put() -> None:
        for q in list(_subscribers):
            try:
                q.put_nowait(msg)
            except asyncio.QueueFull:
                _subscribers.discard(q)

    try:
        asyncio.get_running_loop()
        _put()
    except RuntimeError:
        if _loop is not None and not _loop.is_closed():
            _loop.call_soon_threadsafe(_put)


async def stream(heartbeat: float = 20.0) -> AsyncIterator[str]:
    q: asyncio.Queue[str] = asyncio.Queue(maxsize=500)
    _subscribers.add(q)
    try:
        yield _format("hello", {})
        while True:
            try:
                yield await asyncio.wait_for(q.get(), timeout=heartbeat)
            except TimeoutError:
                yield ": keep-alive\n\n"
    finally:
        _subscribers.discard(q)
