import { SYMBOL_SPECS, type TradingSymbol } from './aoSimulator';
import {
  type StochDetectionResult,
  type StochM1Bar,
  type StochRawOhlcBar,
  type StochSide,
  detectStochOnBars,
} from './stochDetector';

function roundToDigits(value: number, digits: number): number {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

function formatM1Time(date: Date): string {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

// 28-bar cyclic M1 price pattern designed to swing Stoch(15,3,3) smoothly above 80 and below 20
const STOCH_M1_CYCLE = [
  0.55, 0.72, 0.85, 0.92, 0.78, 0.65, 0.45,
  -0.25, -0.45, -0.68, -0.82, -0.95, -0.88, -0.72,
  -0.55, -0.35, 0.15, 0.35, 0.58, 0.78, 0.92,
  0.84, 0.62, -0.18, -0.52, -0.78, -0.92, -0.64,
];

export function planNextStochM1CloseDelta(
  barTimestampOrIndex: string | number,
  symbol: TradingSymbol = 'US100'
): number {
  const spec = SYMBOL_SPECS[symbol];
  const barStep = spec.stepSize * 0.42;
  const intervalMs = 60 * 1000;
  const waveIdx =
    typeof barTimestampOrIndex === 'string'
      ? Math.round(new Date(barTimestampOrIndex).getTime() / intervalMs)
      : barTimestampOrIndex;
  const len = STOCH_M1_CYCLE.length;
  const phase = ((waveIdx % len) + len) % len;
  return STOCH_M1_CYCLE[phase] * barStep;
}

export function generateInitialStochM1Series(
  symbol: TradingSymbol = 'US100',
  count = 110
): StochDetectionResult {
  const spec = SYMBOL_SPECS[symbol];
  const barStep = spec.stepSize * 0.42;
  const intervalMs = 60 * 1000;
  const rawBars: StochRawOhlcBar[] = [];

  const nowMs = Math.floor(Date.now() / intervalMs) * intervalMs;
  let price = spec.basePrice;

  for (let i = 0; i < count; i++) {
    const barTime = new Date(nowMs - (count - 1 - i) * intervalMs);
    const delta = planNextStochM1CloseDelta(barTime.toISOString(), symbol);
    const open = roundToDigits(price, spec.digits);
    const close = roundToDigits(open + delta, spec.digits);
    const wickUp = Math.abs(Math.sin(i * 1.9)) * barStep * 0.35 + barStep * 0.08;
    const wickDown = Math.abs(Math.cos(i * 1.7)) * barStep * 0.35 + barStep * 0.08;
    const high = roundToDigits(Math.max(open, close) + wickUp, spec.digits);
    const low = roundToDigits(Math.min(open, close) - wickDown, spec.digits);

    rawBars.push({
      index: i,
      timeLabel: formatM1Time(barTime),
      timestampIso: barTime.toISOString(),
      open,
      high,
      low,
      close,
    });

    price = close;
  }

  return detectStochOnBars(rawBars, { excludeLastBar: true });
}

export function tickFormingStochM1Bar(
  existingBars: StochM1Bar[],
  nextPrice: number,
  symbol: TradingSymbol = 'US100'
): StochDetectionResult {
  const spec = SYMBOL_SPECS[symbol];
  if (existingBars.length === 0) {
    return generateInitialStochM1Series(symbol);
  }

  const rawBars: StochRawOhlcBar[] = existingBars.map((b, idx) => {
    if (idx !== existingBars.length - 1) {
      return {
        index: idx,
        timeLabel: b.timeLabel,
        timestampIso: b.timestampIso,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      };
    }
    const clampedClose = roundToDigits(nextPrice, spec.digits);
    return {
      index: idx,
      timeLabel: b.timeLabel,
      timestampIso: b.timestampIso,
      open: b.open,
      high: roundToDigits(Math.max(b.high, clampedClose), spec.digits),
      low: roundToDigits(Math.min(b.low, clampedClose), spec.digits),
      close: clampedClose,
    };
  });

  return detectStochOnBars(rawBars, { excludeLastBar: true });
}

export function finalizeStochM1BarAndOpenNext(
  existingBars: StochM1Bar[],
  finalClose: number,
  symbol: TradingSymbol = 'US100'
): StochDetectionResult {
  const spec = SYMBOL_SPECS[symbol];
  const intervalMs = 60 * 1000;
  if (existingBars.length === 0) {
    return generateInitialStochM1Series(symbol);
  }

  const rawBars: StochRawOhlcBar[] = existingBars.map((b, idx) => {
    if (idx !== existingBars.length - 1) {
      return {
        index: idx,
        timeLabel: b.timeLabel,
        timestampIso: b.timestampIso,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      };
    }
    const closedVal = roundToDigits(finalClose, spec.digits);
    return {
      index: idx,
      timeLabel: b.timeLabel,
      timestampIso: b.timestampIso,
      open: b.open,
      high: roundToDigits(Math.max(b.high, b.open, closedVal), spec.digits),
      low: roundToDigits(Math.min(b.low, b.open, closedVal), spec.digits),
      close: closedVal,
    };
  });

  const lastClosed = rawBars[rawBars.length - 1];
  const nextDate = new Date(new Date(lastClosed.timestampIso).getTime() + intervalMs);
  rawBars.push({
    index: rawBars.length,
    timeLabel: formatM1Time(nextDate),
    timestampIso: nextDate.toISOString(),
    open: lastClosed.close,
    high: lastClosed.close,
    low: lastClosed.close,
    close: lastClosed.close,
  });

  const trimmed = rawBars.slice(-120).map((b, idx) => ({ ...b, index: idx }));
  return detectStochOnBars(trimmed, { excludeLastBar: true });
}

export function appendNextStochM1Bar(
  existingBars: StochM1Bar[],
  symbol: TradingSymbol = 'US100',
  forceTarget?: StochSide
): StochDetectionResult {
  const spec = SYMBOL_SPECS[symbol];
  const barStep = spec.stepSize * 0.42;
  const intervalMs = 60 * 1000;

  const closedPrefix = existingBars.slice(0, -1);
  const rawBars: StochRawOhlcBar[] = (closedPrefix.length >= 20 ? closedPrefix : existingBars).map(
    (b) => ({
      index: b.index,
      timeLabel: b.timeLabel,
      timestampIso: b.timestampIso,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
    })
  );

  const pushClosedBar = (open: number, close: number) => {
    const last = rawBars[rawBars.length - 1];
    const nextDate = new Date(new Date(last.timestampIso).getTime() + intervalMs);
    const high = roundToDigits(Math.max(open, close) + barStep * 0.16, spec.digits);
    const low = roundToDigits(Math.min(open, close) - barStep * 0.16, spec.digits);
    rawBars.push({
      index: rawBars.length,
      timeLabel: formatM1Time(nextDate),
      timestampIso: nextDate.toISOString(),
      open: roundToDigits(open, spec.digits),
      high,
      low,
      close: roundToDigits(close, spec.digits),
    });
  };

  if (forceTarget) {
    // If already on the requested side, push opposite swing first so the switch genuinely crosses sides
    const currentRes = detectStochOnBars(rawBars, { excludeLastBar: false });
    if (currentRes.currentSide === forceTarget) {
      const oppDir = forceTarget === 'OVER_80' ? -1 : 1;
      for (let step = 0; step < 8; step++) {
        const lastClose = rawBars[rawBars.length - 1].close;
        pushClosedBar(lastClose, lastClose + oppDir * barStep * 1.45);
        const check = detectStochOnBars(rawBars, { excludeLastBar: false });
        if (check.currentSide !== forceTarget) break;
      }
    }

    const dir = forceTarget === 'OVER_80' ? 1 : -1;
    for (let step = 0; step < 10; step++) {
      const lastClose = rawBars[rawBars.length - 1].close;
      pushClosedBar(lastClose, lastClose + dir * barStep * 1.65);
      const check = detectStochOnBars(rawBars, { excludeLastBar: false });
      const lastK = check.bars[check.bars.length - 1]?.stochK;
      if (
        lastK !== null &&
        ((forceTarget === 'OVER_80' && lastK > 82) ||
          (forceTarget === 'UNDER_20' && lastK < 18))
      ) {
        break;
      }
    }
  } else {
    const last = rawBars[rawBars.length - 1];
    const delta = planNextStochM1CloseDelta(last.timestampIso, symbol);
    pushClosedBar(last.close, last.close + delta);
  }

  const latestClosed = rawBars[rawBars.length - 1];
  const openNextDate = new Date(new Date(latestClosed.timestampIso).getTime() + intervalMs);
  rawBars.push({
    index: rawBars.length,
    timeLabel: formatM1Time(openNextDate),
    timestampIso: openNextDate.toISOString(),
    open: latestClosed.close,
    high: latestClosed.close,
    low: latestClosed.close,
    close: latestClosed.close,
  });

  const trimmed = rawBars.slice(-120).map((b, idx) => ({ ...b, index: idx }));
  return detectStochOnBars(trimmed, { excludeLastBar: true });
}
