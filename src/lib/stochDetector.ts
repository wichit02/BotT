export type StochSide = 'OVER_80' | 'UNDER_20';
export type StochSignalType = 'BUY' | 'SELL';

export interface StochRawOhlcBar {
  index: number;
  timeLabel: string;
  timestampIso: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface StochM1Bar extends StochRawOhlcBar {
  stochK: number | null;
  stochD: number | null;
  stochSwitchSide: StochSide | null;
  stochSignal: StochSignalType | null;
}

export interface LastStochSwitchInfo {
  side: StochSide;
  signal: StochSignalType;
  stochK: number;
  price: number;
  timeLabel: string;
  timestampIso: string;
}

export interface StochDetectionResult {
  bars: StochM1Bar[];
  currentSide: StochSide | null;
  latestStochK: number | null;
  latestClosedStochK: number | null;
  lastSwitchInfo: LastStochSwitchInfo | null;
}

export interface DetectStochOptions {
  /** Set true on live/sim feeds where the final candle is still open/forming */
  excludeLastBar?: boolean;
  /** Initial persisted side before scanning bars (used when aligning with server state) */
  initialSide?: StochSide | null;
  kPeriod?: number;
  slowing?: number;
  dPeriod?: number;
  upperLevel?: number;
  lowerLevel?: number;
}

/**
 * Exact MT5 iStochastic(15, 3, 3, MODE_SMA, STO_LOWHIGH) calculation
 * paired with one-time-per-side closed-bar alerting:
 * - Closes > 80: triggers OVER_80 (SELL / red dot) ONCE until a candle closes < 20.
 * - Closes < 20: triggers UNDER_20 (BUY / green dot) ONCE until a candle closes > 80.
 */
export function detectStochOnBars(
  rawBars: StochRawOhlcBar[],
  options?: DetectStochOptions
): StochDetectionResult {
  const n = rawBars.length;
  if (n === 0) {
    return {
      bars: [],
      currentSide: options?.initialSide ?? null,
      latestStochK: null,
      latestClosedStochK: null,
      lastSwitchInfo: null,
    };
  }

  const kPeriod = options?.kPeriod ?? 15;
  const slowing = options?.slowing ?? 3;
  const dPeriod = options?.dPeriod ?? 3;
  const upperLevel = options?.upperLevel ?? 80;
  const lowerLevel = options?.lowerLevel ?? 20;
  const excludeLastBar = Boolean(options?.excludeLastBar);

  const numerators: Array<number | null> = new Array(n).fill(null);
  const denominators: Array<number | null> = new Array(n).fill(null);

  for (let i = 0; i < n; i++) {
    if (i < kPeriod - 1) continue;
    let highestHigh = -Infinity;
    let lowestLow = Infinity;
    for (let j = i - (kPeriod - 1); j <= i; j++) {
      if (rawBars[j].high > highestHigh) highestHigh = rawBars[j].high;
      if (rawBars[j].low < lowestLow) lowestLow = rawBars[j].low;
    }
    numerators[i] = rawBars[i].close - lowestLow;
    denominators[i] = highestHigh - lowestLow;
  }

  const kValues: Array<number | null> = new Array(n).fill(null);
  const firstKIdx = kPeriod - 1 + (slowing - 1);
  for (let i = firstKIdx; i < n; i++) {
    let sumNum = 0;
    let sumDen = 0;
    let valid = true;
    for (let j = i - (slowing - 1); j <= i; j++) {
      const num = numerators[j];
      const den = denominators[j];
      if (num === null || den === null) {
        valid = false;
        break;
      }
      sumNum += num;
      sumDen += den;
    }
    if (!valid) continue;
    const rawK = sumDen > 0 ? (sumNum / sumDen) * 100 : 50;
    kValues[i] = Math.max(0, Math.min(100, Math.round(rawK * 100) / 100));
  }

  const dValues: Array<number | null> = new Array(n).fill(null);
  const firstDIdx = firstKIdx + (dPeriod - 1);
  for (let i = firstDIdx; i < n; i++) {
    let sumK = 0;
    let valid = true;
    for (let j = i - (dPeriod - 1); j <= i; j++) {
      const k = kValues[j];
      if (k === null) {
        valid = false;
        break;
      }
      sumK += k;
    }
    if (!valid) continue;
    dValues[i] = Math.round((sumK / dPeriod) * 100) / 100;
  }

  let currentSide: StochSide | null = options?.initialSide ?? null;
  let lastSwitchInfo: LastStochSwitchInfo | null = null;
  const bars: StochM1Bar[] = [];

  for (let i = 0; i < n; i++) {
    const bar = rawBars[i];
    const stochK = kValues[i];
    const stochD = dValues[i];
    const isOpenFormingBar = excludeLastBar && i === n - 1;

    let stochSwitchSide: StochSide | null = null;
    let stochSignal: StochSignalType | null = null;

    if (!isOpenFormingBar && stochK !== null) {
      if (stochK > upperLevel && currentSide !== 'OVER_80') {
        stochSwitchSide = 'OVER_80';
        stochSignal = 'SELL';
        currentSide = 'OVER_80';
        lastSwitchInfo = {
          side: 'OVER_80',
          signal: 'SELL',
          stochK,
          price: bar.close,
          timeLabel: bar.timeLabel,
          timestampIso: bar.timestampIso,
        };
      } else if (stochK < lowerLevel && currentSide !== 'UNDER_20') {
        stochSwitchSide = 'UNDER_20';
        stochSignal = 'BUY';
        currentSide = 'UNDER_20';
        lastSwitchInfo = {
          side: 'UNDER_20',
          signal: 'BUY',
          stochK,
          price: bar.close,
          timeLabel: bar.timeLabel,
          timestampIso: bar.timestampIso,
        };
      }
    }

    bars.push({
      ...bar,
      index: i,
      stochK,
      stochD,
      stochSwitchSide,
      stochSignal,
    });
  }

  const latestBar = bars[bars.length - 1];
  const latestClosedBar = bars.length >= 2 ? bars[bars.length - 2] : latestBar;

  return {
    bars,
    currentSide,
    latestStochK: latestBar?.stochK ?? null,
    latestClosedStochK: latestClosedBar?.stochK ?? null,
    lastSwitchInfo,
  };
}
