"""Background market-data refresh: FRED rates, Zillow ZIP/metro indexes. Runs on first launch and monthly."""
from __future__ import annotations

import threading
import traceback
from datetime import datetime

from . import db as D
from .sources import fred, zillow


class Job:
    def __init__(self):
        self.busy, self.step, self.error, self.done_at = False, "", "", None
        self._lock = threading.Lock()

    def start(self, refresh=False) -> bool:
        with self._lock:
            if self.busy:
                return False
            self.busy, self.error = True, ""
        threading.Thread(target=self._run, args=(refresh,), daemon=True).start()
        return True

    def _run(self, refresh):
        try:
            for demo in (False, True):
                with D.db(demo) as c:
                    errs = []
                    self.step = "Mortgage rates and Treasury yields (FRED)"
                    try:
                        fred.update(c)
                    except Exception as e:
                        errs.append(f"FRED: {e}")
                    for geo, metric, label in (("metro", "zhvi", "metro home values"), ("metro", "zori", "metro rents"),
                                               ("zip", "zori", "ZIP rents"), ("zip", "zhvi", "ZIP home values (124 MB, once a month)")):
                        self.step = f"Zillow Research: {label}"
                        try:
                            zillow.snapshot(c, geo, metric, refresh=refresh)
                        except Exception as e:
                            errs.append(f"Zillow {geo} {metric}: {e}")
                        c.commit()
                    if errs:
                        self.error = "; ".join(errs)
                refresh = False
            self.done_at = datetime.now().isoformat(timespec="seconds")
        except Exception as e:
            traceback.print_exc()
            self.error = f"{type(e).__name__}: {e}"
        finally:
            self.busy, self.step = False, ""

    def due(self) -> bool:
        with D.db() as c:
            r = c.execute("select max(as_of) a, count(*) n from market_snap where geo_type='zip' and metric='zhvi'").fetchone()
            f = c.execute("select max(date) d from market_series where metric='MORTGAGE30US'").fetchone()
        return not r["n"] or not f["d"]

    def state(self) -> dict:
        return {"busy": self.busy, "step": self.step, "error": self.error, "done_at": self.done_at}


JOB = Job()
