import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDownRight,
  ArrowUpRight,
  Bell,
  ChevronRight,
  Minus,
  Radio,
  RefreshCw,
} from 'lucide-react';
import { SYMBOL_SPECS, type TradingSymbol } from '../lib/aoSimulator';
import { type LastCisdSignalInfo } from '../lib/cisdDetector';
import { generateInitialCisdSeries } from '../lib/m15CisdSimulator';
import { type StochSide } from '../lib/stochDetector';
import { generateInitialStochM1Series } from '../lib/stochM1Simulator';
import cstLogoImg from '../assets/images/cst_brand_logo_1795675963467.jpg';

export type StatusChartTimeframe = 'M15' | 'M1';

export interface TimeframeStatusItem {
  timeframe: StatusChartTimeframe;
  strategy: 'CISD' | 'STOCH';
  ok: boolean;
  status: 'UP' | 'DOWN' | 'NEUTRAL';
  cisdSignal?: 'BUY' | 'SELL' | null;
  lastSignalInfo?: LastCisdSignalInfo | null;
  stochK?: number | null;
  stochSide?: StochSide | null;
  currentPrice: number;
  latestBearCisdLevel?: number | null;
  latestBullCisdLevel?: number | null;
  marketState: string;
  fetchedAt: string;
  error?: string;
}

interface MultiTimeframeStatusWindowProps {
  selectedTimeframe: StatusChartTimeframe;
  onSelectTimeframeForChart: (tf: StatusChartTimeframe) => void;
  isWebMode?: boolean;
}

export const MultiTimeframeStatusWindow: React.FC<
  MultiTimeframeStatusWindowProps
> = ({ onSelectTimeframeForChart, isWebMode = false }) => {
  const symbol: TradingSymbol = 'US100';
  const spec = SYMBOL_SPECS[symbol];

  const [mode, setMode] = useState<'live' | 'sim'>('live');
  const [items, setItems] = useState<TimeframeStatusItem[]>([]);
  const [t01State, setT01State] = useState<{
    activeBias: 'BUY' | 'SELL' | null;
    biasCisdLevel: number | null;
    waitingReset: boolean;
    roundCount: number;
  } | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  const buildSimStatuses = useCallback((): TimeframeStatusItem[] => {
    const nowIso = new Date().toISOString();

    // 1) M15 CISD
    const m15Series = generateInitialCisdSeries(symbol, 'M15', 96);
    const m15Latest = m15Series.bars[m15Series.bars.length - 1];
    const m15Closed = m15Series.bars[m15Series.bars.length - 2];
    const m15Trend =
      m15Series.currentTrend ??
      (m15Latest && m15Latest.close > m15Latest.open
        ? 'BUY'
        : m15Latest && m15Latest.close < m15Latest.open
        ? 'SELL'
        : null);

    const m15Item: TimeframeStatusItem = {
      timeframe: 'M15',
      strategy: 'CISD',
      ok: true,
      status: m15Trend === 'BUY' ? 'UP' : m15Trend === 'SELL' ? 'DOWN' : 'NEUTRAL',
      cisdSignal: m15Series.currentTrend,
      lastSignalInfo: m15Series.lastSignalInfo,
      currentPrice: m15Latest?.close ?? m15Closed?.close ?? spec.basePrice,
      latestBearCisdLevel: m15Series.latestBearCisdLevel,
      latestBullCisdLevel: m15Series.latestBullCisdLevel,
      marketState: 'SIM',
      fetchedAt: nowIso,
    };

    // 2) M1 Stoch(15,3,3)
    const m1Series = generateInitialStochM1Series(symbol, 110);
    const m1Latest = m1Series.bars[m1Series.bars.length - 1];
    const m1Closed = m1Series.bars[m1Series.bars.length - 2];
    const m1Side = m1Series.currentSide;
    const m1Item: TimeframeStatusItem = {
      timeframe: 'M1',
      strategy: 'STOCH',
      ok: true,
      status:
        m1Side === 'UNDER_20' ? 'UP' : m1Side === 'OVER_80' ? 'DOWN' : 'NEUTRAL',
      stochK: m1Series.latestStochK,
      stochSide: m1Side,
      currentPrice: m1Latest?.close ?? m1Closed?.close ?? spec.basePrice,
      marketState: 'SIM',
      fetchedAt: nowIso,
    };

    return [m15Item, m1Item];
  }, [spec.basePrice, symbol]);

  const fetchLiveStatuses = useCallback(async () => {
    setIsLoading(true);
    setErrorMsg(null);
    try {
      const [cisdRes, stochRes] = await Promise.all([
        fetch(`/api/market/cisd-status?symbol=${encodeURIComponent(symbol)}`),
        fetch(`/api/market/stoch?symbol=${encodeURIComponent(symbol)}`),
      ]);

      const nextItems: TimeframeStatusItem[] = [];

      if (cisdRes.ok) {
        const cisdData = (await cisdRes.json()) as {
          timeframes: Array<{
            timeframe: string;
            ok: boolean;
            status: 'UP' | 'DOWN' | 'NEUTRAL';
            cisdSignal: 'BUY' | 'SELL' | null;
            lastSignalInfo: LastCisdSignalInfo | null;
            currentPrice: number;
            latestBearCisdLevel: number | null;
            latestBullCisdLevel: number | null;
            marketState: string;
            fetchedAt: string;
          }>;
          fetchedAt: string;
        };
        const m15Raw = cisdData.timeframes.find((t) => t.timeframe === 'M15');
        if (m15Raw) {
          nextItems.push({
            timeframe: 'M15',
            strategy: 'CISD',
            ok: m15Raw.ok,
            status: m15Raw.status,
            cisdSignal: m15Raw.cisdSignal,
            lastSignalInfo: m15Raw.lastSignalInfo,
            currentPrice: m15Raw.currentPrice,
            latestBearCisdLevel: m15Raw.latestBearCisdLevel,
            latestBullCisdLevel: m15Raw.latestBullCisdLevel,
            marketState: m15Raw.marketState,
            fetchedAt: m15Raw.fetchedAt,
          });
        }
      }

      if (stochRes.ok) {
        const stochData = (await stochRes.json()) as {
          bars: Array<{ close: number; stochK: number | null }>;
          currentSide: StochSide | null;
          serverLastSide: StochSide | null;
          latestStochK: number | null;
          marketState: string;
          fetchedAt: string;
          t01State?: {
            activeBias: 'BUY' | 'SELL' | null;
            biasCisdLevel: number | null;
            waitingReset: boolean;
            roundCount: number;
          };
        };
        if (stochData.t01State) {
          setT01State(stochData.t01State);
        }
        const latestBar = stochData.bars[stochData.bars.length - 1];
        const effectiveSide = stochData.serverLastSide ?? stochData.currentSide;
        nextItems.push({
          timeframe: 'M1',
          strategy: 'STOCH',
          ok: true,
          status:
            effectiveSide === 'UNDER_20'
              ? 'UP'
              : effectiveSide === 'OVER_80'
              ? 'DOWN'
              : 'NEUTRAL',
          stochK: stochData.latestStochK,
          stochSide: effectiveSide,
          currentPrice: latestBar?.close ?? 0,
          marketState: stochData.marketState,
          fetchedAt: stochData.fetchedAt,
        });
      }

      if (nextItems.length === 0) {
        throw new Error('ดึงสถานะ M15 / M1 ไม่สำเร็จ');
      }

      setItems(nextItems);
      setLastUpdated(
        new Date().toLocaleTimeString('th-TH', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        })
      );
    } catch (err: any) {
      setErrorMsg(err?.message || 'ไม่สามารถเชื่อมต่อข้อมูลตลาดจริงได้');
    } finally {
      setIsLoading(false);
    }
  }, [symbol]);

  useEffect(() => {
    if (mode === 'sim') {
      setItems(buildSimStatuses());
      setIsLoading(false);
      setErrorMsg(null);
      setLastUpdated(
        new Date().toLocaleTimeString('th-TH', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        })
      );
      return;
    }

    void fetchLiveStatuses();
    const timer = window.setInterval(() => {
      void fetchLiveStatuses();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [mode, fetchLiveStatuses, buildSimStatuses]);

  const summary = useMemo(() => {
    let upCount = 0;
    let downCount = 0;
    for (const item of items) {
      if (item.status === 'UP') upCount += 1;
      else if (item.status === 'DOWN') downCount += 1;
    }

    let overallLabel = 'กำลังโหลดข้อมูล';
    let overallTone: 'up' | 'down' | 'mixed' = 'mixed';
    if (mode === 'live' && t01State?.activeBias) {
      if (t01State.activeBias === 'BUY') {
        overallTone = 'up';
        overallLabel = t01State.waitingReset
          ? `ท่า T01 ขาขึ้น: เตือนรอบ ${t01State.roundCount} แล้ว · รอ M1 > 80 รีเซ็ต`
          : `ท่า T01 ขาขึ้น (Step 1 M15 พร้อม) · รอ M1 ปิด < 20${
              t01State.roundCount > 0 ? ` (รอบ ${t01State.roundCount + 1})` : ''
            }`;
      } else {
        overallTone = 'down';
        overallLabel = t01State.waitingReset
          ? `ท่า T01 ขาลง: เตือนรอบ ${t01State.roundCount} แล้ว · รอ M1 < 20 รีเซ็ต`
          : `ท่า T01 ขาลง (Step 1 M15 พร้อม) · รอ M1 ปิด > 80${
              t01State.roundCount > 0 ? ` (รอบ ${t01State.roundCount + 1})` : ''
            }`;
      }
    } else if (items.length > 0) {
      if (upCount === items.length) {
        overallLabel = 'M15 CISD & M1 Stoch สอดคล้องฝั่งขึ้น';
        overallTone = 'up';
      } else if (downCount === items.length) {
        overallLabel = 'M15 CISD & M1 Stoch สอดคล้องฝั่งลง';
        overallTone = 'down';
      } else if (upCount > 0 && downCount > 0) {
        overallLabel = 'M15 CISD และ M1 Stoch คนละฝั่ง';
        overallTone = 'mixed';
      } else if (upCount > 0) {
        overallLabel = 'มีสัญญาณฝั่งขึ้น';
        overallTone = 'up';
      } else if (downCount > 0) {
        overallLabel = 'มีสัญญาณฝั่งลง';
        overallTone = 'down';
      } else {
        overallLabel = 'รอสัญญาณปิดแท่งใหม่';
        overallTone = 'mixed';
      }
    }

    return { upCount, downCount, overallLabel, overallTone };
  }, [items, mode, t01State]);

  const handleRefresh = () => {
    if (mode === 'live') {
      void fetchLiveStatuses();
    } else {
      setItems(buildSimStatuses());
      setLastUpdated(
        new Date().toLocaleTimeString('th-TH', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        })
      );
    }
  };

  return (
    <section className="space-y-5">
      {errorMsg && mode === 'live' && (
        <div className="rounded-xl border border-rose-200/70 dark:border-rose-500/30 bg-rose-50/60 dark:bg-rose-950/45 px-4 py-3.5 text-sm text-rose-800 dark:text-rose-200">
          {errorMsg}
        </div>
      )}

      {!isWebMode && (
        <div className="rounded-2xl border border-slate-200/90 dark:border-slate-800/90 bg-white dark:bg-[#0e1525] px-5 py-4 text-slate-900 dark:text-slate-100 shadow-xs sm:px-6 sm:py-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3.5">
              <img
                src={cstLogoImg}
                alt="โลโก้ CST"
                referrerPolicy="no-referrer"
                className="h-11 w-11 shrink-0 rounded-xl bg-white object-cover ring-1 ring-slate-200 dark:ring-slate-700"
              />
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-base font-semibold tracking-tight text-slate-900 dark:text-slate-100 sm:text-lg">
                    CST · สรุปสถานะ M15 CISD &amp; M1 Stoch(15,3,3)
                  </h2>
                  <span className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-2.5 py-0.5 text-xs font-medium text-slate-700 dark:text-slate-300">
                    US100Cash#
                  </span>
                </div>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                  ติดตามทั้งโครงสร้าง CISD M15 และ Stoch(15,3,3) M1 แบบปิดแท่งครั้งเดียวต่อฝั่ง
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-400 sm:text-sm">
              {lastUpdated && (
                <span className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-3 py-1.5 font-mono tabular-nums">
                  อัปเดต {lastUpdated}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-slate-200/80 dark:border-slate-800/90 bg-[#f9fafc] dark:bg-[#0b1120]">
        {/* Top Controls Row */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200/70 dark:border-slate-800 bg-slate-100/60 dark:bg-slate-900/70 px-5 py-4 sm:px-6">
          <div className="flex items-center gap-1.5 rounded-xl bg-slate-200/65 dark:bg-slate-950/80 p-1">
            <button
              type="button"
              onClick={() => setMode('live')}
              className={`inline-flex h-10 items-center gap-2 rounded-lg px-4 text-sm font-medium whitespace-nowrap shrink-0 transition-colors ${
                mode === 'live'
                  ? 'bg-[#fcfdfe] dark:bg-slate-800 text-slate-800 dark:text-slate-100 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-100'
              }`}
            >
              <Radio className="h-4 w-4 text-emerald-600/90 dark:text-emerald-400" />
              กราฟจริง
            </button>
            <button
              type="button"
              onClick={() => setMode('sim')}
              className={`h-10 rounded-lg px-4 text-sm font-medium whitespace-nowrap shrink-0 transition-colors ${
                mode === 'sim'
                  ? 'bg-[#fcfdfe] dark:bg-slate-800 text-slate-800 dark:text-slate-100 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-100'
              }`}
            >
              จำลอง
            </button>
          </div>

          <button
            type="button"
            onClick={handleRefresh}
            disabled={isLoading}
            className="inline-flex h-10 items-center gap-2 rounded-xl border border-slate-200/80 dark:border-slate-700 bg-[#fcfdfe] dark:bg-slate-900 px-4 text-sm font-medium text-slate-700 dark:text-slate-200 whitespace-nowrap shrink-0 transition-colors hover:bg-slate-100/80 dark:hover:bg-slate-800 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 text-slate-500 dark:text-slate-400 ${isLoading ? 'animate-spin' : ''}`} />
            รีเฟรชข้อมูล
          </button>
        </div>

        {/* Overall Summary Strip */}
        <div className="flex flex-col gap-3 border-b border-slate-200/70 dark:border-slate-800 bg-[#fcfdfe] dark:bg-[#0e1525] px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="flex items-center gap-3.5">
            <span
              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${
                summary.overallTone === 'up'
                  ? 'bg-emerald-100/65 dark:bg-emerald-950/60 text-emerald-700/90 dark:text-emerald-400'
                  : summary.overallTone === 'down'
                  ? 'bg-rose-100/65 dark:bg-rose-950/60 text-rose-700/90 dark:text-rose-400'
                  : 'bg-slate-200/65 dark:bg-slate-800 text-slate-600 dark:text-slate-400'
              }`}
            >
              {summary.overallTone === 'up' ? (
                <ArrowUpRight className="h-5 w-5" />
              ) : summary.overallTone === 'down' ? (
                <ArrowDownRight className="h-5 w-5" />
              ) : (
                <Minus className="h-5 w-5" />
              )}
            </span>
            <div>
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400 sm:text-sm">
                ภาพรวมระบบ (M15 CISD · M1 Stoch)
              </p>
              <p
                className={`mt-0.5 text-base font-semibold sm:text-lg ${
                  summary.overallTone === 'up'
                    ? 'text-emerald-800/90 dark:text-emerald-300'
                    : summary.overallTone === 'down'
                    ? 'text-rose-800/90 dark:text-rose-300'
                    : 'text-slate-700 dark:text-slate-200'
                }`}
              >
                {summary.overallLabel}
              </p>
            </div>
          </div>

          <div className="inline-flex items-center gap-3.5 self-start rounded-xl border border-slate-200/70 dark:border-slate-800 bg-slate-100/60 dark:bg-slate-900/80 px-4 py-2 text-sm font-semibold tabular-nums whitespace-nowrap sm:self-auto">
            <span className="text-emerald-700/90 dark:text-emerald-400">ฝั่งขึ้น {summary.upCount}</span>
            <span aria-hidden="true" className="text-slate-300 dark:text-slate-700">
              |
            </span>
            <span className="text-rose-700/90 dark:text-rose-400">ฝั่งลง {summary.downCount}</span>
          </div>
        </div>

        {/* 2 Cards: M15 CISD & M1 Stoch(15,3,3) */}
        <div className="grid grid-cols-1 gap-4 p-4 sm:p-6 md:grid-cols-2">
          {(['M15', 'M1'] as const).map((tf) => {
            const item = items.find((i) => i.timeframe === tf);
            const isM15 = tf === 'M15';
            const isUp = item?.status === 'UP';
            const isDown = item?.status === 'DOWN';

            const activeCisdWatch = isM15
              ? isUp
                ? item?.latestBearCisdLevel
                : isDown
                ? item?.latestBullCisdLevel
                : item?.latestBullCisdLevel ?? item?.latestBearCisdLevel
              : null;

            const activeWatchLabel = isUp
              ? 'แนว CISD กลับตัวลง'
              : isDown
              ? 'แนว CISD กลับตัวขึ้น'
              : 'ระดับ CISD เฝ้าดู';

            return (
              <button
                key={`status-card-${tf}`}
                type="button"
                onClick={() => onSelectTimeframeForChart(tf)}
                className={`group flex flex-col justify-between rounded-2xl border p-5 sm:p-6 text-left transition-colors focus-visible:outline-2 focus-visible:outline-blue-600 ${
                  isUp
                    ? 'border-emerald-200/75 dark:border-emerald-500/30 bg-emerald-50/45 dark:bg-emerald-950/25 hover:bg-emerald-50/75 dark:hover:bg-emerald-950/40'
                    : isDown
                    ? 'border-rose-200/75 dark:border-rose-500/30 bg-rose-50/45 dark:bg-rose-950/25 hover:bg-rose-50/75 dark:hover:bg-rose-950/40'
                    : 'border-slate-200/80 dark:border-slate-800 bg-[#fcfdfe] dark:bg-[#0e1525] hover:bg-slate-100/70 dark:hover:bg-slate-800/60'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2.5">
                      <span className="font-mono text-xl font-bold tracking-tight text-slate-800 dark:text-slate-100 sm:text-2xl">
                        {tf}
                      </span>
                      <span className="rounded-lg bg-slate-200/60 dark:bg-slate-800 px-2.5 py-0.5 text-xs font-medium text-slate-600 dark:text-slate-300 sm:text-sm">
                        {isM15 ? 'CISD (15 นาที)' : 'Stoch(15,3,3) (1 นาที)'}
                      </span>
                    </div>

                    <div className="mt-2 inline-flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-400">
                      <Bell className="h-4 w-4 text-amber-600/90 dark:text-amber-400" />
                      <span>
                        {isM15
                          ? 'Step 1: กำหนดทิศทาง BUY/SELL ให้ M1'
                          : mode === 'live' && t01State?.activeBias === 'BUY'
                          ? t01State.waitingReset
                            ? `เตือนรอบ ${t01State.roundCount} แล้ว · รอ M1 > 80`
                            : `Step 2: รอ M1 ปิด < 20 (ตาม M15 ขาขึ้น)`
                          : mode === 'live' && t01State?.activeBias === 'SELL'
                          ? t01State.waitingReset
                            ? `เตือนรอบ ${t01State.roundCount} แล้ว · รอ M1 < 20`
                            : `Step 2: รอ M1 ปิด > 80 (ตาม M15 ขาลง)`
                          : 'Step 2: รอจังหวะปิด < 20 / > 80 ตาม M15'}
                      </span>
                    </div>
                  </div>

                  {isLoading && !item ? (
                    <span className="h-12 w-12 shrink-0 animate-pulse rounded-2xl bg-slate-200/70 dark:bg-slate-800" />
                  ) : isUp ? (
                    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-emerald-100/75 dark:bg-emerald-950/70 text-emerald-700/90 dark:text-emerald-400 transition-transform group-hover:scale-105">
                      <ArrowUpRight className="h-6 w-6" />
                    </span>
                  ) : isDown ? (
                    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-rose-100/75 dark:bg-rose-950/70 text-rose-700/90 dark:text-rose-400 transition-transform group-hover:scale-105">
                      <ArrowDownRight className="h-6 w-6" />
                    </span>
                  ) : (
                    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-slate-200/70 dark:bg-slate-800 text-slate-500 dark:text-slate-400">
                      <Minus className="h-6 w-6" />
                    </span>
                  )}
                </div>

                <div className="my-5 flex flex-wrap items-baseline justify-between gap-3 rounded-xl border border-slate-200/60 dark:border-slate-800 bg-white/75 dark:bg-[#080d1a]/90 px-4 py-3.5">
                  <div>
                    <p className="text-xs font-medium text-slate-500 dark:text-slate-400 sm:text-sm">
                      {isM15 ? 'ทิศทาง CISD ล่าสุด' : 'สถานะฝั่ง Stoch ล่าสุด'}
                    </p>
                    <p
                      className={`mt-0.5 text-lg font-bold tracking-tight sm:text-xl ${
                        isLoading && !item
                          ? 'text-slate-400 dark:text-slate-500'
                          : isUp
                          ? 'text-emerald-700/95 dark:text-emerald-400'
                          : isDown
                          ? 'text-rose-700/95 dark:text-rose-400'
                          : 'text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      {isLoading && !item
                        ? 'กำลังโหลด...'
                        : isM15
                        ? isUp
                          ? isWebMode
                            ? 'ขาขึ้น'
                            : 'ขาขึ้น (BUY)'
                          : isDown
                          ? isWebMode
                            ? 'ขาลง'
                            : 'ขาลง (SELL)'
                          : 'รอสัญญาณ'
                        : item?.stochSide === 'OVER_80'
                        ? 'ปิด > 80 (รอ < 20)'
                        : item?.stochSide === 'UNDER_20'
                        ? 'ปิด < 20 (รอ > 80)'
                        : 'รอปิด > 80 / < 20'}
                    </p>
                  </div>

                  <div className="text-right">
                    <p className="text-xs font-medium text-slate-500 dark:text-slate-400 sm:text-sm">
                      {isM15 ? 'ราคาปัจจุบัน' : 'Stoch(15,3,3)'}
                    </p>
                    <p className="mt-0.5 font-mono text-base font-semibold text-slate-800 dark:text-slate-100 tabular-nums sm:text-lg">
                      {isM15
                        ? item && item.currentPrice > 0
                          ? item.currentPrice.toFixed(spec.digits)
                          : '—'
                        : item && item.stochK !== null && item.stochK !== undefined
                        ? item.stochK.toFixed(2)
                        : '—'}
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-sm text-slate-600 dark:text-slate-400">
                  <span className="font-medium">
                    {isM15 ? (
                      activeCisdWatch !== null && activeCisdWatch !== undefined ? (
                        <>
                          {activeWatchLabel}:{' '}
                          <span className="font-mono font-semibold text-slate-700 dark:text-slate-200 tabular-nums">
                            {activeCisdWatch.toFixed(spec.digits)}
                          </span>
                        </>
                      ) : (
                        'รอสร้างแนวโครงสร้าง CISD ใหม่'
                      )
                    ) : (
                      <>
                        ราคา:{' '}
                        <span className="font-mono font-semibold text-slate-700 dark:text-slate-200 tabular-nums">
                          {item && item.currentPrice > 0
                            ? item.currentPrice.toFixed(spec.digits)
                            : '—'}
                        </span>
                      </>
                    )}
                  </span>

                  <span className="inline-flex items-center gap-1 font-medium text-slate-700 dark:text-slate-300 group-hover:text-slate-900 dark:group-hover:text-white">
                    เปิดกราฟ {tf}
                    <ChevronRight className="h-4 w-4 text-slate-400 transition-transform group-hover:translate-x-0.5" />
                  </span>
                </div>
              </button>
            );
          })}
        </div>

        <div className="border-t border-slate-200/70 dark:border-slate-800 bg-slate-100/50 dark:bg-slate-900/60 px-5 py-3.5 text-center text-sm text-slate-600 dark:text-slate-400 sm:px-6 sm:text-left">
          แตะที่การ์ด <span className="font-semibold text-slate-700 dark:text-slate-200">M15</span> หรือ{' '}
          <span className="font-semibold text-slate-700 dark:text-slate-200">M1</span> เพื่อเปิดดูกราฟแบบละเอียดได้ทันที
        </div>
      </div>
    </section>
  );
};
