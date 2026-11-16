export type TradingSymbol = 'US100';

export interface SymbolSpec {
  symbol: TradingSymbol;
  basePrice: number;
  stepSize: number;
  digits: number;
  label: string;
}

export const SYMBOL_SPECS: Record<TradingSymbol, SymbolSpec> = {
  US100: {
    symbol: 'US100',
    basePrice: 27726.62,
    stepSize: 22.0,
    digits: 2,
    label: 'US 100 Index Cash',
  },
};

export interface M5Bar {
  index: number;
  timeLabel: string;
  timestampIso: string;
  open: number;
  high: number;
  low: number;
  close: number;
  median: number;
  ao: number;
  aoRising: boolean;
  signal: 'BUY' | 'SELL' | null;
}

function roundToDigits(value: number, digits: number): number {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

function formatM5Time(date: Date): string {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Exact Bill Williams Awesome Oscillator formula:
 * AO = SMA(Median Price, 5) - SMA(Median Price, 34)
 * where Median Price = (High + Low) / 2
 */
export function recalculateAwesomeOscillator(rawBars: Omit<M5Bar, 'ao' | 'aoRising' | 'signal'>[]): M5Bar[] {
  const result: M5Bar[] = [];

  for (let i = 0; i < rawBars.length; i++) {
    const bar = rawBars[i];
    let ao = 0;

    if (i >= 33) {
      let sum5 = 0;
      for (let k = i - 4; k <= i; k++) {
        sum5 += rawBars[k].median;
      }
      let sum34 = 0;
      for (let k = i - 33; k <= i; k++) {
        sum34 += rawBars[k].median;
      }
      ao = sum5 / 5 - sum34 / 34;
    }

    const prevBar = result[i - 1];
    const aoRising = i > 33 && prevBar ? ao >= prevBar.ao : true;

    let signal: 'BUY' | 'SELL' | null = null;
    if (i >= 34 && prevBar) {
      if (prevBar.ao <= 0 && ao > 0) {
        signal = 'BUY';
      } else if (prevBar.ao >= 0 && ao < 0) {
        signal = 'SELL';
      }
    }

    result.push({
      ...bar,
      ao,
      aoRising,
      signal,
    });
  }

  return result;
}

export function generateInitialSeries(symbol: TradingSymbol, count = 100): M5Bar[] {
  const spec = SYMBOL_SPECS[symbol];
  const rawBars: Omit<M5Bar, 'ao' | 'aoRising' | 'signal'>[] = [];

  const now = new Date();
  now.setSeconds(0, 0);
  const roundedMinutes = Math.floor(now.getMinutes() / 5) * 5;
  now.setMinutes(roundedMinutes);

  let price = spec.basePrice;

  for (let i = 0; i < count; i++) {
    const barTime = new Date(now.getTime() - (count - 1 - i) * 5 * 60 * 1000);
    // Sinusoidal + realistic momentum cycles so AO naturally crosses zero a couple times
    const wave =
      Math.sin(i * 0.24) * spec.stepSize * 0.85 +
      Math.cos(i * 0.11) * spec.stepSize * 0.45;
    const micro = ((Math.sin(i * 1.7 + symbol.length) + 1) * 0.5 - 0.5) * spec.stepSize * 0.5;
    const open = roundToDigits(price, spec.digits);
    const close = roundToDigits(open + wave + micro, spec.digits);
    const wickUp = Math.abs(Math.sin(i * 2.1)) * spec.stepSize * 0.55 + spec.stepSize * 0.12;
    const wickDown = Math.abs(Math.cos(i * 1.9)) * spec.stepSize * 0.55 + spec.stepSize * 0.12;
    const high = roundToDigits(Math.max(open, close) + wickUp, spec.digits);
    const low = roundToDigits(Math.min(open, close) - wickDown, spec.digits);
    const median = (high + low) / 2;

    rawBars.push({
      index: i,
      timeLabel: formatM5Time(barTime),
      timestampIso: barTime.toISOString(),
      open,
      high,
      low,
      close,
      median,
    });

    price = close;
  }

  return recalculateAwesomeOscillator(rawBars);
}

function buildBarWithExactMedian(
  index: number,
  barDate: Date,
  open: number,
  targetMedian: number,
  spec: SymbolSpec,
  dir: 'BUY' | 'SELL'
): Omit<M5Bar, 'ao' | 'aoRising' | 'signal'> {
  const halfSpan = Math.max(
    Math.abs(targetMedian - open) + spec.stepSize * 0.28,
    spec.stepSize * 0.45
  );
  const high = roundToDigits(targetMedian + halfSpan, spec.digits);
  const low = roundToDigits(targetMedian - halfSpan, spec.digits);
  const actualMedian = (high + low) / 2;
  const bodyShift = Math.min(halfSpan * 0.65, spec.stepSize * 0.55);
  const closeRaw = dir === 'BUY' ? actualMedian + bodyShift : actualMedian - bodyShift;
  const close = roundToDigits(
    Math.max(low + 1 / Math.pow(10, spec.digits), Math.min(high - 1 / Math.pow(10, spec.digits), closeRaw)),
    spec.digits
  );

  return {
    index,
    timeLabel: formatM5Time(barDate),
    timestampIso: barDate.toISOString(),
    open: roundToDigits(Math.max(low, Math.min(high, open)), spec.digits),
    high,
    low,
    close,
    median: actualMedian,
  };
}

export function appendNextM5Bar(
  existingBars: M5Bar[],
  symbol: TradingSymbol,
  forceCross?: 'BUY' | 'SELL'
): M5Bar[] {
  const spec = SYMBOL_SPECS[symbol];
  const rawBars: Omit<M5Bar, 'ao' | 'aoRising' | 'signal'>[] = existingBars.map(
    ({ ao: _ao, aoRising: _r, signal: _s, ...rest }) => rest
  );

  if (forceCross) {
    const calcMZero = (barsList: Array<Omit<M5Bar, 'ao' | 'aoRising' | 'signal'>>): number => {
      let sum4 = 0;
      for (let k = barsList.length - 4; k < barsList.length; k++) sum4 += barsList[k].median;
      let sum33 = 0;
      for (let k = barsList.length - 33; k < barsList.length; k++) sum33 += barsList[k].median;
      return (sum33 / 34 - sum4 / 5) / (29 / 170);
    };

    const prevCalculated = recalculateAwesomeOscillator(rawBars);
    const currentAo = prevCalculated[prevCalculated.length - 1].ao;

    // Ensure the immediately preceding bar is strictly on the opposite side of 0
    if ((forceCross === 'BUY' && currentAo > 0) || (forceCross === 'SELL' && currentAo < 0) || currentAo === 0) {
      const last = rawBars[rawBars.length - 1];
      const preDate = new Date(new Date(last.timestampIso).getTime() + 5 * 60 * 1000);
      const mZero = calcMZero(rawBars);
      const preTargetMedian =
        forceCross === 'BUY'
          ? mZero - spec.stepSize * 0.6
          : mZero + spec.stepSize * 0.6;
      const preBar = buildBarWithExactMedian(
        last.index + 1,
        preDate,
        last.close,
        preTargetMedian,
        spec,
        forceCross === 'BUY' ? 'SELL' : 'BUY'
      );
      rawBars.push(preBar);
    }

    const lastBeforeCross = rawBars[rawBars.length - 1];
    const crossDate = new Date(new Date(lastBeforeCross.timestampIso).getTime() + 5 * 60 * 1000);
    const mZeroCross = calcMZero(rawBars);
    const crossTargetMedian =
      forceCross === 'BUY'
        ? mZeroCross + spec.stepSize * 0.75
        : mZeroCross - spec.stepSize * 0.75;
    const crossBar = buildBarWithExactMedian(
      lastBeforeCross.index + 1,
      crossDate,
      lastBeforeCross.close,
      crossTargetMedian,
      spec,
      forceCross
    );
    rawBars.push(crossBar);

    const trimmed = rawBars.slice(-110);
    return recalculateAwesomeOscillator(trimmed);
  }

  const last = rawBars[rawBars.length - 1];
  const lastDate = new Date(last.timestampIso);
  const nextDate = new Date(lastDate.getTime() + 5 * 60 * 1000);
  const idx = last.index + 1;

  const delta =
    Math.sin(idx * 0.24) * spec.stepSize * 0.85 +
    Math.cos(idx * 0.11) * spec.stepSize * 0.45 +
    (((Math.sin(idx * 1.3 + rawBars.length) + 1) * 0.5 - 0.5) * spec.stepSize * 0.4);

    const open = last.close;
    const close = roundToDigits(open + delta, spec.digits);
    const wickUp = Math.abs(Math.sin(idx * 2.1)) * spec.stepSize * 0.45 + spec.stepSize * 0.1;
    const wickDown = Math.abs(Math.cos(idx * 1.9)) * spec.stepSize * 0.45 + spec.stepSize * 0.1;
    const high = roundToDigits(Math.max(open, close) + wickUp, spec.digits);
    const low = roundToDigits(Math.min(open, close) - wickDown, spec.digits);

    rawBars.push({
      index: idx,
      timeLabel: formatM5Time(nextDate),
      timestampIso: nextDate.toISOString(),
      open,
      high,
      low,
      close,
      median: (high + low) / 2,
    });
  }

  // Keep sliding window of 110 bars so SMA(34) stays warmed up for all visible bars
  const trimmed = rawBars.slice(-110);
  return recalculateAwesomeOscillator(trimmed);
}
