"""Polite outbound HTTP: pacing, a concurrency cap, and backoff that honours Retry-After.

An earlier attempt at a streaming source got the Pi's IP rate-limited and blocked by hitting every
upstream host in parallel with no backoff. Every call to a third-party API should go through this.
"""

import asyncio
import random
import time
from email.utils import parsedate_to_datetime

import httpx


class RateLimited(Exception):
    """The upstream asked us to wait longer than we're willing to block a request for."""

    def __init__(self, service: str, retry_after: float):
        super().__init__(f"{service} asked us to slow down. Try again in {int(retry_after) + 1}s.")
        self.service = service
        self.retry_after = retry_after


class AsyncRateLimiter:
    """At most `max_concurrency` requests in flight, and starts at least `min_interval` seconds apart.

    Also holds a shared cooldown: after a 429, every caller waits until it has passed.
    """

    def __init__(self, min_interval: float, max_concurrency: int = 1):
        self.min_interval = min_interval
        self.max_concurrency = max_concurrency
        self._loop: asyncio.AbstractEventLoop | None = None
        self._next_start = 0.0
        self.cooldown_until = 0.0

    def _bind(self) -> None:
        # Limiters are module-level singletons, but asyncio primitives belong to one event loop; make
        # fresh ones if we're now running on a different loop (e.g. each test client has its own).
        loop = asyncio.get_running_loop()
        if loop is not self._loop:
            self._loop = loop
            self._sem = asyncio.Semaphore(self.max_concurrency)
            self._lock = asyncio.Lock()

    async def __aenter__(self) -> "AsyncRateLimiter":
        self._bind()
        await self._sem.acquire()
        try:
            async with self._lock:
                now = time.monotonic()
                start = max(now, self._next_start, self.cooldown_until)
                self._next_start = start + self.min_interval
            if start > now:
                await asyncio.sleep(start - now)
        except BaseException:
            self._sem.release()
            raise
        return self

    async def __aexit__(self, *exc) -> None:
        self._sem.release()

    def cool_down(self, seconds: float) -> None:
        self.cooldown_until = max(self.cooldown_until, time.monotonic() + seconds)

    def remaining_cooldown(self) -> float:
        return max(0.0, self.cooldown_until - time.monotonic())


def retry_after_seconds(response: httpx.Response, default: float = 5.0) -> float:
    value = response.headers.get("Retry-After")
    if not value:
        return default
    try:
        return max(0.0, float(value))
    except ValueError:
        pass
    try:
        return max(0.0, parsedate_to_datetime(value).timestamp() - time.time())
    except (TypeError, ValueError):
        return default


async def request_with_backoff(
    client: httpx.AsyncClient,
    limiter: AsyncRateLimiter,
    service: str,
    method: str,
    url: str,
    *,
    max_wait: float = 30.0,
    attempts: int = 3,
    base_delay: float = 1.0,
    **kwargs,
) -> httpx.Response:
    """Send a request through `limiter`, retrying 429/5xx/network errors a bounded number of times.

    A 429 whose Retry-After exceeds `max_wait` raises RateLimited at once instead of blocking the
    request (and the user's page) for minutes. The cooldown is still recorded, so later calls wait it
    out too rather than hammering the upstream.
    """
    last_exc: Exception | None = None
    for attempt in range(attempts):
        pending = limiter.remaining_cooldown()
        if pending > max_wait:
            raise RateLimited(service, pending)
        try:
            async with limiter:
                response = await client.request(method, url, **kwargs)
        except httpx.HTTPError as e:
            last_exc = e
            if attempt + 1 < attempts:
                await asyncio.sleep(base_delay * 2**attempt + random.uniform(0, base_delay))
            continue
        if response.status_code == 429:
            wait = retry_after_seconds(response)
            limiter.cool_down(wait)
            if wait > max_wait or attempt + 1 >= attempts:
                raise RateLimited(service, wait)
            continue  # the limiter itself sleeps until the cooldown passes
        if response.status_code >= 500 and attempt + 1 < attempts:
            await asyncio.sleep(base_delay * 2**attempt + random.uniform(0, base_delay))
            continue
        return response
    assert last_exc is not None
    raise last_exc
