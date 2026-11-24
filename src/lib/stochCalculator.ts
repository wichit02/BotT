import { M5Bar } from './aoSimulator';

export interface StochPoint {
  index: number;
  timeLabel: string;
  timestampIso: string;
  open: number;
  high: number;
  low: number;
  close: number;
  k: number; // Main %K line
  d: number; // Signal %D line
  signal: 'BUY' | 'SELL' | null;
  zone: 'OVERBOUGHT' | 'OVERSOLD' | 'NEUTRAL';
}

export interface StochParams {
  kPeriod: number;
  dPeriod: number;
  slowing: number;
  upperLevel: number;
  lowerLevel: number;
}

export const DEFAULT_STOCH_PARAMS: StochParams = {
  kPeriod: 15,
  dPeriod: 3,
  slowing: 3,
  upperLevel: 80,
  lowerLevel: 20,
};

/**
 * Standard MetaTrader 5 Stochastic Oscillator (STO_LOWHIGH, MODE_SMA):
 * - Raw numerator at bar i = close[i] - lowestLow(i - kPeriod + 1 .. i)
 * - Raw denominator at bar i = highestHigh(i - kPeriod + 1 .. i) - lowestLow(...)
 * - Main (%K) = (sum of numerator over slowing) / (sum of denominator over slowing) * 100
 * - Signal (%D) = SMA(Main, dPeriod)
 */
export function computeStochasticSeries(
  bars: M5Bar[],
  params: StochParams = DEFAULT_STOCH_PARAMS
): StochPoint[] {
  const kPeriod = Math.max(1, Math.floor(params.kPeriod));
  const dPeriod = Math.max(1, Math.floor(params.dPeriod));
  const slowing = Math.max(1, Math.floor(params.slowing));

  const numerators: number[] = new Array(bars.length).fill(0);
  const denominators: number[] = new Array(bars.length).fill(0);
  const kValues: number[] = new Array(bars.length).fill(50);
  const dValues: number[] = new Array(bars.length).fill(50);

  for (let i = 0; i < bars.length; i++) {
    const startIdx = Math.max(0, i - kPeriod + 1);
    let lowest = Infinity;
    let highest = -Infinity;
    for (let j = startIdx; j <= i; j++) {
      if (bars[j].low < lowest) lowest = bars[j].low;
      if (bars[j].high > highest) highest = bars[j].high;
    }
    numerators[i] = bars[i].close - lowest;
    denominators[i] = highest - lowest;
  }

  for (let i = 0; i < bars.length; i++) {
    const slowStart = Math.max(0, i - slowing + 1);
    let sumNum = 0;
    let sumDen = 0;
    for (let j = slowStart; j <= i; j++) {
      sumNum += numerators[j];
      sumDen += denominators[j];
    }
    const rawK = sumDen > 1e-9 ? (sumNum / sumDen) * 100 : 50;
    kValues[i] = Math.min(100, Math.max(0, rawK));
  }

  for (let i = 0; i < bars.length; i++) {
    const dStart = Math.max(0, i - dPeriod + 1);
    let sumK = 0;
    let count = 0;
    for (let j = dStart; j <= i; j++) {
      sumK += kValues[j];
      count++;
    }
    dValues[i] = count > 0 ? sumK / count : kValues[i];
  }

  const out: StochPoint[] = [];
  const warmup = kPeriod + slowing + dPeriod - 2;

  for (let i = 0; i < bars.length; i++) {
    const k = kValues[i];
    const d = dValues[i];
    const prevK = i > 0 ? kValues[i - 1] : k;
    const prevD = i > 0 ? dValues[i - 1] : d;

    let signal: 'BUY' | 'SELL' | null = null;
    if (i >= warmup) {
      if (prevK <= prevD && k > d) {
        signal = 'BUY';
      } else if (prevK >= prevD && k < d) {
        signal = 'SELL';
      }
    }

    const zone: StochPoint['zone'] =
      k >= params.upperLevel
        ? 'OVERBOUGHT'
        : k <= params.lowerLevel
        ? 'OVERSOLD'
        : 'NEUTRAL';

    out.push({
      index: bars[i].index,
      timeLabel: bars[i].timeLabel,
      timestampIso: bars[i].timestampIso,
      open: bars[i].open,
      high: bars[i].high,
      low: bars[i].low,
      close: bars[i].close,
      k,
      d,
      signal,
      zone,
    });
  }

  return out;
}

/**
 * Generates synthetic M5 candles for Sim mode that drive Stoch(15,3,3) cleanly into oversold (<20) or overbought (>80) crossover.
 */
export function appendStochSimBars(
  existingBars: M5Bar[],
  forceCross?: 'BUY' | 'SELL'
): M5Bar[] {
  const baseBars = existingBars.slice();
  const digits = 2;
  const step = 22.0;

  const pushCandle = (open: number, close: number, high: number, low: number) => {
    const last = baseBars[baseBars.length - 1];
    const nextDate = new Date(Date.parse(last.timestampIso) + 5 * 60 * 1000);
    const hh = String(nextDate.getHours()).padStart(2, '0');
    const mm = String(nextDate.getMinutes()).padStart(2, '0');
    const round = (v: number) => Math.round(v * Math.pow(10, digits)) / Math.pow(10, digits);
    const o = round(open);
    const c = round(close);
    const h = round(Math.max(o, c, high));
    const l = round(Math.min(o, c, low));
    baseBars.push({
      index: last.index + 1,
      timeLabel: `${hh}:${mm}`,
      timestampIso: nextDate.toISOString(),
      open: o,
      high: h,
      low: l,
      close: c,
      median: (h + l) / 2,
      ao: last.ao,
      aoRising: last.aoRising,
      signal: null,
    });
  };

  if (forceCross === 'BUY') {
    // Push 3 down bars to enter oversold (<20), then 2 sharp up bars so %K crosses above %D
    for (let i = 0; i < 3; i++) {
      const prev = baseBars[baseBars.length - 1];
      const c = prev.close - step * 1.15;
      pushCandle(prev.close, c, prev.close + step * 0.12, c - step * 0.25);
    }
    for (let i = 0; i < 2; i++) {
      const prev = baseBars[baseBars.length - 1];
      const c = prev.close + step * 1.25;
      pushCandle(prev.close, c, c + step * 0.18, prev.close - step * 0.1);
    }
    return baseBars.slice(-140).map((b, idx) => ({ ...b, index: idx }));
  }

  if (forceCross === 'SELL') {
    // Push 3 up bars to enter overbought (>80), then 2 sharp down bars so %K crosses below %D
    for (let i = 0; i < 3; i++) {
      const prev = baseBars[baseBars.length - 1];
      const c = prev.close + step * 1.15;
      pushCandle(prev.close, c, c + step * 0.25, prev.close - step * 0.12);
    }
    for (let i = 0; i < 2; i++) {
      const prev = baseBars[baseBars.length - 1];
      const c = prev.close - step * 1.25;
      pushCandle(prev.close, c, prev.close + step * 0.1, c - step * 0.18);
    }
    return baseBars.slice(-140).map((b, idx) => ({ ...b, index: idx }));
  }

  // Natural smooth oscillation
  const last = baseBars[baseBars.length - 1];
  const idx = last.index + 1;
  const delta =
    Math.sin(idx * 0.38) * step * 1.1 +
    Math.cos(idx * 0.19) * step * 0.45;
  const open = last.close;
  const close = open + delta;
  const high = Math.max(open, close) + step * 0.28;
  const low = Math.min(open, close) - step * 0.28;
  pushCandle(open, close, high, low);

  return baseBars.slice(-140).map((b, idx2) => ({ ...b, index: idx2 }));
}
