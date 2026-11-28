import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { SYMBOL_SPECS, type TradingSymbol } from '../lib/aoSimulator';

export interface PlainM5Bar {
  index: number;
  timeLabel: string;
  timestampIso: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface LiveM5CandlesResponse {
  symbol: TradingSymbol;
  timeframe: 'M5';
  source: string;
  feedProvider?: 'xm_bridge' | 'cfd_ws' | 'yahoo_fallback';
  brokerSymbol?: string;
  marketState: string;
  fetchedAt: string;
  bars: PlainM5Bar[];
}

interface M5CandleChartViewProps {
  isWebMode?: boolean;
  splitRole?: 'combined_bottom';
}

function formatM5AxisDate(timestampIso: string): string {
  const dt = new Date(timestampIso);
  if (Number.isNaN(dt.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Bangkok',
  }).formatToParts(dt);
  const day = parts.find((p) => p.type === 'day')?.value || '';
  const month = parts.find((p) => p.type === 'month')?.value || '';
  const hour = parts.find((p) => p.type === 'hour')?.value || '';
  const minute = parts.find((p) => p.type === 'minute')?.value || '';
  return `${day} ${month} ${hour}:${minute}`;
}

function formatM5Countdown(): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const remaining = 300 - (nowSec % 300);
  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export const M5CandleChartView: React.FC<M5CandleChartViewProps> = ({
  isWebMode = false,
  splitRole,
}) => {
  const isCombinedBottom = splitRole === 'combined_bottom';
  const symbol: TradingSymbol = 'US100';
  const spec = SYMBOL_SPECS[symbol];

  const [bars, setBars] = useState<PlainM5Bar[]>([]);
  const [marketState, setMarketState] = useState<string>('');
  const [feedProvider, setFeedProvider] = useState<
    'xm_bridge' | 'cfd_ws' | 'yahoo_fallback' | null
  >(null);
  const [brokerSymbolLabel, setBrokerSymbolLabel] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [barCountdown, setBarCountdown] = useState<string>(() => formatM5Countdown());
  const [tickFlash, setTickFlash] = useState<'up' | 'down' | null>(null);
  const [lastTickTime, setLastTickTime] = useState<string | null>(null);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const chartScrollRef = useRef<HTMLDivElement | null>(null);
  const userPannedChartRef = useRef<boolean>(false);
  const expectedAutoScrollRef = useRef<number | null>(null);
  const tickFlashTimerRef = useRef<number | null>(null);
  const isFetchingRef = useRef<boolean>(false);
  const prevBucketRef = useRef<number | null>(null);
  const barsLenRef = useRef<number>(0);
  barsLenRef.current = bars.length;

  const fetchLiveM5Bars = useCallback(
    async (options?: { showSpinner?: boolean; force?: boolean }) => {
      if (!options?.force && isFetchingRef.current) return;
      isFetchingRef.current = true;
      if (options?.showSpinner || barsLenRef.current === 0) {
        setIsLoading(true);
      }
      setLiveError(null);

      try {
        const res = await fetch(`/api/market/m5-candles?symbol=${encodeURIComponent(symbol)}`);
        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          throw new Error(errBody.error || 'ดึงข้อมูลกราฟจริง M5 ไม่สำเร็จ');
        }
        const data = (await res.json()) as LiveM5CandlesResponse;
        if (Array.isArray(data.bars) && data.bars.length > 0) {
          setBars(data.bars);
        }
        setMarketState(data.marketState || '');
        if (data.feedProvider) setFeedProvider(data.feedProvider);
        if (data.brokerSymbol) setBrokerSymbolLabel(data.brokerSymbol);
      } catch (err: any) {
        setLiveError(err?.message || 'เชื่อมต่อฟีดกราฟจริง M5 ไม่สำเร็จ');
      } finally {
        isFetchingRef.current = false;
        setIsLoading(false);
      }
    },
    [symbol]
  );

  const fetchLiveTick = useCallback(async () => {
    try {
      const res = await fetch(`/api/market/tick?symbol=${encodeURIComponent(symbol)}`);
      if (!res.ok) return;
      const tick = (await res.json()) as {
        price: number;
        feedProvider?: 'xm_bridge' | 'cfd_ws' | 'yahoo_fallback';
        marketState: string;
        fetchedAt: string;
      };
      if (!Number.isFinite(tick.price) || tick.price <= 0) return;

      setMarketState(tick.marketState);
      if (tick.feedProvider) setFeedProvider(tick.feedProvider);
      setLastTickTime(
        new Date(tick.fetchedAt).toLocaleTimeString('th-TH', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        })
      );

      setBars((prev) => {
        if (prev.length === 0) return prev;
        const lastIdx = prev.length - 1;
        const lastBar = prev[lastIdx];
        if (tick.price !== lastBar.close) {
          setTickFlash(tick.price > lastBar.close ? 'up' : 'down');
          if (tickFlashTimerRef.current !== null) {
            window.clearTimeout(tickFlashTimerRef.current);
          }
          tickFlashTimerRef.current = window.setTimeout(() => {
            setTickFlash(null);
          }, 700);
        }
        return prev.map((b, idx) =>
          idx === lastIdx
            ? {
                ...b,
                close: tick.price,
                high: Math.max(b.high, tick.price),
                low: Math.min(b.low, tick.price),
              }
            : b
        );
      });
    } catch {
      // Transient tick failure; bar poll handles sync
    }
  }, [symbol]);

  useEffect(() => {
    void fetchLiveM5Bars({ showSpinner: true, force: true });
    const barPollId = window.setInterval(() => {
      void fetchLiveM5Bars({ showSpinner: false });
    }, 3000);
    const tickPollId = window.setInterval(() => {
      void fetchLiveTick();
    }, 2000);
    return () => {
      window.clearInterval(barPollId);
      window.clearInterval(tickPollId);
    };
  }, [fetchLiveM5Bars, fetchLiveTick]);

  useEffect(() => {
    setBarCountdown(formatM5Countdown());
    const id = window.setInterval(() => {
      setBarCountdown(formatM5Countdown());
      const currBucket = Math.floor(Date.now() / 300000);
      const prev = prevBucketRef.current;
      prevBucketRef.current = currBucket;
      if (prev !== null && currBucket !== prev) {
        void fetchLiveM5Bars({ force: true });
      }
    }, 1000);
    return () => {
      window.clearInterval(id);
      if (tickFlashTimerRef.current !== null) {
        window.clearTimeout(tickFlashTimerRef.current);
      }
    };
  }, [fetchLiveM5Bars]);

  const visibleSliceCount = 72;
  const visibleStartIdx = Math.max(0, bars.length - visibleSliceCount);
  const visibleBars = useMemo(
    () => bars.slice(visibleStartIdx),
    [bars, visibleStartIdx]
  );

  const chartMetrics = useMemo(() => {
    const highs = visibleBars.map((b) => b.high);
    const lows = visibleBars.map((b) => b.low);
    const maxPrice = highs.length ? Math.max(...highs) : spec.basePrice + 10;
    const minPrice = lows.length ? Math.min(...lows) : spec.basePrice - 10;
    const span = maxPrice - minPrice || spec.stepSize;
    return {
      priceTop: maxPrice + span * 0.14,
      priceBottom: minPrice - span * 0.14,
    };
  }, [visibleBars, spec.basePrice, spec.stepSize]);

  const activeBar =
    hoveredIdx !== null && visibleBars[hoveredIdx]
      ? visibleBars[hoveredIdx]
      : visibleBars[visibleBars.length - 1];
  const latestFormingBar = visibleBars[visibleBars.length - 1];

  // SVG Layout: Single Clean M5 Candlestick Pane (No Indicators)
  const svgW = 860;
  const priceTopY = 8;
  const priceH = 260;
  const xAxisY = priceTopY + priceH;
  const totalH = xAxisY + 26;

  const padL = 8;
  const padR = isWebMode ? 8 : 88;
  const plotLeft = padL;
  const plotRight = svgW - padR;
  const totalPlotW = plotRight - plotLeft;

  const activeCandlesW = totalPlotW * 0.72;
  const slotW = activeCandlesW / Math.max(1, visibleBars.length);
  const candleW = Math.max(3.0, Math.min(5.4, slotW * 0.6));

  useEffect(() => {
    const container = chartScrollRef.current;
    if (!container || userPannedChartRef.current || visibleBars.length === 0) return;

    const rafId = window.requestAnimationFrame(() => {
      const el = chartScrollRef.current;
      if (!el || userPannedChartRef.current) return;
      const maxScroll = Math.max(0, el.scrollWidth - el.clientWidth);
      if (maxScroll <= 0) {
        expectedAutoScrollRef.current = null;
        return;
      }
      const latestCandleSvgX =
        plotLeft + 6 + Math.max(0, visibleBars.length - 1) * slotW + slotW / 2;
      const latestCandlePx = (latestCandleSvgX / svgW) * el.scrollWidth;
      const targetScroll = Math.max(
        0,
        Math.min(maxScroll, Math.round(latestCandlePx - el.clientWidth * 0.65))
      );
      expectedAutoScrollRef.current = targetScroll;
      el.scrollLeft = targetScroll;
    });

    return () => window.cancelAnimationFrame(rafId);
  }, [isWebMode, visibleBars.length, plotLeft, slotW, svgW]);

  const priceToY = (p: number) => {
    const ratio =
      (chartMetrics.priceTop - p) / (chartMetrics.priceTop - chartMetrics.priceBottom);
    return priceTopY + 12 + ratio * (priceH - 24);
  };

  const latestCloseY = latestFormingBar ? priceToY(latestFormingBar.close) : priceH / 2;
  const priceTickRatios = [0.06, 0.25, 0.44, 0.63, 0.82];

  return (
    <div
      className={
        isCombinedBottom
          ? 'flex flex-col rounded-t-none rounded-b-2xl border border-t-0 border-neutral-800 bg-[#05080f] p-3.5 sm:p-4 text-neutral-200 shadow-sm'
          : 'flex flex-col rounded-2xl border border-slate-800 bg-[#05080f] p-3.5 sm:p-4 text-neutral-200 shadow-sm'
      }
    >
      {/* Top Telemetry Header */}
      <div className="mb-2.5 space-y-1.5 border-b border-slate-800/80 px-1 pb-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-blue-400">US100 · M5</span>
            <span aria-hidden="true" className="text-slate-600">·</span>
            <span className="text-slate-300 tabular-nums">
              {marketState === 'MARKET CLOSED'
                ? 'ตลาดปิด (ล่าสุด)'
                : feedProvider === 'xm_bridge'
                ? `XM MT5 Bridge · สด${lastTickTime ? ` (${lastTickTime})` : ''}`
                : feedProvider === 'cfd_ws'
                ? `MT5 CFD${brokerSymbolLabel ? ` (${brokerSymbolLabel})` : ''} · สด${
                    lastTickTime ? ` (${lastTickTime})` : ''
                  }`
                : `MT5 เรียลไทม์${lastTickTime ? ` (${lastTickTime})` : ''}`}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[11px] text-slate-400">
              กราฟเปล่า M5 (ไม่แจ้งเตือน · ไม่มีอินดิเคเตอร์)
            </span>
            <button
              type="button"
              onClick={() => void fetchLiveM5Bars({ showSpinner: true, force: true })}
              disabled={isLoading}
              aria-label="รีเฟรชกราฟ M5"
              className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-700 bg-slate-900 px-2 text-[11px] font-medium text-slate-300 transition-colors hover:bg-slate-800 disabled:opacity-50"
            >
              <RefreshCw className={`h-3 w-3 ${isLoading ? 'animate-spin' : ''}`} />
              รีเฟรช
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 font-mono text-xs tabular-nums">
          <span className="text-slate-400">{activeBar?.timeLabel || '--:--'}</span>
          {activeBar && (
            <span className="hidden sm:inline text-slate-400">
              O {activeBar.open.toFixed(spec.digits)} · H {activeBar.high.toFixed(spec.digits)} · L{' '}
              {activeBar.low.toFixed(spec.digits)}
            </span>
          )}
          <span
            className={`font-semibold transition-colors ${
              tickFlash === 'up'
                ? 'text-sky-400'
                : tickFlash === 'down'
                ? 'text-rose-400'
                : 'text-slate-100'
            }`}
          >
            C {activeBar ? activeBar.close.toFixed(spec.digits) : '—'}
          </span>
        </div>
      </div>

      {liveError && (
        <div className="mb-2.5 rounded-lg border border-rose-500/30 bg-rose-950/45 px-3 py-2 text-xs text-rose-200">
          {liveError}
        </div>
      )}

      {/* Pure M5 Candlestick SVG */}
      <div
        ref={chartScrollRef}
        onScroll={() => {
          const el = chartScrollRef.current;
          if (!el) return;
          if (
            expectedAutoScrollRef.current !== null &&
            Math.abs(el.scrollLeft - expectedAutoScrollRef.current) <= 4
          ) {
            expectedAutoScrollRef.current = null;
            return;
          }
          expectedAutoScrollRef.current = null;
          userPannedChartRef.current = true;
        }}
        className="relative w-full overflow-x-auto"
      >
        <svg
          viewBox={`0 0 ${svgW} ${totalH}`}
          className="h-auto w-full min-w-[580px] select-none"
          role="img"
          aria-label="กราฟแท่งเทียน US100 M5 แบบกราฟเปล่าไม่มีอินดิเคเตอร์"
        >
          <rect x={0} y={0} width={svgW} height={totalH} fill="#05080f" />

          {!isWebMode && (
            <>
              <line
                x1={plotRight}
                y1={priceTopY}
                x2={plotRight}
                y2={xAxisY}
                stroke="#1e293b"
                strokeWidth="1"
              />

              {priceTickRatios.map((ratio, idx) => {
                const y = priceTopY + 12 + ratio * (priceH - 24);
                const priceVal =
                  chartMetrics.priceTop -
                  ratio * (chartMetrics.priceTop - chartMetrics.priceBottom);
                return (
                  <g key={`m5-p-tick-${idx}`}>
                    <line
                      x1={plotLeft}
                      y1={y}
                      x2={plotRight}
                      y2={y}
                      stroke="#0f172a"
                      strokeWidth="1"
                    />
                    <line
                      x1={plotRight}
                      y1={y}
                      x2={plotRight + 4}
                      y2={y}
                      stroke="#334155"
                      strokeWidth="1"
                    />
                    <text
                      x={plotRight + 8}
                      y={y + 4}
                      fontSize="11.5"
                      fill="#94a3b8"
                      className="font-mono tabular-nums"
                    >
                      {priceVal.toFixed(spec.digits)}
                    </text>
                  </g>
                );
              })}
            </>
          )}

          {isWebMode &&
            priceTickRatios.map((ratio, idx) => {
              const y = priceTopY + 12 + ratio * (priceH - 24);
              return (
                <line
                  key={`m5-grid-${idx}`}
                  x1={plotLeft}
                  y1={y}
                  x2={plotRight}
                  y2={y}
                  stroke="#0f172a"
                  strokeWidth="1"
                />
              );
            })}

          {/* Upper Pane Watermark */}
          <text
            x={plotLeft + 8}
            y={24}
            fontSize="12.5"
            fontWeight="700"
            fill="#3b82f6"
            className="font-sans"
          >
            US100
            <tspan fill="#94a3b8" fontWeight="400" fontSize="12">
              {' '}
              ▾ M5
            </tspan>
          </text>
          <text
            x={plotLeft + 8}
            y={40}
            fontSize="11.5"
            fill="#94a3b8"
            className="font-sans"
          >
            US 100 Index Cash
          </text>

          {/* Candlesticks */}
          {visibleBars.map((bar, idx) => {
            const xCenter = plotLeft + 6 + idx * slotW + slotW / 2;
            const isBull = bar.close >= bar.open;
            const bodyColor = isBull ? '#1e88e5' : '#e2e8f0';
            const wickColor = isBull ? '#38bdf8' : '#e2e8f0';
            const yHigh = priceToY(bar.high);
            const yLow = priceToY(bar.low);
            const yOpen = priceToY(bar.open);
            const yClose = priceToY(bar.close);
            const bodyTop = Math.min(yOpen, yClose);
            const bodyH = Math.max(1.5, Math.abs(yClose - yOpen));
            const isHovered = hoveredIdx === idx;
            const showXTick = idx === 4 || idx === 24 || idx === 44 || idx === 64;

            return (
              <g
                key={`m5-candle-${bar.timestampIso}-${idx}`}
                onMouseEnter={() => setHoveredIdx(idx)}
                onMouseLeave={() => setHoveredIdx(null)}
                className="cursor-crosshair"
              >
                <rect
                  x={xCenter - slotW / 2}
                  y={priceTopY}
                  width={slotW}
                  height={xAxisY - priceTopY}
                  fill="transparent"
                />

                {isHovered && (
                  <line
                    x1={xCenter}
                    y1={priceTopY}
                    x2={xCenter}
                    y2={xAxisY}
                    stroke="#334155"
                    strokeWidth="1"
                    strokeDasharray="3 3"
                  />
                )}

                <line
                  x1={xCenter}
                  y1={yHigh}
                  x2={xCenter}
                  y2={yLow}
                  stroke={wickColor}
                  strokeWidth="1"
                />
                <rect
                  x={xCenter - candleW / 2}
                  y={bodyTop}
                  width={candleW}
                  height={bodyH}
                  fill={bodyColor}
                />

                {showXTick && (
                  <g>
                    <line
                      x1={xCenter}
                      y1={xAxisY}
                      x2={xCenter}
                      y2={xAxisY + 4}
                      stroke="#475569"
                      strokeWidth="1"
                    />
                    <text
                      x={xCenter}
                      y={xAxisY + 17}
                      textAnchor="middle"
                      fontSize="11"
                      fill="#94a3b8"
                      className="font-sans tabular-nums"
                    >
                      {formatM5AxisDate(bar.timestampIso)}
                    </text>
                  </g>
                )}
              </g>
            );
          })}

          {/* Current Price Line + Right-Axis Countdown Badge */}
          {latestFormingBar && (
            <>
              <line
                x1={plotLeft}
                y1={latestCloseY}
                x2={plotRight}
                y2={latestCloseY}
                stroke={tickFlash === 'up' ? '#38bdf8' : '#b91c1c'}
                strokeWidth="1"
                opacity={0.9}
              />
              {!isWebMode && (
                <g
                  transform={`translate(${plotRight + 2}, ${Math.min(
                    Math.max(latestCloseY - 12, priceTopY + 4),
                    priceH - 36
                  )})`}
                >
                  <rect
                    x={0}
                    y={0}
                    width={padR - 6}
                    height={31}
                    rx={3}
                    fill={
                      tickFlash === 'up'
                        ? '#1d4ed8'
                        : tickFlash === 'down'
                        ? '#b91c1c'
                        : '#334155'
                    }
                  />
                  <text
                    x={6}
                    y={13}
                    fontSize="11.5"
                    fontWeight="600"
                    fill="#ffffff"
                    className="font-mono tabular-nums"
                  >
                    {latestFormingBar.close.toFixed(spec.digits)}
                  </text>
                  <text
                    x={6}
                    y={26}
                    fontSize="10.5"
                    fill="#e2e8f0"
                    className="font-mono tabular-nums"
                  >
                    {barCountdown}
                  </text>
                </g>
              )}
            </>
          )}

          {/* Bottom X-axis line */}
          <line
            x1={plotLeft}
            y1={xAxisY}
            x2={plotRight}
            y2={xAxisY}
            stroke="#1e293b"
            strokeWidth="1"
          />
        </svg>
      </div>
    </div>
  );
};
