"""Shared HTTP client helpers: rate limiting, retries, and identifying User-Agents.

SEC's fair-access policy requires every request to carry a real contact
identity in the User-Agent header (name + email); requests without one are
liable to be throttled or blocked. See https://www.sec.gov/os/webmaster-faq#developers
"""
from __future__ import annotations

import os
import threading
import time

import requests
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential


class RateLimiter:
    """A simple token-bucket-free limiter: sleeps as needed to cap requests/sec per instance."""

    def __init__(self, requests_per_sec: float):
        self._min_interval = 1.0 / requests_per_sec if requests_per_sec > 0 else 0.0
        self._lock = threading.Lock()
        self._last_call = 0.0

    def wait(self) -> None:
        if self._min_interval <= 0:
            return
        with self._lock:
            now = time.monotonic()
            elapsed = now - self._last_call
            remaining = self._min_interval - elapsed
            if remaining > 0:
                time.sleep(remaining)
            self._last_call = time.monotonic()


def sec_user_agent() -> str:
    ua = os.getenv("SEC_USER_AGENT")
    if not ua or ua.strip() == "":
        raise RuntimeError(
            "SEC_USER_AGENT is not set. SEC requires a real contact identity "
            "(e.g. 'Your Name your-email@example.com') on every request. "
            "Set it in your .env file (see .env.example)."
        )
    return ua


class HttpClient:
    """Thin wrapper around `requests` with per-source rate limiting and retry-on-transient-errors."""

    def __init__(self, user_agent: str, requests_per_sec: float = 5.0, timeout: int = 30):
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": user_agent, "Accept-Encoding": "gzip, deflate"})
        self.timeout = timeout
        self.limiter = RateLimiter(requests_per_sec)

    @retry(
        reraise=True,
        stop=stop_after_attempt(4),
        wait=wait_exponential(multiplier=1, min=1, max=20),
        retry=retry_if_exception_type((requests.ConnectionError, requests.Timeout)),
    )
    def get(self, url: str, **kwargs) -> requests.Response:
        self.limiter.wait()
        response = self.session.get(url, timeout=self.timeout, **kwargs)
        response.raise_for_status()
        return response
