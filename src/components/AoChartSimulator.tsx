import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Play,
  Pause,
  SkipForward,
  RotateCcw,
  ArrowUpRight,
  ArrowDownRight,
  Smartphone,
  Bell,
  Volume2,
  VolumeX,
  Square,
  RefreshCw,
  Radio,
  Send,
} from 'lucide-react';
import {
  M5Bar,
  SYMBOL_SPECS,
  TradingSymbol,
  appendNextM5Bar,
  generateInitialSeries,
} from '../lib/aoSimulator';
import type { SignalLogRecord } from '../lib/sheetsApi';
import type { AlertDirection } from '../lib/mql5Generator';
import { play10SecondSound, stop10SecondSound } from '../lib/audioAlert';
import {
  getExistingPushSubscription,
  isWebPushSupported,
  sendTestWebPush,
  subscribeDeviceToWebPush,
  unsubscribeDeviceFromWebPush,
} from '../lib/webPushClient';

interface AoChartSimulatorProps {
  alertDirection: AlertDirection;
  lockM5: boolean;
  customPrefix: string;
  onSignalDetected: (record: SignalLogRecord) => void;
  recentSignals: SignalLogRecord[];
  onGoToSheets: () => void;
  onGoToTelegram: () => void;
  telegramSyncedReady?: boolean | null;
  isWebMode?: boolean;
}

const SYMBOLS: TradingSymbol[] = ['US100'];

interface LiveFeedResponse {
  symbol: TradingSymbol;
  source: string;
  marketState: string;
  fetchedAt: string;
  bars: M5Bar[];
}

function formatMt5AxisDate(timestampIso: string): string {
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

function formatBarCountdown(): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const remaining = 300 - (nowSec % 300);
  const mm = String(Math.floor(remaining / 60)).padStart(2, '0');
  const ss = String(remaining % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

export const AoChartSimulator: React.FC<AoChartSimulatorProps> = ({
  alertDirection,
  lockM5,
  customPrefix,
  onSignalDetected,
  recentSignals,
  onGoToSheets,
  onGoToTelegram,
  telegramSyncedReady,
  isWebMode = false,
}) => {
  const [feedMode, setFeedMode] = useState<'live' | 'sim'>('live');
  const symbol: TradingSymbol = 'US100';
  const [bars, setBars] = useState<M5Bar[]>(() => generateInitialSeries('US100'));
  const [marketState, setMarketState] = useState<string>('');
  const [feedSource, setFeedSource] = useState<string>('');
  const [isLoadingLive, setIsLoadingLive] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [barCountdown, setBarCountdown] = useState<string>(() => formatBarCountdown());

  const [isPlaying, setIsPlaying] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [soundSecondsLeft, setSoundSecondsLeft] = useState(0);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [lastPushBanner, setLastPushBanner] = useState<{
    symbol: string;
    signal: 'BUY' | 'SELL';
    aoPrev: number;
    aoCurr: number;
    price: number;
    time: string;
    digits: number;
  } | null>(null);

  // Background Server Monitor + Zero-Install Web Push State
  const [monitorEnabled, setMonitorEnabled] = useState(true);
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [pushEndpoint, setPushEndpoint] = useState<string | undefined>(undefined);
  const [pushSupported] = useState(() => isWebPushSupported());
  const [ntfyTopic, setNtfyTopic] = useState('');
  const [telegramConfigured, setTelegramConfigured] = useState(false);
  const [monitorBusy, setMonitorBusy] = useState(false);
  const [monitorNote, setMonitorNote] = useState<string | null>(null);

  const countdownRef = useRef<number | null>(null);
  const alertedLiveBarsRef = useRef<Set<string>>(new Set());
  const barsRef = useRef<M5Bar[]>(bars);
  barsRef.current = bars;
  const spec = SYMBOL_SPECS[symbol];

  useEffect(() => {
    const id = window.setInterval(() => {
      setBarCountdown(formatBarCountdown());
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  const stopAudioAndTimer = () => {
    stop10SecondSound();
    if (countdownRef.current !== null) {
      window.clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
    setSoundSecondsLeft(0);
  };

  useEffect(() => {
    return () => {
      stopAudioAndTimer();
    };
  }, []);

  const trigger10sSound = useCallback(
    (signal: 'BUY' | 'SELL') => {
      if (!soundEnabled) return;
      stopAudioAndTimer();
      setSoundSecondsLeft(10);
      countdownRef.current = window.setInterval(() => {
        setSoundSecondsLeft((prev) => {
          if (prev <= 1) {
            if (countdownRef.current !== null) {
              window.clearInterval(countdownRef.current);
              countdownRef.current = null;
            }
            return 0;
          }
          return prev - 1;
        });
      }, 1000);

      play10SecondSound(signal === 'BUY' ? 'buy' : 'sell', () => {
        if (countdownRef.current !== null) {
          window.clearInterval(countdownRef.current);
          countdownRef.current = null;
        }
        setSoundSecondsLeft(0);
      });
    },
    [soundEnabled]
  );

  const emitAlert = useCallback(
    (
      sym: TradingSymbol,
      signal: 'BUY' | 'SELL',
      aoPrev: number,
      aoCurr: number,
      price: number,
      timeLabel: string,
      timestampIso: string,
      sourceTag: string,
      mode: 'live' | 'sim'
    ) => {
      const symSpec = SYMBOL_SPECS[sym];
      const timeframe = lockM5 ? 'M5' : 'Current';
      const timeStr = new Date(timestampIso).toLocaleString('th-TH', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });

      setLastPushBanner({
        symbol: sym,
        signal,
        aoPrev,
        aoCurr,
        price,
        time: timeLabel,
        digits: symSpec.digits,
      });

      trigger10sSound(signal);

      if (
        typeof Notification !== 'undefined' &&
        Notification.permission === 'granted'
      ) {
        try {
          const aoDigits = symSpec.digits + 1;
          new Notification(`${customPrefix} | ${sym} ${timeframe} ${signal}`, {
            body: `AO: ${aoPrev.toFixed(aoDigits)} → ${aoCurr.toFixed(aoDigits)} · ราคา ${price.toFixed(
              symSpec.digits
            )}`,
          });
        } catch {
          // Ignore browser notification failure
        }
      }

      void fetch('/api/monitor/notify-signal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: sym,
          timeframe,
          signal,
          aoPrev,
          aoCurr,
          price,
          mode,
          timestampIso,
          prefix: customPrefix,
        }),
      })
        .then(async (r) => {
          const resData = await r.json().catch(() => null);
          if (!r.ok) {
            setMonitorNote(resData?.error || 'ส่งสัญญาณเข้า Telegram ไม่สำเร็จ');
            return;
          }
          if (resData?.skipped && resData?.reason === 'not_configured') {
            setTelegramConfigured(false);
            setMonitorNote(
              'ยังไม่ได้เชื่อมต่อ Telegram (กรุณากรอก Bot Token ในแท็บ Telegram)'
            );
            return;
          }
          if (resData?.ok && !resData?.deduplicated) {
            setTelegramConfigured(true);
            setMonitorNote(`ส่งสัญญาณ ${sym} ${signal} เข้า Telegram แล้ว`);
          }
        })
        .catch(() => {
          setMonitorNote('เชื่อมต่อเซิร์ฟเวอร์สำหรับส่ง Telegram ไม่สำเร็จ');
        });

      onSignalDetected({
        id: `${sym}-${timestampIso}-${Math.random().toString(36).slice(2, 7)}`,
        timestamp: timeStr,
        symbol: sym,
        timeframe,
        signal,
        aoPrev,
        aoCurr,
        price,
        pushStatus: sourceTag,
        note: signal === 'BUY' ? 'AO ตัด 0 ขึ้น' : 'AO ตัด 0 ลง',
        syncedToSheet: false,
      });
    },
    [customPrefix, lockM5, onSignalDetected, trigger10sSound]
  );

  // Load current server background monitor config + device Web Push subscription on mount
  useEffect(() => {
    fetch('/api/monitor/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        setMonitorEnabled(Boolean(data.enabled));
        if (typeof data.ntfyTopic === 'string') {
          setNtfyTopic(data.ntfyTopic);
        }
        setTelegramConfigured(Boolean(data.telegramConfigured));
      })
      .catch(() => {});

    getExistingPushSubscription()
      .then((sub) => {
        if (sub) {
          setPushSubscribed(true);
          setPushEndpoint(sub.endpoint);
          void fetch('/api/push/subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subscription: sub.toJSON() }),
          }).catch(() => {});
        }
      })
      .catch(() => {});
  }, []);

  const fetchLiveBars = useCallback(
    async (targetSymbol: TradingSymbol) => {
      setIsLoadingLive(true);
      setLiveError(null);
      try {
        const res = await fetch(
          `/api/market/m5?symbol=${encodeURIComponent(targetSymbol)}`
        );
        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          throw new Error(errBody.error || 'ดึงข้อมูลกราฟจริงไม่สำเร็จ');
        }
        const data = (await res.json()) as LiveFeedResponse;
        setBars(data.bars);
        setMarketState(data.marketState);
        setFeedSource(data.source);

        // Trigger alert immediately when current forming M5 candle crosses 0 (no need to wait for close)
        const candidates: Array<{ targetBar: M5Bar; prevBar: M5Bar }> = [
          {
            targetBar: data.bars[data.bars.length - 1],
            prevBar: data.bars[data.bars.length - 2],
          },
          {
            targetBar: data.bars[data.bars.length - 2],
            prevBar: data.bars[data.bars.length - 3],
          },
        ];

        for (const { targetBar, prevBar } of candidates) {
          if (!targetBar || !prevBar || !targetBar.signal) continue;
          const barAgeMinutes =
            (Date.now() - new Date(targetBar.timestampIso).getTime()) / 60000;
          const key = `${targetSymbol}-${targetBar.timestampIso}-${targetBar.signal}`;
          const shouldNotify =
            barAgeMinutes <= 20 &&
            (alertDirection === 'both' ||
              (alertDirection === 'buy_only' && targetBar.signal === 'BUY') ||
              (alertDirection === 'sell_only' && targetBar.signal === 'SELL'));

          if (shouldNotify && !alertedLiveBarsRef.current.has(key)) {
            alertedLiveBarsRef.current.add(key);
            emitAlert(
              targetSymbol,
              targetBar.signal,
              prevBar.ao,
              targetBar.ao,
              targetBar.close,
              targetBar.timeLabel,
              targetBar.timestampIso,
              'Live M5 Alert',
              'live'
            );
          }
        }
      } catch (err: any) {
        setLiveError(err?.message || 'เชื่อมต่อฟีดกราฟจริงไม่สำเร็จ');
      } finally {
        setIsLoadingLive(false);
      }
    },
    [alertDirection, emitAlert]
  );

  // Poll live market every 8s when in Live mode
  useEffect(() => {
    if (feedMode !== 'live') return;
    void fetchLiveBars(symbol);
    const id = window.setInterval(() => {
      void fetchLiveBars(symbol);
    }, 8000);
    return () => window.clearInterval(id);
  }, [feedMode, symbol, fetchLiveBars]);

  const handleChangeFeedMode = (nextMode: 'live' | 'sim') => {
    setIsPlaying(false);
    setFeedMode(nextMode);
    setHoveredIdx(null);
    setLiveError(null);
    if (nextMode === 'sim') {
      setBars(generateInitialSeries(symbol));
      setMarketState('');
      setFeedSource('');
    }
  };

  const advanceBar = (forceCross?: 'BUY' | 'SELL') => {
    const nextBars = appendNextM5Bar(barsRef.current, symbol, forceCross);
    barsRef.current = nextBars;
    setBars(nextBars);

    const latestClosed = nextBars[nextBars.length - 1];
    const previousClosed = nextBars[nextBars.length - 2];

    if (latestClosed && previousClosed && latestClosed.signal) {
      const shouldNotify =
        alertDirection === 'both' ||
        (alertDirection === 'buy_only' && latestClosed.signal === 'BUY') ||
        (alertDirection === 'sell_only' && latestClosed.signal === 'SELL');

      if (shouldNotify) {
        emitAlert(
          symbol,
          latestClosed.signal,
          previousClosed.ao,
          latestClosed.ao,
          latestClosed.close,
          latestClosed.timeLabel,
          latestClosed.timestampIso,
          'Sim Push Sent (10s)',
          'sim'
        );
      }
    }
  };

  useEffect(() => {
    if (feedMode !== 'sim' || !isPlaying) return;
    const timer = window.setInterval(() => {
      advanceBar();
    }, 1100);
    return () => window.clearInterval(timer);
  });

  const handleEnableWebPush = async () => {
    setMonitorBusy(true);
    setMonitorNote(null);
    try {
      const sub = await subscribeDeviceToWebPush();
      setPushSubscribed(true);
      setPushEndpoint(sub.endpoint);
      setMonitorNote('เชื่อมต่อมือถือเครื่องนี้แล้ว ปิดหน้าจอได้ทันที');
    } catch (err: any) {
      setMonitorNote(err?.message || 'เปิดรับแจ้งเตือนไม่สำเร็จ');
    } finally {
      setMonitorBusy(false);
    }
  };

  const handleDisableWebPush = async () => {
    setMonitorBusy(true);
    setMonitorNote(null);
    try {
      await unsubscribeDeviceFromWebPush();
      setPushSubscribed(false);
      setPushEndpoint(undefined);
      setMonitorNote('ยกเลิกการรับแจ้งเตือนบนเครื่องนี้แล้ว');
    } finally {
      setMonitorBusy(false);
    }
  };

  const handleTestWebPush = async () => {
    setMonitorBusy(true);
    setMonitorNote(null);
    try {
      await sendTestWebPush(pushEndpoint);
      setMonitorNote('ส่งแจ้งเตือนทดสอบเข้าเครื่องนี้แล้ว');
    } catch (err: any) {
      setMonitorNote(err?.message || 'ส่งทดสอบไม่สำเร็จ');
    } finally {
      setMonitorBusy(false);
    }
  };

  const handleToggleServerMonitor = async () => {
    setMonitorBusy(true);
    setMonitorNote(null);
    try {
      const nextEnabled = !monitorEnabled;
      const res = await fetch('/api/monitor/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: nextEnabled,
          symbols: SYMBOLS,
          ntfyTopic,
          direction: alertDirection,
        }),
      });
      if (!res.ok) throw new Error('บันทึกไม่สำเร็จ');
      const data = await res.json();
      setMonitorEnabled(Boolean(data.enabled));
      setMonitorNote(
        data.enabled
          ? 'เซิร์ฟเวอร์เฝ้ากราฟ US100 M5 อัตโนมัติแล้ว'
          : 'หยุดพักการเฝ้ากราฟบนเซิร์ฟเวอร์'
      );
    } catch {
      setMonitorNote('ตั้งค่าเฝ้ากราฟไม่สำเร็จ');
    } finally {
      setMonitorBusy(false);
    }
  };

  const handleTestNtfy = async () => {
    setMonitorBusy(true);
    setMonitorNote(null);
    try {
      await fetch('/api/monitor/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: monitorEnabled,
          symbols: SYMBOLS,
          ntfyTopic,
          direction: alertDirection,
        }),
      });
      const res = await fetch('/api/monitor/test-push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ntfyTopic }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'ส่งทดสอบไม่สำเร็จ');
      setMonitorNote('ส่งสัญญาณทดสอบเข้าแอป ntfy บนมือถือแล้ว');
    } catch (err: any) {
      setMonitorNote(err?.message || 'ส่งทดสอบไม่สำเร็จ');
    } finally {
      setMonitorBusy(false);
    }
  };

  const aoDigits = spec.digits + 1;

  // Match MT5 mobile chart density & right-side shift spacing (~72 candles + ~28% right breathing gap)
  const visibleBars = useMemo(() => bars.slice(-72), [bars]);

  const chartMetrics = useMemo(() => {
    const highs = visibleBars.map((b) => b.high);
    const lows = visibleBars.map((b) => b.low);
    const maxPrice = Math.max(...highs);
    const minPrice = Math.min(...lows);
    const span = maxPrice - minPrice || spec.stepSize;
    const pricePadTop = span * 0.14;
    const pricePadBottom = span * 0.14;

    const aoValues = visibleBars.map((b) => b.ao);
    const rawMaxAo = Math.max(0, ...aoValues);
    const rawMinAo = Math.min(0, ...aoValues);
    const aoSpan = Math.max(rawMaxAo - rawMinAo, 0.001);
    const aoPad = aoSpan * 0.14;

    return {
      priceTop: maxPrice + pricePadTop,
      priceBottom: minPrice - pricePadBottom,
      aoTop: rawMaxAo + aoPad,
      aoBottom: rawMinAo - aoPad,
    };
  }, [visibleBars, spec.stepSize]);

  const activeBar =
    hoveredIdx !== null && visibleBars[hoveredIdx]
      ? visibleBars[hoveredIdx]
      : visibleBars[visibleBars.length - 1];

  const latestClosedBar = visibleBars[visibleBars.length - 1];
  const detectedInVisible = visibleBars.filter((b) => b.signal !== null).length;

  // Geometry matching MT5 mobile chart proportions & right-side chart shift
  const svgW = 860;
  const priceH = 290;
  const dividerY = priceH;
  const aoH = 165;
  const xAxisY = dividerY + aoH;
  const totalH = xAxisY + 26;

  const padL = 8;
  const padR = isWebMode ? 8 : 96; // Clean full-width canvas in web mode vs MT5 right scale gutter in Studio
  const plotLeft = padL;
  const plotRight = svgW - padR;
  const totalPlotW = plotRight - plotLeft;

  // Reserve ~28% empty space on the right like MT5 Chart Shift in the screenshot
  const activeCandlesW = totalPlotW * 0.7;
  const slotW = activeCandlesW / visibleBars.length;
  const candleW = Math.max(2.6, Math.min(4.8, slotW * 0.56));
  const aoBarW = Math.max(1.6, Math.min(2.6, slotW * 0.34));

  const priceToY = (p: number) => {
    const ratio =
      (chartMetrics.priceTop - p) / (chartMetrics.priceTop - chartMetrics.priceBottom);
    return 12 + ratio * (priceH - 22);
  };

  const aoToY = (ao: number) => {
    const ratio =
      (chartMetrics.aoTop - ao) / (chartMetrics.aoTop - chartMetrics.aoBottom);
    return dividerY + 18 + ratio * (aoH - 32);
  };
  const aoZeroY = aoToY(0);
  const latestCloseY = priceToY(latestClosedBar.close);

  // 7 crisp horizontal price scale levels on the right axis matching MT5
  const priceTickRatios = [0.06, 0.21, 0.36, 0.51, 0.66, 0.81, 0.94];

  return (
    <section className="space-y-6">
      {/* Control Toolbar */}
      <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-2.5">
          {/* Live vs Sim Switch */}
          <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1">
            <button
              type="button"
              onClick={() => handleChangeFeedMode('live')}
              className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium whitespace-nowrap transition-colors ${
                feedMode === 'live'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Radio className="h-3.5 w-3.5 text-emerald-600" />
              กราฟจริง
            </button>
            <button
              type="button"
              onClick={() => handleChangeFeedMode('sim')}
              className={`h-8 rounded-md px-3 text-xs font-medium whitespace-nowrap transition-colors ${
                feedMode === 'sim'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              จำลอง
            </button>
          </div>

          {/* Single Primary Asset Badge: US100 only */}
          <div className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3.5 text-xs">
            <span className="font-semibold text-blue-700">US100</span>
            <span className="text-slate-400">·</span>
            <span className="font-medium text-slate-600">
              {lockM5 ? 'M5' : 'Chart'} · {spec.label}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {feedMode === 'live' ? (
            <button
              type="button"
              onClick={() => void fetchLiveBars(symbol)}
              disabled={isLoadingLive}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 whitespace-nowrap transition-colors hover:bg-slate-50 disabled:opacity-50"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${isLoadingLive ? 'animate-spin' : ''}`}
              />
              รีเฟรชกราฟจริง
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => advanceBar('BUY')}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 text-xs font-medium text-white whitespace-nowrap transition-colors hover:bg-emerald-700"
              >
                <ArrowUpRight className="h-3.5 w-3.5" />
                ทดสอบ BUY
              </button>

              <button
                type="button"
                onClick={() => advanceBar('SELL')}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-rose-600 px-3.5 text-xs font-medium text-white whitespace-nowrap transition-colors hover:bg-rose-700"
              >
                <ArrowDownRight className="h-3.5 w-3.5" />
                ทดสอบ SELL
              </button>

              <button
                type="button"
                onClick={() => setIsPlaying((p) => !p)}
                className={`inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-medium whitespace-nowrap transition-colors ${
                  isPlaying
                    ? 'bg-slate-900 text-white hover:bg-slate-800'
                    : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                {isPlaying ? 'หยุด' : 'เล่น'}
              </button>

              <button
                type="button"
                onClick={() => advanceBar()}
                aria-label="แท่งถัดไป M5"
                className="inline-flex h-9 items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 whitespace-nowrap transition-colors hover:bg-slate-50"
              >
                <SkipForward className="h-3.5 w-3.5" />
                ถัดไป
              </button>

              <button
                type="button"
                onClick={() => {
                  setIsPlaying(false);
                  stopAudioAndTimer();
                  setBars(generateInitialSeries(symbol));
                  setLastPushBanner(null);
                }}
                aria-label="รีเซ็ตกราฟ"
                className="inline-flex h-9 items-center justify-center rounded-lg border border-slate-200 bg-white px-2.5 text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-800"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            </>
          )}

          <button
            type="button"
            onClick={() => {
              if (soundEnabled) stopAudioAndTimer();
              setSoundEnabled((s) => !s);
            }}
            aria-label="สลับเสียงเตือน 10 วินาที"
            className={`inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium whitespace-nowrap transition-colors ${
              soundEnabled
                ? 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                : 'border-slate-200 bg-slate-100 text-slate-400'
            }`}
          >
            {soundEnabled ? (
              <Volume2 className="h-3.5 w-3.5 text-blue-600" />
            ) : (
              <VolumeX className="h-3.5 w-3.5" />
            )}
            เสียง 10 วิ
          </button>

          {soundSecondsLeft > 0 && (
            <button
              type="button"
              onClick={stopAudioAndTimer}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-amber-600 px-3 text-xs font-medium text-white whitespace-nowrap transition-colors hover:bg-amber-700"
            >
              <Square className="h-3 w-3" />
              หยุด ({soundSecondsLeft}s)
            </button>
          )}
        </div>
      </div>

      {liveError && feedMode === 'live' && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-2.5 text-xs text-rose-800">
          {liveError}
        </div>
      )}

      {telegramSyncedReady === false && !telegramConfigured && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-900">
          <span>
            เซิร์ฟเวอร์รีสตาร์ทใหม่หรือยังไม่ได้ตั้งค่า Telegram — จึงยังส่งแจ้งเตือนเข้าแชทไม่ได้
          </span>
          <button
            type="button"
            onClick={onGoToTelegram}
            className="rounded-md bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-700"
          >
            ตั้งค่า Telegram ทันที
          </button>
        </div>
      )}

      {/* Main Split: MT5 Black Chart Left + Android Push & Background Monitor Right */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-stretch">
        {/* Interactive Price + AO Chart (MT5 Black Mobile Terminal Layout & Spacing) */}
        <div className="lg:col-span-8 flex flex-col rounded-xl border border-neutral-800 bg-black p-3 sm:p-4 text-neutral-200 shadow-sm">
          {/* Compact Top Readout Strip */}
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 border-b border-neutral-900 px-1 pb-2 text-xs">
            <div className="flex items-center gap-2.5">
              <span className="font-semibold text-[#1e90ff]">
                US100Cash# · {lockM5 ? 'M5' : 'Chart'}
              </span>
              {feedMode === 'live' && marketState && (
                <span className="inline-flex items-center gap-1.5 text-neutral-400">
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      marketState === 'MARKET CLOSED' ? 'bg-neutral-500' : 'bg-emerald-400'
                    }`}
                  />
                  {marketState === 'MARKET CLOSED' ? 'ตลาดปิด (ล่าสุด)' : marketState}
                </span>
              )}
              {feedMode === 'sim' && (
                <span className="text-neutral-400">· โหมดจำลอง</span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3 font-mono text-[11px] tabular-nums">
              <span className="text-neutral-400">{activeBar.timeLabel}</span>
              <span className="hidden sm:inline text-neutral-400">
                O {activeBar.open.toFixed(spec.digits)} · H {activeBar.high.toFixed(spec.digits)} · L {activeBar.low.toFixed(spec.digits)}
              </span>
              <span className="text-neutral-100 font-medium">
                C {activeBar.close.toFixed(spec.digits)}
              </span>
              <span
                className={`font-semibold ${
                  activeBar.ao >= 0 ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
                AO {activeBar.ao.toFixed(aoDigits)}
              </span>
            </div>
          </div>

          <div className="relative w-full overflow-x-auto">
            <svg
              viewBox={`0 0 ${svgW} ${totalH}`}
              className="h-auto w-full min-w-[600px] select-none"
              role="img"
              aria-label="กราฟราคาและ Awesome Oscillator ของ US100 กรอบเวลา M5"
            >
              {/* Pure Black MT5 Canvas */}
              <rect x={0} y={0} width={svgW} height={totalH} fill="#000000" />

              {/* Vertical Right Y-Axis Divider & Scale (Studio mode only) */}
              {!isWebMode && (
                <>
                  <line
                    x1={plotRight}
                    y1={0}
                    x2={plotRight}
                    y2={xAxisY}
                    stroke="#3a3a3a"
                    strokeWidth="1"
                  />

                  {priceTickRatios.map((ratio, idx) => {
                    const y = 12 + ratio * (priceH - 22);
                    const priceVal =
                      chartMetrics.priceTop -
                      ratio * (chartMetrics.priceTop - chartMetrics.priceBottom);
                    return (
                      <g key={`p-tick-${idx}`}>
                        <line
                          x1={plotRight}
                          y1={y}
                          x2={plotRight + 4}
                          y2={y}
                          stroke="#525252"
                          strokeWidth="1"
                        />
                        <text
                          x={plotRight + 7}
                          y={y + 4}
                          fontSize="12"
                          fill="#9ca3af"
                          className="font-mono tabular-nums"
                        >
                          {priceVal.toFixed(spec.digits)}
                        </text>
                      </g>
                    );
                  })}
                </>
              )}

              {/* Horizontal separator between Price pane and AO pane */}
              <line
                x1={plotLeft}
                y1={dividerY}
                x2={svgW}
                y2={dividerY}
                stroke="#4b5563"
                strokeWidth="1"
              />

              {/* Bottom X-axis line */}
              <line
                x1={plotLeft}
                y1={xAxisY}
                x2={plotRight}
                y2={xAxisY}
                stroke="#4b5563"
                strokeWidth="1"
              />

              {/* Subtle AO Zero reference line */}
              <line
                x1={plotLeft}
                y1={aoZeroY}
                x2={plotRight}
                y2={aoZeroY}
                stroke="#1f2937"
                strokeWidth="1"
              />

              {/* AO Right-Axis Scale Labels (Studio mode only) */}
              {!isWebMode && (
                <>
                  <text
                    x={plotRight + 7}
                    y={dividerY + 18}
                    fontSize="12"
                    fill="#9ca3af"
                    className="font-mono tabular-nums"
                  >
                    {chartMetrics.aoTop.toFixed(aoDigits)}
                  </text>
                  <text
                    x={plotRight + 7}
                    y={aoZeroY + 4}
                    fontSize="12"
                    fill="#9ca3af"
                    className="font-mono tabular-nums"
                  >
                    {Number(0).toFixed(aoDigits)}
                  </text>
                  <text
                    x={plotRight + 7}
                    y={xAxisY - 6}
                    fontSize="12"
                    fill="#9ca3af"
                    className="font-mono tabular-nums"
                  >
                    {chartMetrics.aoBottom.toFixed(aoDigits)}
                  </text>
                </>
              )}

              {/* Candlesticks & AO Histogram (occupying left 70% with generous right whitespace) */}
              {visibleBars.map((bar, idx) => {
                const xCenter = plotLeft + 6 + idx * slotW + slotW / 2;
                const isBull = bar.close >= bar.open;
                // MT5 Mobile Blue (bull) / Crisp White (bear) candles
                const bodyColor = isBull ? '#1e88e5' : '#e5e7eb';
                const wickColor = isBull ? '#38bdf8' : '#e5e7eb';
                const yHigh = priceToY(bar.high);
                const yLow = priceToY(bar.low);
                const yOpen = priceToY(bar.open);
                const yClose = priceToY(bar.close);
                const bodyTop = Math.min(yOpen, yClose);
                const bodyH = Math.max(1.5, Math.abs(yClose - yOpen));

                const aoY = aoToY(bar.ao);
                const aoRectTop = bar.ao >= 0 ? aoY : aoZeroY;
                const aoRectH = Math.max(1.5, Math.abs(aoY - aoZeroY));
                // User rule: Green when > 0 (cut up), Red when < 0 (cut down), muted on exact 0
                const aoColor =
                  bar.ao > 0 ? '#22c55e' : bar.ao < 0 ? '#ef4444' : '#374151';

                const isHovered = hoveredIdx === idx;
                const showXTick = idx === 2 || idx === 22 || idx === 42 || idx === 62;

                return (
                  <g
                    key={`${bar.timestampIso}-${idx}`}
                    onMouseEnter={() => setHoveredIdx(idx)}
                    onMouseLeave={() => setHoveredIdx(null)}
                    className="cursor-crosshair"
                  >
                    {/* Hover hit target */}
                    <rect
                      x={xCenter - slotW / 2}
                      y={0}
                      width={slotW}
                      height={xAxisY}
                      fill="transparent"
                    />

                    {isHovered && (
                      <g>
                        <line
                          x1={xCenter}
                          y1={0}
                          x2={xCenter}
                          y2={xAxisY}
                          stroke="#525252"
                          strokeWidth="1"
                          strokeDasharray="3 3"
                        />
                        <line
                          x1={plotLeft}
                          y1={yClose}
                          x2={plotRight}
                          y2={yClose}
                          stroke="#525252"
                          strokeWidth="1"
                          strokeDasharray="3 3"
                        />
                      </g>
                    )}

                    {/* Wick */}
                    <line
                      x1={xCenter}
                      y1={yHigh}
                      x2={xCenter}
                      y2={yLow}
                      stroke={wickColor}
                      strokeWidth="1"
                    />

                    {/* Body */}
                    <rect
                      x={xCenter - candleW / 2}
                      y={bodyTop}
                      width={candleW}
                      height={bodyH}
                      fill={bodyColor}
                    />

                    {/* AO Bar */}
                    <rect
                      x={xCenter - aoBarW / 2}
                      y={aoRectTop}
                      width={aoBarW}
                      height={aoRectH}
                      fill={aoColor}
                      opacity={isHovered ? 1 : 0.94}
                    />

                    {/* Crossover Marker */}
                    {bar.signal === 'BUY' && (
                      <circle cx={xCenter} cy={aoZeroY} r="2.8" fill="#22c55e" />
                    )}
                    {bar.signal === 'SELL' && (
                      <circle cx={xCenter} cy={aoZeroY} r="2.8" fill="#ef4444" />
                    )}

                    {/* Bottom X-axis tick + MT5 timestamp */}
                    {showXTick && (
                      <g>
                        <line
                          x1={xCenter}
                          y1={xAxisY}
                          x2={xCenter}
                          y2={xAxisY + 4}
                          stroke="#525252"
                          strokeWidth="1"
                        />
                        <text
                          x={xCenter}
                          y={xAxisY + 18}
                          textAnchor="middle"
                          fontSize="11.5"
                          fill="#9ca3af"
                          className="font-sans tabular-nums"
                        >
                          {formatMt5AxisDate(bar.timestampIso)}
                        </text>
                      </g>
                    )}
                  </g>
                );
              })}

              {/* Top-left MT5 Watermark (rendered cleanly above bars like screenshot) */}
              <text
                x={plotLeft + 8}
                y={22}
                fontSize="14"
                fontWeight="700"
                fill="#1e88e5"
                className="font-sans"
              >
                US100Cash#
                <tspan fill="#9ca3af" fontWeight="400" fontSize="13">
                  {' '}
                  ▾ M5
                </tspan>
              </text>
              <text
                x={plotLeft + 8}
                y={39}
                fontSize="12.5"
                fill="#9ca3af"
                className="font-sans"
              >
                US 100 Index Cash
              </text>

              {/* AO Readout top-left of AO sub-window */}
              <text
                x={plotLeft + 8}
                y={dividerY + 19}
                fontSize="12.5"
                fill="#9ca3af"
                className="font-sans tabular-nums"
              >
                AO{' '}
                <tspan fill={activeBar.ao >= 0 ? '#22c55e' : '#ef4444'}>
                  {activeBar.ao.toFixed(aoDigits)}
                </tspan>
              </text>

              {/* Horizontal Bid/Close Price Lines + MT5 Dark Gray Price & M5 Countdown Badge */}
              <line
                x1={plotLeft}
                y1={latestCloseY - 1.5}
                x2={svgW}
                y2={latestCloseY - 1.5}
                stroke="#b91c1c"
                strokeWidth="0.9"
                opacity={0.85}
              />
              <line
                x1={plotLeft}
                y1={latestCloseY}
                x2={plotRight}
                y2={latestCloseY}
                stroke="#6b7280"
                strokeWidth="0.9"
                opacity={0.8}
              />

              {!isWebMode && (
                <g
                  transform={`translate(${plotRight + 2}, ${Math.min(
                    Math.max(latestCloseY - 12, 6),
                    priceH - 36
                  )})`}
                >
                  <rect
                    x={0}
                    y={0}
                    width={padR - 4}
                    height={33}
                    fill="#404040"
                    stroke="#525252"
                    strokeWidth="0.75"
                  />
                  <text
                    x={6}
                    y={14}
                    fontSize="12.5"
                    fontWeight="500"
                    fill="#ffffff"
                    className="font-mono tabular-nums"
                  >
                    {latestClosedBar.close.toFixed(spec.digits)}
                  </text>
                  <text
                    x={6}
                    y={28}
                    fontSize="11.5"
                    fill="#e5e7eb"
                    className="font-mono tabular-nums"
                  >
                    {feedMode === 'live' ? barCountdown : '00:00'}
                  </text>
                </g>
              )}
            </svg>
          </div>
        </div>

        {/* Right Column: Notification Preview + Autonomous Background Monitor */}
        <div className="lg:col-span-4 flex flex-col justify-between gap-5 rounded-xl border border-slate-200 bg-white p-5">
          <div>
            <div className="flex items-center justify-between gap-2 pb-3">
              <div className="flex items-center gap-2">
                <Smartphone className="h-4 w-4 text-slate-600" />
                <h3 className="text-sm font-semibold text-slate-900">
                  {isWebMode ? 'แจ้งเตือน' : 'แจ้งเตือนบน Android'}
                </h3>
              </div>
              <span className="font-mono text-[11px] text-slate-400">
                {isWebMode
                  ? feedMode === 'live'
                    ? 'Live M5'
                    : 'M5'
                  : feedSource || 'M5'}
              </span>
            </div>

            {/* Minimal Android Notification Card */}
            <div className="rounded-xl bg-slate-900 p-4 text-slate-100">
              {lastPushBanner ? (
                <div>
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2">
                      <Bell
                        className={`h-3.5 w-3.5 ${
                          lastPushBanner.signal === 'BUY'
                            ? 'text-emerald-400'
                            : 'text-rose-400'
                        }`}
                      />
                      <span className="font-semibold text-white">
                        {lastPushBanner.symbol} · {lastPushBanner.signal}
                      </span>
                    </div>
                    <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                      {lastPushBanner.time}
                    </span>
                  </div>
                  <p className="mt-2 font-mono text-xs text-slate-300 tabular-nums">
                    {customPrefix} | AO {lastPushBanner.aoCurr.toFixed(lastPushBanner.digits + 1)} · ราคา{' '}
                    {lastPushBanner.price.toFixed(lastPushBanner.digits)}
                  </p>
                </div>
              ) : (
                <p className="py-1.5 text-xs text-slate-400">
                  {feedMode === 'live'
                    ? 'กำลังติดตามกราฟจริง US100 M5 อัตโนมัติ'
                    : 'กด “ทดสอบ BUY” หรือ “ทดสอบ SELL”'}
                </p>
              )}
            </div>

            {/* Autonomous Server Monitor + Zero-Install Web Push */}
            <div className="mt-5 border-t border-slate-100 pt-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span
                    className={`h-2 w-2 rounded-full ${
                      monitorEnabled ? 'bg-emerald-500' : 'bg-slate-300'
                    }`}
                  />
                  <span className="text-xs font-semibold text-slate-800">
                    เซิร์ฟเวอร์เฝ้ากราฟ US100 M5 อัตโนมัติ
                  </span>
                </div>
                <button
                  type="button"
                  disabled={monitorBusy}
                  onClick={() => void handleToggleServerMonitor()}
                  className="text-xs font-medium text-slate-500 hover:text-slate-900"
                >
                  {monitorEnabled ? 'พักชั่วคราว' : 'เปิดรัน'}
                </button>
              </div>

              {pushSupported ? (
                pushSubscribed ? (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={monitorBusy}
                      onClick={() => void handleTestWebPush()}
                      className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                    >
                      <Bell className="h-3.5 w-3.5" />
                      ทดสอบแจ้งเตือนเข้าเครื่องนี้
                    </button>
                    <button
                      type="button"
                      disabled={monitorBusy}
                      onClick={() => void handleDisableWebPush()}
                      className="h-9 rounded-lg border border-slate-200 px-3 text-xs font-medium text-slate-600 hover:bg-slate-50"
                    >
                      ปิด
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={monitorBusy}
                    onClick={() => void handleEnableWebPush()}
                    className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-3 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    <Bell className="h-3.5 w-3.5" />
                    รับแจ้งเตือนเข้ามือถือ (ไม่ต้องลงแอป)
                  </button>
                )
              ) : (
                <p className="text-[11px] text-slate-500">
                  เปิดหน้านี้ใน Chrome บน Android เพื่อรับแจ้งเตือนโดยไม่ต้องลงแอป
                </p>
              )}

              <div className="flex items-center justify-between pt-1 text-xs">
                <span className="text-slate-500">
                  Telegram:{' '}
                  <span
                    className={
                      telegramSyncedReady ?? telegramConfigured
                        ? 'font-medium text-emerald-700'
                        : 'font-medium text-amber-600'
                    }
                  >
                    {telegramSyncedReady ?? telegramConfigured
                      ? 'เชื่อมต่อแล้ว (ส่งทุกสัญญาณ)'
                      : 'ยังไม่ตั้งค่า'}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={onGoToTelegram}
                  className="font-medium text-blue-600 hover:underline"
                >
                  ตั้งค่า Telegram
                </button>
              </div>

              <details className="text-xs text-slate-500">
                <summary className="cursor-pointer select-none py-1 hover:text-slate-800">
                  ช่องทางเสริม: ntfy (เลือกเสียง 10 วิได้)
                </summary>
                <div className="mt-2 flex gap-2">
                  <input
                    type="text"
                    value={ntfyTopic}
                    onChange={(e) => setNtfyTopic(e.target.value)}
                    placeholder="ชื่อช่อง ntfy (เช่น ao-m5-alert)"
                    className="h-8 flex-1 rounded-lg border border-slate-200 px-2.5 font-mono text-xs text-slate-900 focus:border-blue-600 focus:outline-none"
                  />
                  <button
                    type="button"
                    disabled={monitorBusy || !ntfyTopic.trim()}
                    onClick={() => void handleTestNtfy()}
                    className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    <Send className="h-3 w-3" />
                    ทดสอบ
                  </button>
                </div>
              </details>

              {monitorNote && (
                <p className="text-[11px] text-slate-600">{monitorNote}</p>
              )}
            </div>

            {/* Recent Captured Signals */}
            <div className="mt-4 border-t border-slate-100 pt-4">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-medium text-slate-500">
                  สัญญาณล่าสุด ({recentSignals.length})
                </h4>
                {recentSignals.length > 0 && (
                  <button
                    type="button"
                    onClick={onGoToSheets}
                    className="text-xs font-medium text-blue-600 hover:underline"
                  >
                    ส่งลง Sheet
                  </button>
                )}
              </div>

              {recentSignals.length === 0 ? (
                <p className="mt-2 text-xs text-slate-400">ยังไม่มีรายการ</p>
              ) : (
                <ul className="mt-2 divide-y divide-slate-100">
                  {recentSignals.slice(0, 3).map((item) => (
                    <li
                      key={item.id}
                      className="flex items-center justify-between py-1.5 text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={`font-semibold ${
                            item.signal === 'BUY' ? 'text-emerald-700' : 'text-rose-700'
                          }`}
                        >
                          {item.signal}
                        </span>
                        <span className="text-slate-700">{item.symbol}</span>
                      </div>
                      <span className="font-mono text-slate-500 tabular-nums">
                        {item.aoCurr >= 0 ? '+' : ''}
                        {item.aoCurr.toFixed(aoDigits)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 4-Column Summary Strip (shown in Studio mode only) */}
      {!isWebMode && (
        <div className="grid grid-cols-2 gap-4 rounded-xl border border-slate-200 bg-white p-5 lg:grid-cols-4">
          <div>
            <p className="text-xs text-slate-500">สินทรัพย์</p>
            <p className="mt-1 text-base font-semibold text-slate-900 tabular-nums">
              {symbol}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-500">แหล่งข้อมูล</p>
            <p className="mt-1 text-base font-semibold text-slate-900 tabular-nums">
              {feedMode === 'live' ? 'กราฟจริง M5' : 'จำลอง M5'}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-500">AO ล่าสุด (5, 34)</p>
            <p
              className={`mt-1 font-mono text-base font-semibold tabular-nums ${
                latestClosedBar.ao >= 0 ? 'text-emerald-700' : 'text-rose-700'
              }`}
            >
              {latestClosedBar.ao >= 0 ? '+' : ''}
              {latestClosedBar.ao.toFixed(aoDigits)}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-500">จุดตัดบนกราฟ</p>
            <p className="mt-1 text-base font-semibold text-slate-900 tabular-nums">
              {detectedInVisible} ครั้ง
            </p>
          </div>
        </div>
      )}
    </section>
  );
};
