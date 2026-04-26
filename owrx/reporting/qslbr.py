import json
import logging
import threading
from datetime import datetime, timezone
from queue import Full, Queue
from urllib import request
from urllib.error import HTTPError

from owrx.bands import Bandplan
from owrx.config import Config
from owrx.metrics import CounterMetric, Metrics
from owrx.reporting.reporter import FilteredReporter

logger = logging.getLogger(__name__)

PoisonPill = object()

_API_URL = "https://id.qsl.br/api/public/propagation/reports"


class Worker(threading.Thread):
    def __init__(self, queue: Queue):
        self.queue = queue
        self.doRun = True
        super().__init__(daemon=True)

    def run(self):
        while self.doRun:
            try:
                spot = self.queue.get()
                if spot is PoisonPill:
                    self.doRun = False
                else:
                    self._upload(spot)
                    self.queue.task_done()
            except Exception:
                logger.exception("Exception while uploading QSL.br spot")

    def _band_name(self, freq_hz):
        band = Bandplan.getSharedInstance().findBand(freq_hz)
        if band is None:
            return None
        return band.getName().upper()

    def _upload(self, spot):
        config = Config.get()
        heard_at = datetime.fromtimestamp(
            spot["timestamp"] / 1000, tz=timezone.utc
        ).strftime("%Y-%m-%dT%H:%M:%SZ")

        freq_hz = int(spot["freq"])
        band = self._band_name(freq_hz)

        payload = {
            "reporter_callsign": config["qslbr_callsign"],
            "reporter_grid": config["qslbr_grid"],
            "dx_callsign": spot["source"]["callsign"],
            "dx_grid": spot["locator"],
            "mode": spot["mode"],
            "freq_hz": freq_hz,
            "heard_at": heard_at,
            "source": "OpenWebRX",
        }
        if band is not None:
            payload["band"] = band

        data = json.dumps(payload).encode("utf-8")
        req = request.Request(
            _API_URL,
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with request.urlopen(req, timeout=30) as resp:
                logger.debug("QSL.br accepted spot for %s: HTTP %s", spot["source"]["callsign"], resp.status)
        except HTTPError as e:
            logger.warning("QSL.br rejected spot: HTTP %s %s", e.code, e.reason)


class QslBrReporter(FilteredReporter):
    """
    Sends propagation spots to id.qsl.br only while no users are connected to
    the SDR.  Enable with qslbr_enabled=True and set qslbr_callsign / qslbr_grid
    in the OpenWebRX configuration.
    """

    def __init__(self):
        self.queue = Queue(200)
        Worker(self.queue).start()

        metrics = Metrics.getSharedInstance()
        self.spotCounter = CounterMetric()
        metrics.addMetric("qslbr.spots", self.spotCounter)

    def stop(self):
        while not self.queue.empty():
            self.queue.get(timeout=1)
            self.queue.task_done()
        self.queue.put(PoisonPill)

    def spot(self, spot):
        try:
            from owrx.bandrotation import BandRotationManager
            BandRotationManager.getSharedInstance().recordSpot()
        except Exception:
            logger.exception("BandRotationManager.recordSpot failed")
        try:
            self.queue.put(spot, block=False)
            self.spotCounter.inc()
        except Full:
            logger.warning("QSL.br queue overflow, one spot dropped")

    def getSupportedModes(self):
        return ["FT8", "FT4", "JT65", "JT9", "FST4", "WSPR", "FST4W", "Q65", "MSK144"]
