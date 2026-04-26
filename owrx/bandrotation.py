import threading
import logging

logger = logging.getLogger(__name__)


class BandRotationManager:
    _instance = None
    _class_lock = threading.Lock()

    @classmethod
    def getSharedInstance(cls):
        with cls._class_lock:
            if cls._instance is None:
                cls._instance = cls()
        return cls._instance

    def __init__(self):
        self._lock = threading.RLock()
        self._scheduler = None
        self._schedule = None
        self._spot_count = 0
        self._no_spot_timer = None

    def setup(self, scheduler, schedule):
        with self._lock:
            if self._no_spot_timer is not None:
                self._no_spot_timer.cancel()
                self._no_spot_timer = None
            self._scheduler = scheduler
            self._schedule = schedule
            self._spot_count = 0
        logger.info(
            "BandRotationManager: %d profiles, no_spot_timeout=%ds, max_spots_per_band=%d",
            len(schedule.profiles),
            schedule.no_spot_timeout,
            schedule.max_spots_per_band,
        )
        self._reset_no_spot_timer()

    def recordSpot(self):
        should_advance = False
        with self._lock:
            if self._schedule is None:
                return
            self._spot_count += 1
            if self._spot_count >= self._schedule.max_spots_per_band:
                should_advance = True

        if should_advance:
            logger.info(
                "BandRotationManager: %d spots reached on %s, rotating",
                self._schedule.max_spots_per_band,
                self._schedule.getCurrentProfile(),
            )
            self._advance()
        else:
            self._reset_no_spot_timer()

    def _advance(self):
        with self._lock:
            if self._schedule is None:
                return
            self._schedule.advance()
            self._spot_count = 0
            scheduler = self._scheduler

        if scheduler is not None:
            scheduler.scheduleSelection()
        self._reset_no_spot_timer()

    def _no_spot_timeout_fired(self):
        with self._lock:
            if self._schedule is None:
                return
            profile = self._schedule.getCurrentProfile()
            timeout = self._schedule.no_spot_timeout
        logger.info(
            "BandRotationManager: no spots for %ds on %s, rotating",
            timeout,
            profile,
        )
        self._advance()

    def _reset_no_spot_timer(self):
        with self._lock:
            if self._schedule is None:
                return
            timeout = self._schedule.no_spot_timeout
            if self._no_spot_timer is not None:
                self._no_spot_timer.cancel()
            self._no_spot_timer = threading.Timer(timeout, self._no_spot_timeout_fired)
            self._no_spot_timer.daemon = True
            self._no_spot_timer.start()

    def shutdown(self):
        with self._lock:
            if self._no_spot_timer is not None:
                self._no_spot_timer.cancel()
                self._no_spot_timer = None
            self._scheduler = None
            self._schedule = None
