import { useEffect, useMemo, useState } from 'react';
import {
  Bell,
  Pause,
  Play,
  Radio,
  RefreshCw,
  Send,
  Smartphone,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { SYMBOL_SPECS, TICKS_PER_SIM_BAR, formatSignedAo } from '../lib/aoEngine';
import type {
  CandleWithAO,
  ChartMode,
  LiveHistoricalCross,
  SignalDirection,
  TradingSymbol,
} from '../types/trading';

export type AlertDirectionFilter = 'both' | 'buy_only' | 'sell_only';

interface AoChartPanelProps {
  symbol: TradingSymbol;
  chartMode: ChartMode;
  onChangeChartMode: (mode: ChartMode) => void;
  alertFilter: AlertDirectionFilter;
  onChangeAlertFilter: (filter: AlertDirectionFilter) => void;
  candles: CandleWithAO[];
  activeDirection: SignalDirection | null;
  liveFeedSymbol: string;
  liveIsRealtime: boolean;
  liveMarketPrice: number | null;
  liveBid: number | null;
  liveAsk: number | null;
  liveSpread: number | null;
  liveBarCloseTimeIso: string | null;
  liveUpdatedAt: string | null;
  nextRefreshInSec: number;
  liveLoading: boolean;
  liveError: string | null;
  sound10sEnabled: boolean;
  onToggleSound10s: () => void;
  autoRefreshEnabled: boolean;
  onToggleAutoRefresh: () => void;
  onTestSound: () => void;
  onTriggerMobileAlert: () => void;
  onOpenTelegramAction: () => void;
  telegramEnabled: boolean;
  telegramAutoSend: boolean;
  telegramReady: boolean;
  telegramChatId: string;
  onRefreshLive: () => void;
  lastHistoricalCross: LiveHistoricalCross | null;
  onUseHistoricalLiveCross: () => void;
  simPlaying: boolean;
  simSpeed: 1 | 2;
  simTickInBar: number;
  simSwingLabel: string;
  onToggleSimPlay: () => void;
  onChangeSimSpeed: (speed: 1 | 2) => void;
}

export function AoChartPanel({
  symbol,
  chartMode,
  onChangeChartMode,
  alertFilter,
  onChangeAlertFilter,
  candles,
  activeDirection,
  liveFeedSymbol,
  liveIsRealtime,
  liveMarketPrice,
  liveBid,
  liveAsk,
  liveSpread,
  liveBarCloseTimeIso,
  liveUpdatedAt,
  nextRefreshInSec,
  liveLoading,
  liveError,
  sound10sEnabled,
  onToggleSound10s,
  autoRefreshEnabled,
  onToggleAutoRefresh,
  onTestSound,
  onTriggerMobileAlert,
  onOpenTelegramAction,
  telegramEnabled,
  telegramAutoSend,
  telegramReady,
  telegramChatId,
  onRefreshLive,
  lastHistoricalCross,
  onUseHistoricalLiveCross,
  simPlaying,
  simSpeed,
  simTickInBar,
  simSwingLabel,
  onToggleSimPlay,
  onChangeSimSpeed,
}: AoChartPanelProps) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const spec = SYMBOL_SPECS[symbol];

  // Live 1-second clock for MT5 bar-close countdown & terminal clock
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const bar2 = candles.find((c) => c.shift === 2) ?? candles[candles.length - 3];
  const bar1 = candles.find((c) => c.shift === 1) ?? candles[candles.length - 2];
  const bar0 = candles.find((c) => c.shift === 0) ?? candles[candles.length - 1];
  const activeCandle =
    hoveredIdx !== null && candles[hoveredIdx]
      ? candles[hoveredIdx]
      : bar0 ?? bar1;

  // Mobile-first XM MT5 Terminal Black Chart Geometry (fits mobile screen with zero horizontal clipping)
  const width = 620;
  const chartHeight = 420;
  const priceTop = 16;
  const priceBottom = 270;
  const aoTop = 290;
  const aoBottom = 386;
  const aoMidY = (aoTop + aoBottom) / 2;
  const padLeft = 8;
  const padRight = 68;
  const plotW = width - padLeft - padRight;

  const { minPrice, maxPrice, maxAbsAo } = useMemo(() => {
    let low = Infinity;
    let high = -Infinity;
    let aoMax = 0.0001;

    for (const c of candles) {
      if (c.low < low) low = c.low;
      if (c.high > high) high = c.high;
      const absAo = Math.abs(c.ao);
      if (absAo > aoMax) aoMax = absAo;
    }
    if (chartMode === 'live') {
      if (liveBid !== null) {
        low = Math.min(low, liveBid);
        high = Math.max(high, liveBid);
      }
      if (liveAsk !== null) {
        high = Math.max(high, liveAsk);
      }
    }
    if (!Number.isFinite(low) || !Number.isFinite(high)) {
      low = spec.basePrice - spec.volatility;
      high = spec.basePrice + spec.volatility;
    }
    const priceSpan = Math.max(high - low, spec.volatility * 0.65);
    return {
      minPrice: low - priceSpan * 0.14,
      maxPrice: high + priceSpan * 0.14,
      maxAbsAo: aoMax * 1.18,
    };
  }, [candles, chartMode, liveBid, liveAsk, spec.basePrice, spec.volatility]);

  const stepX = plotW / Math.max(candles.length, 1);
  const candleW = Math.max(4.5, Math.min(9.5, stepX * 0.58));

  const yPrice = (val: number) => {
    const ratio = (val - minPrice) / Math.max(maxPrice - minPrice, 1e-9);
    return priceBottom - ratio * (priceBottom - priceTop);
  };

  const yAo = (val: number) => {
    const ratio = val / Math.max(maxAbsAo, 1e-9);
    return aoMidY - ratio * ((aoBottom - aoTop) * 0.43);
  };

  // Price grid levels (4 clean MT5 price ticks on the right axis)
  const priceTicks = useMemo(() => {
    const levels: number[] = [];
    const span = maxPrice - minPrice;
    for (let i = 0; i <= 3; i++) {
      levels.push(minPrice + (span * (i + 0.5)) / 4);
    }
    return levels;
  }, [minPrice, maxPrice]);

  // Current Bid & Ask lines
  const currentBid =
    chartMode === 'live'
      ? liveBid ?? liveMarketPrice ?? bar0?.close ?? null
      : bar0?.close ?? null;
  const currentAsk =
    chartMode === 'live' && liveAsk !== null ? liveAsk : null;
  const currentBidY = currentBid !== null ? yPrice(currentBid) : null;
  const currentAskY = currentAsk !== null ? yPrice(currentAsk) : null;

  // Crossover marker & dashed price trigger line
  const triggerCandle = useMemo(() => {
    if (chartMode === 'simulator') {
      return activeDirection ? bar1 ?? null : null;
    }
    if (lastHistoricalCross) {
      return candles.find((c) => c.shift === lastHistoricalCross.shift) ?? null;
    }
    return null;
  }, [chartMode, activeDirection, bar1, lastHistoricalCross, candles]);

  const triggerDirection: SignalDirection | null =
    chartMode === 'simulator'
      ? activeDirection
      : lastHistoricalCross?.direction ?? null;

  const clockDisplay = liveUpdatedAt
    ? new Date(liveUpdatedAt).toLocaleTimeString('th-TH', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : new Date(nowMs).toLocaleTimeString('th-TH', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });

  // Live M5 Candle Countdown (e.g. 03:42)
  const barCountdownLabel = useMemo(() => {
    const fiveMin = 5 * 60 * 1000;
    const targetMs = liveBarCloseTimeIso
      ? new Date(liveBarCloseTimeIso).getTime()
      : Math.floor(nowMs / fiveMin) * fiveMin + fiveMin;
    const diffSec = Math.max(0, Math.floor((targetMs - nowMs) / 1000)) % 300;
    const mm = String(Math.floor(diffSec / 60)).padStart(2, '0');
    const ss = String(diffSec % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  }, [liveBarCloseTimeIso, nowMs]);

  const firstTimeLabel = candles[3]?.timeLabel ?? '';
  const midTimeLabel = candles[Math.floor(candles.length * 0.5)]?.timeLabel ?? '';

  return (
    <div className="space-y-3.5">
      {/* Top Clean White Control Card */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5 shadow-xs">
        <div
          className="inline-flex items-center gap-1 rounded-xl bg-slate-100 p-1"
          role="group"
          aria-label="เลือกโหมดกราฟ US100 M5"
        >
          <button
            type="button"
            onClick={() => onChangeChartMode('live')}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
              chartMode === 'live'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Radio
              className={`h-3.5 w-3.5 ${
                chartMode === 'live' ? 'text-emerald-600' : 'text-slate-400'
              }`}
              aria-hidden="true"
            />
            กราฟจริง M5
          </button>
          <button
            type="button"
            onClick={() => onChangeChartMode('simulator')}
            className={`rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
              chartMode === 'simulator'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            จำลอง M5
          </button>
        </div>

        {/* Title Line */}
        <div className="mt-3.5 flex flex-wrap items-center gap-2 text-sm">
          <span className="font-display font-bold text-slate-900">US100Cash</span>
          <span className="text-slate-300" aria-hidden="true">
            ·
          </span>
          <span className="font-mono font-semibold text-amber-600">
            M5 · AO(5,34)
          </span>
          <span className="text-slate-300" aria-hidden="true">
            ·
          </span>
          <span className="text-slate-500">XM MT5 Real-Time</span>
        </div>

        {/* Direction Filter Select */}
        <div className="mt-3">
          <select
            aria-label="ตัวกรองทิศทางสัญญาณ"
            value={alertFilter}
            onChange={(e) =>
              onChangeAlertFilter(e.target.value as AlertDirectionFilter)
            }
            className="w-full max-w-xs rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm font-medium text-slate-800 focus:border-slate-900 focus:outline-none"
          >
            <option value="both">เตือนทั้งขาขึ้น &amp; ขาลง</option>
            <option value="buy_only">เตือนเฉพาะขาขึ้น (BUY ตัด 0 ขึ้น)</option>
            <option value="sell_only">เตือนเฉพาะขาลง (SELL ตัด 0 ลง)</option>
          </select>
        </div>

        {/* Action Buttons Row */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {chartMode === 'live' ? (
            <>
              <button
                type="button"
                onClick={onRefreshLive}
                disabled={liveLoading}
                className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-800 transition-colors hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 text-slate-700 ${
                    liveLoading ? 'animate-spin' : ''
                  }`}
                  aria-hidden="true"
                />
                {liveLoading ? 'กำลังดึงกราฟ...' : 'รีเฟรชกราฟจริง'}
              </button>

              <button
                type="button"
                onClick={onToggleAutoRefresh}
                aria-pressed={autoRefreshEnabled}
                className={`inline-flex items-center gap-2 rounded-xl border px-3.5 py-2 text-xs font-medium transition-colors whitespace-nowrap shrink-0 tabular-nums ${
                  autoRefreshEnabled
                    ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                    : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                <Radio
                  className={`h-3.5 w-3.5 ${
                    autoRefreshEnabled ? 'text-emerald-600' : 'text-slate-400'
                  }`}
                  aria-hidden="true"
                />
                Auto-Refresh (5 วิ)
                {autoRefreshEnabled ? ` · ${nextRefreshInSec}s` : ' · ปิด'}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={onToggleSimPlay}
                aria-pressed={simPlaying}
                className={`inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-semibold text-white transition-colors whitespace-nowrap shrink-0 ${
                  simPlaying
                    ? 'bg-amber-600 hover:bg-amber-700'
                    : 'bg-slate-900 hover:bg-slate-800'
                }`}
              >
                {simPlaying ? (
                  <>
                    <Pause className="h-3.5 w-3.5" aria-hidden="true" />
                    หยุดจำลอง
                  </>
                ) : (
                  <>
                    <Play className="h-3.5 w-3.5" aria-hidden="true" />
                    เล่นจำลองแท่งเทียน
                  </>
                )}
              </button>

              <div
                className="inline-flex items-center gap-0.5 rounded-xl border border-slate-200 bg-slate-50 p-0.5"
                role="group"
                aria-label="ความเร็วจำลองแท่งเทียน"
              >
                {([1, 2] as const).map((spd) => (
                  <button
                    key={spd}
                    type="button"
                    onClick={() => onChangeSimSpeed(spd)}
                    className={`rounded-lg px-2.5 py-1.5 font-mono text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                      simSpeed === spd
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-500 hover:text-slate-900'
                    }`}
                  >
                    {spd}x
                  </button>
                ))}
              </div>
            </>
          )}

          <button
            type="button"
            onClick={onToggleSound10s}
            className={`inline-flex items-center gap-2 rounded-xl border px-3.5 py-2 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
              sound10sEnabled
                ? 'border-sky-300 bg-sky-50 text-sky-700'
                : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
            }`}
          >
            {sound10sEnabled ? (
              <Volume2 className="h-3.5 w-3.5 text-sky-600" aria-hidden="true" />
            ) : (
              <VolumeX className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
            )}
            เสียง 10 วิ
          </button>

          <button
            type="button"
            onClick={onTestSound}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-800 transition-colors hover:bg-slate-50 whitespace-nowrap shrink-0"
          >
            <Bell className="h-3.5 w-3.5 text-sky-600" aria-hidden="true" />
            ทดสอบเสียง
          </button>

          <button
            type="button"
            onClick={onTriggerMobileAlert}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-800 transition-colors hover:bg-slate-50 whitespace-nowrap shrink-0"
          >
            <Smartphone className="h-3.5 w-3.5 text-slate-700" aria-hidden="true" />
            แจ้งเตือนเข้ามือถือ
          </button>

          <button
            type="button"
            onClick={onOpenTelegramAction}
            className="inline-flex items-center gap-2 rounded-xl border border-sky-200 bg-sky-50/70 px-3.5 py-2 text-xs font-medium text-sky-700 transition-colors hover:bg-sky-100 whitespace-nowrap shrink-0"
          >
            <Send className="h-3.5 w-3.5 text-sky-600" aria-hidden="true" />
            Telegram ({!telegramEnabled ? 'ปิด' : telegramReady ? 'เชื่อมต่อแล้ว' : telegramChatId})
            {telegramEnabled && telegramAutoSend ? ' · Auto' : ''}
          </button>
        </div>

        {chartMode === 'live' && lastHistoricalCross && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2.5 text-xs text-slate-600">
            <span>
              พบ AO ตัดเส้น 0 ล่าสุดบนกราฟจริง:{' '}
              <span
                className={`font-semibold ${
                  lastHistoricalCross.direction === 'BUY'
                    ? 'text-emerald-700'
                    : 'text-rose-700'
                }`}
              >
                {lastHistoricalCross.direction}
              </span>{' '}
              ที่ราคา{' '}
              <span className="font-mono font-semibold text-slate-900 tabular-nums">
                {lastHistoricalCross.price.toFixed(2)}
              </span>{' '}
              ({lastHistoricalCross.timeLabel})
            </span>
            <button
              type="button"
              onClick={onUseHistoricalLiveCross}
              className="font-medium text-sky-700 underline underline-offset-2 hover:text-sky-900 whitespace-nowrap"
            >
              ส่งสัญญาณนี้เข้าตัวอย่างแจ้งเตือน
            </button>
          </div>
        )}

        {chartMode === 'live' && liveError && (
          <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
            {liveError}
          </div>
        )}
      </section>

      {/* Pure Black XM MT5 Mobile Terminal Chart Card */}
      <section className="overflow-hidden rounded-2xl border border-slate-800 bg-black p-3.5 sm:p-4 text-white shadow-sm">
        {/* Top MT5 Mobile Terminal Overlay */}
        <div className="mb-2 space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono font-bold text-sky-400">
                {chartMode === 'live' ? `${liveFeedSymbol}, M5` : 'US100Cash, M5'}
              </span>
              <span className="text-slate-600" aria-hidden="true">
                ·
              </span>
              <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-slate-200 tabular-nums">
                <span
                  className={`h-2 w-2 rounded-full ${
                    chartMode === 'live'
                      ? liveIsRealtime
                        ? 'bg-emerald-500 animate-pulse'
                        : 'bg-amber-400'
                      : simPlaying
                        ? 'bg-emerald-500 animate-pulse'
                        : 'bg-slate-500'
                  }`}
                  aria-hidden="true"
                />
                {chartMode === 'live'
                  ? `XM MT5 เรียลไทม์ · ${clockDisplay}`
                  : simPlaying
                    ? `จำลอง (${simSpeed}x) · ${simSwingLabel} · ${simTickInBar}/${TICKS_PER_SIM_BAR}`
                    : `โหมดจำลอง · ${simSwingLabel}`}
              </span>
            </div>

            {bar1 && bar2 && (
              <div className="flex items-center gap-1.5 font-mono text-[11px] tabular-nums">
                <span className="text-slate-400">
                  AO[2]:{' '}
                  <span className={bar2.ao >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                    {formatSignedAo(bar2.ao, 2)}
                  </span>
                </span>
                <span className="text-slate-600">→</span>
                <span className="text-slate-400">
                  AO[1]:{' '}
                  <span
                    className={
                      bar1.ao >= 0
                        ? 'font-semibold text-emerald-400'
                        : 'font-semibold text-rose-400'
                    }
                  >
                    {formatSignedAo(bar1.ao, 2)}
                  </span>
                </span>
              </div>
            )}
          </div>

          {/* MT5 Bid/Ask/Spread & OHLC Strip */}
          <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[11px] tabular-nums">
            {activeCandle ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-slate-400">{activeCandle.timeLabel}</span>
                <span className="text-slate-400">
                  O {activeCandle.open.toFixed(spec.priceDigits)}
                </span>
                <span className="text-slate-400">
                  H {activeCandle.high.toFixed(spec.priceDigits)}
                </span>
                <span className="text-slate-400">
                  L {activeCandle.low.toFixed(spec.priceDigits)}
                </span>
                <span
                  className={`font-semibold ${
                    activeCandle.close >= activeCandle.open
                      ? 'text-sky-400'
                      : 'text-white'
                  }`}
                >
                  C {activeCandle.close.toFixed(spec.priceDigits)}
                </span>
              </div>
            ) : (
              <span className="text-slate-500">กำลังเชื่อมต่อฟีดราคา...</span>
            )}

            {chartMode === 'live' && currentBid !== null && (
              <div className="flex items-center gap-2 text-[11px]">
                <span className="text-rose-400">
                  Bid {currentBid.toFixed(2)}
                </span>
                {currentAsk !== null && (
                  <span className="text-slate-400">
                    Ask {currentAsk.toFixed(2)}
                  </span>
                )}
                {liveSpread !== null && (
                  <span className="text-slate-500">Sp {liveSpread.toFixed(2)}</span>
                )}
                <span className="text-amber-400">ปิดแท่ง {barCountdownLabel}</span>
              </div>
            )}
          </div>
        </div>

        {/* Responsive Mobile-First SVG Chart (No horizontal scroll clipping on mobile) */}
        {candles.length === 0 ? (
          <div className="flex h-[360px] items-center justify-center font-mono text-xs text-slate-400">
            กำลังเชื่อมต่อกราฟจริง XM MT5 (US100Cash M5)...
          </div>
        ) : (
          <div className="w-full">
            <svg
              viewBox={`0 0 ${width} ${chartHeight}`}
              className="h-auto w-full select-none"
              role="img"
              aria-label="กราฟแท่งเทียน US100Cash M5 แบบเรียลไทม์สไตล์ XM MT5 บนมือถือ พร้อมอินดิเคเตอร์ AO ขึ้นสีเขียวลงสีแดง"
            >
              {/* Subtle MT5 Dark Dashed Horizontal Price Grid */}
              {priceTicks.map((tickVal, i) => {
                const gy = yPrice(tickVal);
                return (
                  <g key={`grid-${i}`}>
                    <line
                      x1={padLeft}
                      y1={gy}
                      x2={padLeft + plotW}
                      y2={gy}
                      stroke="#141C2B"
                      strokeDasharray="3 4"
                      strokeWidth="1"
                    />
                    <text
                      x={padLeft + plotW + 6}
                      y={gy + 3.5}
                      fill="#64748B"
                      fontSize="10"
                      fontFamily="JetBrains Mono, monospace"
                    >
                      {tickVal.toFixed(2)}
                    </text>
                  </g>
                );
              })}

              {/* Vertical MT5 Separator Border before Price Axis */}
              <line
                x1={padLeft + plotW}
                y1={8}
                x2={padLeft + plotW}
                y2={aoBottom}
                stroke="#1E293B"
                strokeWidth="1"
              />

              {/* Subtle dashed trigger price level inside chart */}
              {triggerCandle && triggerDirection && (
                <g>
                  {(() => {
                    const cxTrigger =
                      padLeft + triggerCandle.index * stepX + stepX / 2;
                    const trigY = yPrice(triggerCandle.close);
                    const trigColor =
                      triggerDirection === 'BUY' ? '#22C55E' : '#EAB308';
                    return (
                      <>
                        <line
                          x1={cxTrigger}
                          y1={trigY}
                          x2={padLeft + plotW - 108}
                          y2={trigY}
                          stroke={trigColor}
                          strokeDasharray="4 4"
                          strokeWidth="1.25"
                        />
                        <text
                          x={padLeft + plotW - 102}
                          y={trigY + 3.5}
                          fill={trigColor}
                          fontSize="10"
                          fontWeight="600"
                          fontFamily="JetBrains Mono, monospace"
                        >
                          AO {triggerDirection === 'BUY' ? 'ขึ้น' : 'ลง'}{' '}
                          {triggerCandle.close.toFixed(2)}
                        </text>
                      </>
                    );
                  })()}
                </g>
              )}

              {/* MT5 Candlesticks (Blue Bullish / White Bearish matching MT5 Mobile) */}
              {candles.map((c, idx) => {
                const cx = padLeft + idx * stepX + stepX / 2;
                const isBull = c.close >= c.open;
                const bodyColor = isBull ? '#2563EB' : '#F8FAFC';
                const wickColor = isBull ? '#38BDF8' : '#CBD5E1';
                const bodyTop = yPrice(Math.max(c.open, c.close));
                const bodyBot = yPrice(Math.min(c.open, c.close));
                const bodyH = Math.max(1.5, bodyBot - bodyTop);
                const highY = yPrice(c.high);
                const lowY = yPrice(c.low);

                return (
                  <g
                    key={`c-${idx}`}
                    onMouseEnter={() => setHoveredIdx(idx)}
                    onMouseLeave={() => setHoveredIdx(null)}
                    onTouchStart={() => setHoveredIdx(idx)}
                    className="cursor-crosshair"
                  >
                    <rect
                      x={cx - stepX / 2}
                      y={0}
                      width={stepX}
                      height={chartHeight - 20}
                      fill="transparent"
                    />
                    <line
                      x1={cx}
                      y1={highY}
                      x2={cx}
                      y2={lowY}
                      stroke={wickColor}
                      strokeWidth="1.25"
                    />
                    <rect
                      x={cx - candleW / 2}
                      y={bodyTop}
                      width={candleW}
                      height={bodyH}
                      fill={bodyColor}
                      rx="0.5"
                    />

                    {/* Zero-cross highlight bar */}
                    {triggerCandle &&
                      triggerCandle.index === idx &&
                      triggerDirection && (
                        <line
                          x1={cx - candleW}
                          y1={
                            triggerDirection === 'BUY'
                              ? bodyTop - 6
                              : bodyBot + 6
                          }
                          x2={cx + candleW}
                          y2={
                            triggerDirection === 'BUY'
                              ? bodyTop - 6
                              : bodyBot + 6
                          }
                          stroke={
                            triggerDirection === 'BUY' ? '#22C55E' : '#EF4444'
                          }
                          strokeWidth="3"
                        />
                      )}

                    {hoveredIdx === idx && (
                      <line
                        x1={cx}
                        y1={8}
                        x2={cx}
                        y2={aoBottom}
                        stroke="#475569"
                        strokeDasharray="2 2"
                        strokeWidth="1"
                      />
                    )}
                  </g>
                );
              })}

              {/* MT5 Ask Line (thin gray dotted line above Bid) */}
              {currentAskY !== null && (
                <line
                  x1={padLeft}
                  y1={currentAskY}
                  x2={padLeft + plotW}
                  y2={currentAskY}
                  stroke="#64748B"
                  strokeDasharray="2 3"
                  strokeWidth="1"
                />
              )}

              {/* MT5 Live Red Bid Line + Highlighted Right-Axis Price Tag */}
              {currentBidY !== null && currentBid !== null && (
                <g>
                  <line
                    x1={padLeft}
                    y1={currentBidY}
                    x2={padLeft + plotW}
                    y2={currentBidY}
                    stroke="#DC2626"
                    strokeWidth="1.35"
                  />
                  <rect
                    x={padLeft + plotW + 2}
                    y={currentBidY - 9}
                    width={64}
                    height={18}
                    rx="3"
                    fill="#DC2626"
                  />
                  <text
                    x={padLeft + plotW + 6}
                    y={currentBidY + 3.5}
                    fill="#FFFFFF"
                    fontSize="10"
                    fontWeight="700"
                    fontFamily="JetBrains Mono, monospace"
                  >
                    {currentBid.toFixed(2)}
                  </text>
                </g>
              )}

              {/* MT5 Indicator Sub-window Separator */}
              <line
                x1={padLeft}
                y1={aoTop - 10}
                x2={width - 4}
                y2={aoTop - 10}
                stroke="#1E293B"
                strokeWidth="1"
              />

              {/* Embedded In-Chart AO(5,34) Indicator (Green Rising / Red Falling) */}
              <g>
                <text
                  x={padLeft + 2}
                  y={aoTop + 4}
                  fill="#94A3B8"
                  fontSize="10"
                  fontFamily="JetBrains Mono, monospace"
                >
                  AO(5,34)
                </text>
                {bar0 && (
                  <text
                    x={padLeft + 58}
                    y={aoTop + 4}
                    fill={bar0.aoRising ? '#22C55E' : '#EF4444'}
                    fontSize="10"
                    fontWeight="600"
                    fontFamily="JetBrains Mono, monospace"
                  >
                    {formatSignedAo(bar0.ao, 2)}
                  </text>
                )}

                {/* Zero Line 0.00 */}
                <line
                  x1={padLeft}
                  y1={aoMidY}
                  x2={padLeft + plotW}
                  y2={aoMidY}
                  stroke="#334155"
                  strokeDasharray="3 3"
                  strokeWidth="1"
                />
                <text
                  x={padLeft + plotW + 6}
                  y={aoMidY + 3.5}
                  fill="#94A3B8"
                  fontSize="10"
                  fontFamily="JetBrains Mono, monospace"
                >
                  0.00
                </text>

                {/* AO Histogram Bars: Up = Green (#22C55E), Down = Red (#EF4444) */}
                {candles.map((c, idx) => {
                  const cx = padLeft + idx * stepX + stepX / 2;
                  const valY = yAo(c.ao);
                  const top = Math.min(aoMidY, valY);
                  const h = Math.max(2, Math.abs(valY - aoMidY));
                  const color = c.aoRising ? '#22C55E' : '#EF4444';

                  return (
                    <rect
                      key={`ao-in-${idx}`}
                      x={cx - candleW / 2}
                      y={top}
                      width={candleW}
                      height={h}
                      fill={color}
                      rx="1"
                    />
                  );
                })}

                {/* Colored AO Signal Curve Overlay */}
                {candles.map((c, idx) => {
                  if (idx === 0) return null;
                  const prev = candles[idx - 1];
                  const x1 = padLeft + (idx - 1) * stepX + stepX / 2;
                  const y1 = yAo(prev.ao);
                  const x2 = padLeft + idx * stepX + stepX / 2;
                  const y2 = yAo(c.ao);
                  const segColor = c.ao >= prev.ao ? '#4ADE80' : '#F87171';
                  return (
                    <line
                      key={`ao-line-${idx}`}
                      x1={x1}
                      y1={y1}
                      x2={x2}
                      y2={y2}
                      stroke={segColor}
                      strokeWidth="1.35"
                      opacity="0.9"
                    />
                  );
                })}
              </g>

              {/* Bottom Time Axis inside Black MT5 Frame */}
              <line
                x1={padLeft}
                y1={chartHeight - 24}
                x2={width - 4}
                y2={chartHeight - 24}
                stroke="#1E293B"
                strokeWidth="1"
              />
              {firstTimeLabel && (
                <text
                  x={padLeft + 12}
                  y={chartHeight - 8}
                  fill="#94A3B8"
                  fontSize="10"
                  fontFamily="JetBrains Mono, monospace"
                >
                  {firstTimeLabel}
                </text>
              )}
              {midTimeLabel && (
                <text
                  x={padLeft + plotW * 0.48}
                  y={chartHeight - 8}
                  fill="#94A3B8"
                  fontSize="10"
                  fontFamily="JetBrains Mono, monospace"
                >
                  {midTimeLabel}
                </text>
              )}
              {bar0 && (
                <text
                  x={padLeft + plotW - 32}
                  y={chartHeight - 8}
                  fill="#E2E8F0"
                  fontSize="10"
                  fontWeight="600"
                  fontFamily="JetBrains Mono, monospace"
                >
                  {bar0.timeLabel}
                </text>
              )}
            </svg>
          </div>
        )}
      </section>
    </div>
  );
}
