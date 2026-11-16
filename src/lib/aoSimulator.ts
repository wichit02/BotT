export type TradingSymbol = 'BTCUSD' | 'XAUUSD' | 'US30' | 'US100' | 'US500';

export interface SymbolSpec {
  symbol: TradingSymbol;
  basePrice: number;
  stepSize: number;
  digits: number;
  label: string;
}

export const SYMBOL_SPECS: Record<TradingSymbol, SymbolSpec> = {
  BTCUSD: {
    symbol: 'BTCUSD',
    basePrice: 67125.0,
    stepSize: 165.0,
    digits: 2,
    label: 'Bitcoin / US Dollar',
  },
  XAUUSD: {
    symbol: 'XAUUSD',
    basePrice: 3890.0,
    stepSize: 2.2,
    digits: 2,
    label: 'Gold / US Dollar',
  },
  US30: {
    symbol: 'US30',
    basePrice: 52400.0,
    stepSize: 38.0,
    digits: 2,
    label: 'US30 (Dow Jones)',
  },
  US100: {
    symbol: 'US100',
    basePrice: 28030.0,
    stepSize: 24.0,
    digits: 2,
    label: 'US100 (Nasdaq 100)',
  },
  US500: {
    symbol: 'US500',
    basePrice: 7580.0,
    stepSize: 6.5,
    digits: 2,
    label: 'US500 (S&P 500)',
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

export function appendNextM5Bar(
  existingBars: M5Bar[],
  symbol: TradingSymbol,
  forceCross?: 'BUY' | 'SELL'
): M5Bar[] {
  const spec = SYMBOL_SPECS[symbol];
  const rawBars: Omit<M5Bar, 'ao' | 'aoRising' | 'signal'>[] = existingBars.map(
    ({ ao: _ao, aoRising: _r, signal: _s, ...rest }) => rest
  );

  // If user requested a deterministic Zero-Line Cross test, push enough momentum bars
  // or calibrate the next candle(s) so AO cleanly crosses above/below 0.00000
  const stepsToAdd = forceCross ? 1 : 1;

  for (let s = 0; s < stepsToAdd; s++) {
    const last = rawBars[rawBars.length - 1];
    const lastDate = new Date(last.timestampIso);
    const nextDate = new Date(lastDate.getTime() + 5 * 60 * 1000);
    const idx = last.index + 1;

    let delta =
      Math.sin(idx * 0.24) * spec.stepSize * 0.85 +
      Math.cos(idx * 0.11) * spec.stepSize * 0.45 +
      (((Math.sin(idx * 1.3 + rawBars.length) + 1) * 0.5 - 0.5) * spec.stepSize * 0.4);

    if (forceCross) {
      // Calculate current SMA34 and SMA5 medians to nudge median price smoothly past zero
      const prevCalculated = recalculateAwesomeOscillator(rawBars);
      const currentAo = prevCalculated[prevCalculated.length - 1].ao;

      // Sum of last 4 medians and last 33 medians
      let sum4 = 0;
      for (let k = rawBars.length - 4; k < rawBars.length; k++) {
        sum4 += rawBars[k].median;
      }
      let sum33 = 0;
      for (let k = rawBars.length - 33; k < rawBars.length; k++) {
        sum33 += rawBars[k].median;
      }
      // We want (sum4 + M)/5 - (sum33 + M)/34 > 0 (for BUY) or < 0 (for SELL)
      // Solve M * (1/5 - 1/34) = sum33/34 - sum4/5 => M_zero = (sum33/34 - sum4/5) / (29/170)
      const mZero = (sum33 / 34 - sum4 / 5) / (29 / 170);
      const offset = spec.stepSize * 0.45;
      const targetMedian = forceCross === 'BUY' ? mZero + offset : mZero - offset;

      // If current AO is already on the target side, first reset slightly to opposite side
      if ((forceCross === 'BUY' && currentAo > 0) || (forceCross === 'SELL' && currentAo < 0)) {
        // Insert a preceding counter-bar first so the crossover transition is unmistakably visible
        const preOffset = forceCross === 'BUY' ? -spec.stepSize * 0.35 : spec.stepSize * 0.35;
        const preMedian = mZero + preOffset;
        const preOpen = last.close;
        const preClose = roundToDigits(preMedian + (preMedian - preOpen) * 0.4, spec.digits);
        const preHigh = roundToDigits(Math.max(preOpen, preClose, preMedian) + spec.stepSize * 0.15, spec.digits);
        const preLow = roundToDigits(Math.min(preOpen, preClose, preMedian) - spec.stepSize * 0.15, spec.digits);
        rawBars.push({
          index: idx,
          timeLabel: formatM5Time(nextDate),
          timestampIso: nextDate.toISOString(),
          open: preOpen,
          high: preHigh,
          low: preLow,
          close: preClose,
          median: (preHigh + preLow) / 2,
        });

        // Recompute for the actual crossing bar
        const nextDate2 = new Date(nextDate.getTime() + 5 * 60 * 1000);
        let sum4b = 0;
        for (let k = rawBars.length - 4; k < rawBars.length; k++) sum4b += rawBars[k].median;
        let sum33b = 0;
        for (let k = rawBars.length - 33; k < rawBars.length; k++) sum33b += rawBars[k].median;
        const mZero2 = (sum33b / 34 - sum4b / 5) / (29 / 170);
        const crossMedian = forceCross === 'BUY' ? mZero2 + spec.stepSize * 0.55 : mZero2 - spec.stepSize * 0.55;
        const cOpen = preClose;
        const cClose = roundToDigits(crossMedian + (crossMedian - cOpen) * 0.5, spec.digits);
        const cHigh = roundToDigits(Math.max(cOpen, cClose, crossMedian) + spec.stepSize * 0.2, spec.digits);
        const cLow = roundToDigits(Math.min(cOpen, cClose, crossMedian) - spec.stepSize * 0.2, spec.digits);
        rawBars.push({
          index: idx + 1,
          timeLabel: formatM5Time(nextDate2),
          timestampIso: nextDate2.toISOString(),
          open: cOpen,
          high: cHigh,
          low: cLow,
          close: cClose,
          median: (cHigh + cLow) / 2,
        });
        break;
      } else {
        const open = last.close;
        const close = roundToDigits(targetMedian + (targetMedian - open) * 0.45, spec.digits);
        const high = roundToDigits(Math.max(open, close, targetMedian) + spec.stepSize * 0.2, spec.digits);
        const low = roundToDigits(Math.min(open, close, targetMedian) - spec.stepSize * 0.2, spec.digits);
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
        break;
      }
    }

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
