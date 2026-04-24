from csdr.chain.demodulator import SecondaryDemodulator
from csdr.module.cw import CwModule, CwParser
from pycsdr.modules import AudioResampler, Convert
from pycsdr.types import Format


class CwDecoder(SecondaryDemodulator):
    CW_RATE = 22050

    def __init__(self):
        self.sampleRate = 12000
        workers = [
            AudioResampler(self.sampleRate, self.CW_RATE),
            Convert(Format.FLOAT, Format.SHORT),
            CwModule(),
            CwParser(),
        ]
        super().__init__(workers)

    def setSampleRate(self, sampleRate: int) -> None:
        if sampleRate == self.sampleRate:
            return
        self.sampleRate = sampleRate
        self.replace(0, AudioResampler(self.sampleRate, self.CW_RATE))

    def isSecondaryFftShown(self):
        return True
