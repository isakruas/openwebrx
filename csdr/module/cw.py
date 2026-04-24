from pycsdr.modules import ExecModule
from pycsdr.types import Format
from csdr.module import ThreadModule

import logging
logger = logging.getLogger(__name__)


class CwModule(ExecModule):
    def __init__(self):
        super().__init__(
            Format.SHORT,
            Format.CHAR,
            ["multimon-ng", "-t", "raw", "-a", "MORSE_CW", "-q", "-"],
        )


class CwParser(ThreadModule):
    def __init__(self):
        super().__init__()

    def getInputFormat(self) -> Format:
        return Format.CHAR

    def getOutputFormat(self) -> Format:
        return Format.CHAR

    def run(self):
        logger.debug("CwParser started")
        while self.doRun:
            data = self.reader.read()
            if data is None:
                self.doRun = False
                break
            chunk = bytes(data)
            if chunk:
                logger.info("CW decoded: %r", chunk)
                self.writer.write(chunk)
        logger.debug("CwParser stopped")
