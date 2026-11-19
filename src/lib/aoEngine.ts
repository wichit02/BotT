import type { CandleWithAO, SignalDirection, SignalRecord, TradingSymbol } from '../types/trading';

export interface SymbolSpec {
  symbol: TradingSymbol;
  label: string;
  basePrice: number;
  priceDigits: number;
  aoDigits: number;
  volatility: number;
}

export const SYMBOL_SPECS: Record<TradingSymbol, SymbolSpec> = {
  US100: {
    symbol: 'US100',
    label: 'Nasdaq 100 Index (US100)',
    basePrice: 27720.0,
    priceDigits: 2,
    aoDigits: 2,
    volatility: 21.5,
  },
};

export interface RawCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  timestampMs: number;
}

export interface SimStreamState {
  raw: RawCandle[];
  tickInBar: number;
  phase: number;
  swingLabel: string;
}

export const TICKS_PER_SIM_BAR = 5;

export function getTwoSwingStepInfo(barIndex: number): {
  driftFactor: number;
  label: string;
} {
  const step = ((Math.floor(barIndex) % 24) + 24) % 24;
  if (step <= 3) return { driftFactor: -0.95, label: 'ลงสวิง 1/2' };
  if (step <= 5) return { driftFactor: 0.55, label: 'เด้งพักตัว' };
  if (step <= 10) return { driftFactor: -1.05, label: 'ลงสวิง 2/2' };
  if (step <= 14) return { driftFactor: 0.95, label: 'ขึ้นสวิง 1/2' };
  if (step <= 16) return { driftFactor: -0.55, label: 'ย่อพักตัว' };
  if (step <= 21) return { driftFactor: 1.05, label: 'ขึ้นสวิง 2/2' };
  return { driftFactor: 0.0, label: 'พักตัวเปลี่ยนรอบ' };
}

function computeAoValues(raw: RawCandle[]): number[] {
  const medians = raw.map((c) => (c.high + c.low) / 2);
  const ao: number[] = new Array(raw.length).fill(0);

  for (let i = 0; i < raw.length; i++) {
    if (i < 33) {
      ao[i] = 0;
      continue;
    }
    let sum5 = 0;
    for (let j = i - 4; j <= i; j++) sum5 += medians[j];
    const sma5 = sum5 / 5;

    let sum34 = 0;
    for (let j = i - 33; j <= i; j++) sum34 += medians[j];
    const sma34 = sum34 / 34;

    ao[i] = sma5 - sma34;
  }
  return ao;
}

function formatTimeHm(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function alignToM5(ms: number): number {
  const fiveMin = 5 * 60 * 1000;
  return Math.floor(ms / fiveMin) * fiveMin;
}

export function rawToCandlesWithAO(
  raw: RawCandle[],
  symbol: TradingSymbol,
  visibleCount = 38
): CandleWithAO[] {
  const spec = SYMBOL_SPECS[symbol];
  const allAo = computeAoValues(raw);
  const startIdx = Math.max(0, raw.length - visibleCount);

  return raw.slice(startIdx).map((candle, idx) => {
    const absIdx = startIdx + idx;
    const aoVal = allAo[absIdx];
    const prevAoVal = absIdx > 0 ? allAo[absIdx - 1] : aoVal;
    const shift = raw.slice(startIdx).length - 1 - idx;

    return {
      index: idx,
      timeLabel: formatTimeHm(candle.timestampMs),
      timestampIso: new Date(candle.timestampMs).toISOString(),
      open: Number(candle.open.toFixed(spec.priceDigits)),
      high: Number(candle.high.toFixed(spec.priceDigits)),
      low: Number(candle.low.toFixed(spec.priceDigits)),
      close: Number(candle.close.toFixed(spec.priceDigits)),
      median: (candle.high + candle.low) / 2,
      ao: aoVal,
      aoRising: aoVal >= prevAoVal,
      shift,
    };
  });
}

export function buildSimulatedM5Raw(
  symbol: TradingSymbol,
  scenario: 'neutral' | 'buy_cross' | 'sell_cross',
  seed = 1
): RawCandle[] {
  const spec = SYMBOL_SPECS[symbol];
  const totalBars = 72; // 34 warmup + 38 visible
  const nowAligned = alignToM5(Date.now());
  const raw: RawCandle[] = [];

  let s = seed * 9301 + 49297;
  const rand = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };

  let price = spec.basePrice;

  for (let i = 0; i < totalBars; i++) {
    const barTime = nowAligned - (totalBars - 1 - i) * 5 * 60 * 1000;
    let drift = 0;

    if (scenario === 'buy_cross') {
      if (i >= 46 && i < 62) {
        drift = -spec.volatility * 0.52;
      } else if (i >= 62 && i < 69) {
        drift = spec.volatility * 0.35;
      } else if (i === 69) {
        drift = spec.volatility * 0.28;
      } else if (i === 70) {
        drift = spec.volatility * 2.15;
      } else if (i === 71) {
        drift = spec.volatility * 0.45;
      } else {
        drift = (rand() - 0.48) * spec.volatility * 0.6;
      }
    } else if (scenario === 'sell_cross') {
      if (i >= 46 && i < 62) {
        drift = spec.volatility * 0.52;
      } else if (i >= 62 && i < 69) {
        drift = -spec.volatility * 0.35;
      } else if (i === 69) {
        drift = -spec.volatility * 0.28;
      } else if (i === 70) {
        drift = -spec.volatility * 2.15;
      } else if (i === 71) {
        drift = -spec.volatility * 0.45;
      } else {
        drift = (rand() - 0.52) * spec.volatility * 0.6;
      }
    } else {
      const info = getTwoSwingStepInfo(i + seed * 3);
      drift =
        info.driftFactor * spec.volatility * 0.72 +
        (rand() - 0.5) * spec.volatility * 0.35;
    }

    const open = price;
    const close = open + drift;
    const bodyHigh = Math.max(open, close);
    const bodyLow = Math.min(open, close);
    const upperWick = (0.15 + rand() * 0.45) * spec.volatility;
    const lowerWick = (0.15 + rand() * 0.45) * spec.volatility;

    raw.push({
      open,
      high: bodyHigh + upperWick,
      low: bodyLow - lowerWick,
      close,
      timestampMs: barTime,
    });
    price = close;
  }

  if (scenario === 'buy_cross' || scenario === 'sell_cross') {
    for (let attempt = 0; attempt < 18; attempt++) {
      const aoCheck = computeAoValues(raw);
      const ao2 = aoCheck[totalBars - 3];
      const ao1 = aoCheck[totalBars - 2];

      if (scenario === 'buy_cross') {
        const needAo2Below = ao2 > 0;
        const needAo1Above = ao1 <= 0;
        if (!needAo2Below && !needAo1Above) break;
        if (needAo2Below) {
          const adj = spec.volatility * 0.9;
          for (let k = totalBars - 7; k <= totalBars - 3; k++) {
            raw[k].open -= adj;
            raw[k].high -= adj;
            raw[k].low -= adj;
            raw[k].close -= adj;
          }
        }
        if (needAo1Above) {
          const boost = spec.volatility * 1.4;
          raw[totalBars - 2].high += boost;
          raw[totalBars - 2].close += boost;
          raw[totalBars - 1].open += boost * 0.7;
          raw[totalBars - 1].high += boost * 0.7;
          raw[totalBars - 1].low += boost * 0.7;
          raw[totalBars - 1].close += boost * 0.7;
        }
      } else {
        const needAo2Above = ao2 < 0;
        const needAo1Below = ao1 >= 0;
        if (!needAo2Above && !needAo1Below) break;
        if (needAo2Above) {
          const adj = spec.volatility * 0.9;
          for (let k = totalBars - 7; k <= totalBars - 3; k++) {
            raw[k].open += adj;
            raw[k].high += adj;
            raw[k].low += adj;
            raw[k].close += adj;
          }
        }
        if (needAo1Below) {
          const drop = spec.volatility * 1.4;
          raw[totalBars - 2].low -= drop;
          raw[totalBars - 2].close -= drop;
          raw[totalBars - 1].open -= drop * 0.7;
          raw[totalBars - 1].high -= drop * 0.7;
          raw[totalBars - 1].low -= drop * 0.7;
          raw[totalBars - 1].close -= drop * 0.7;
        }
      }
    }
  }

  return raw;
}

/**
 * Generates 38 visible M5 candles (preceded by 34 warmup bars) with authentic SMA(5)-SMA(34) AO math.
 * Index length-1 is shift [0] (forming bar), length-2 is shift [1] (latest closed bar), length-3 is shift [2].
 */
export function buildSimulatedM5Series(
  symbol: TradingSymbol,
  scenario: 'neutral' | 'buy_cross' | 'sell_cross',
  seed = 1
): CandleWithAO[] {
  const raw = buildSimulatedM5Raw(symbol, scenario, seed);
  return rawToCandlesWithAO(raw, symbol, 38);
}

/**
 * Advances the simulated M5 candlestick stream by 1 live tick.
 * Every TICKS_PER_SIM_BAR ticks, the forming candle [0] closes into [1],
 * a new candle [0] opens, and we evaluate whether AO[2] -> AO[1] crossed 0.00!
 */
export function stepSimStream(
  prevState: SimStreamState,
  symbol: TradingSymbol
): {
  nextState: SimStreamState;
  candles: CandleWithAO[];
  closedCross: SignalDirection | null;
} {
  const spec = SYMBOL_SPECS[symbol];
  const raw = prevState.raw.map((c) => ({ ...c }));
  const nextTick = prevState.tickInBar + 1;
  const barStep = prevState.phase;
  const stepInfo = getTwoSwingStepInfo(barStep);

  // Move each intra-bar tick along the current 2-down / 2-up swing leg
  const tickBaseMove = (stepInfo.driftFactor * spec.volatility * 0.85) / TICKS_PER_SIM_BAR;
  const jitter = (Math.random() - 0.5) * spec.volatility * 0.28;
  const delta = tickBaseMove + jitter;

  const forming = raw[raw.length - 1];
  const nextClose = forming.close + delta;
  forming.close = nextClose;
  forming.high = Math.max(forming.high, nextClose + Math.random() * spec.volatility * 0.1);
  forming.low = Math.min(forming.low, nextClose - Math.random() * spec.volatility * 0.1);

  let closedCross: SignalDirection | null = null;
  let finalTickInBar = nextTick;
  let nextPhase = barStep;

  if (nextTick >= TICKS_PER_SIM_BAR) {
    nextPhase = (barStep + 1) % 24;
    const nextLegInfo = getTwoSwingStepInfo(nextPhase);
    const nextOpen = forming.close;
    const nextTime = forming.timestampMs + 5 * 60 * 1000;
    const initialMove =
      (nextLegInfo.driftFactor * spec.volatility * 0.6) / TICKS_PER_SIM_BAR +
      (Math.random() - 0.5) * spec.volatility * 0.18;
    const newClose = nextOpen + initialMove;

    raw.push({
      open: nextOpen,
      high: Math.max(nextOpen, newClose) + spec.volatility * 0.08,
      low: Math.min(nextOpen, newClose) - spec.volatility * 0.08,
      close: newClose,
      timestampMs: nextTime,
    });

    if (raw.length > 72) {
      raw.shift();
    }

    const aoVals = computeAoValues(raw);
    const ao1 = aoVals[aoVals.length - 2]; // Newly closed bar [1]
    const ao2 = aoVals[aoVals.length - 3]; // Previous closed bar [2]

    if (ao2 <= 0 && ao1 > 0) {
      closedCross = 'BUY';
    } else if (ao2 >= 0 && ao1 < 0) {
      closedCross = 'SELL';
    }

    finalTickInBar = 0;
  }

  const finalInfo = getTwoSwingStepInfo(nextPhase);
  const nextState: SimStreamState = {
    raw,
    tickInBar: finalTickInBar,
    phase: nextPhase,
    swingLabel: finalInfo.label,
  };

  return {
    nextState,
    candles: rawToCandlesWithAO(raw, symbol, 38),
    closedCross,
  };
}

export function formatSignedAo(value: number, digits: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}`;
}

export function createSignalFromSeries(
  symbol: TradingSymbol,
  series: CandleWithAO[],
  direction: SignalDirection,
  source: 'Live US100 M5' | 'M5 Simulator' | 'Manual Test' = 'M5 Simulator'
): SignalRecord {
  const spec = SYMBOL_SPECS[symbol];
  const bar1 = series.find((c) => c.shift === 1) ?? series[series.length - 2];
  const bar2 = series.find((c) => c.shift === 2) ?? series[series.length - 3];

  const priceFormatted = bar1.close.toFixed(spec.priceDigits);
  const aoPrevFormatted = formatSignedAo(bar2.ao, 3);
  const aoCurrFormatted = formatSignedAo(bar1.ao, 3);
  const modeLabel = source === 'Live US100 M5' ? 'กราฟจริง' : 'กราฟจำลอง';
  const headIcon = direction === 'BUY' ? '🟢' : '🔴';
  const condText =
    direction === 'BUY' ? 'AO ตัดเส้น 0 ขึ้น 🟢⬆️' : 'AO ตัดเส้น 0 ลง 🔴⬇️';

  const pushMessage = [
    `${headIcon} ${direction} · ${symbol} (M5)`,
    '____________________',
    `เงื่อนไข: ${condText}`,
    `ค่า AO: ${aoPrevFormatted} → ${aoCurrFormatted}`,
    `โหมด: ${modeLabel}`,
    `เวลา: ${bar1.timeLabel} น.`,
  ].join('\n');

  return {
    id: `sig_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toISOString(),
    symbol,
    timeframe: 'M5',
    direction,
    price: bar1.close,
    priceFormatted,
    aoPrev: bar2.ao,
    aoCurr: bar1.ao,
    aoPrevFormatted,
    aoCurrFormatted,
    pushMessage,
    timeLabel: bar1.timeLabel,
    source,
    telegramStatus: 'pending',
    sheetsLogged: false,
  };
}

