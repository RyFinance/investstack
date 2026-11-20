"""Test isolation: every test module imports this FIRST. It points VALORA_HOME at a temp folder before any valora
module touches the data folder, and blocks all network access (net.fetch / net.download / urlopen raise)."""
import os
import tempfile

os.environ["VALORA_HOME"] = tempfile.mkdtemp(prefix="valora-test-")

import urllib.request  # noqa: E402

from valora import net, paths  # noqa: E402


class NetworkBlocked(OSError):
    pass


def _blocked(*a, **k):
    raise NetworkBlocked("network access is disabled in tests")


net.fetch = _blocked
net.download = _blocked
urllib.request.urlopen = _blocked
REAL_FETCH = _blocked


def fresh_home() -> str:
    """A new empty data folder (new config, new databases) for a test class."""
    d = tempfile.mkdtemp(prefix="valora-test-")
    os.environ["VALORA_HOME"] = d
    assert str(paths.home()) == d and "Application Support" not in d
    return d


class FakeNet:
    """Context manager: route net.fetch to `handler(url, headers) -> (status, bytes)`; counts calls."""
    def __init__(self, handler):
        self.handler, self.calls = handler, []

    def __enter__(self):
        def fake(url, headers=None, timeout=30):
            self.calls.append(url)
            return self.handler(url, headers or {})
        net.fetch = fake
        return self

    def __exit__(self, *exc):
        net.fetch = _blocked
