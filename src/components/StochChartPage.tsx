import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Play,
  Pause,
  SkipForward,
  RotateCcw,
  ArrowUpRight,
  ArrowDownRight,
  Radio,
  RefreshCw,
  Volume2,
  VolumeX,
  Square,
  Bell,
  Smartphone,
  Send,
} from 'lucide-react';
import {
  M5Bar,
  SYMBOL_SPECS,
  TradingSymbol,
  generateInitialSeries,
} from '../lib/aoSimulator';
import {
  DEFAULT_STOCH_PARAMS,
  StochParams,
  StochTriggerType,
  appendStochSimBars,
  computeStochasticSeries,
} from '../lib/stochCalculator';
import { play10SecondSound, stop10SecondSound, unlockAlertAudio } from '../lib/audioAlert';
import {
  getExistingPushSubscription,
  isWebPushSupported,
  sendTestWebPush,
  subscribeDeviceToWebPush,
  unsubscribeDeviceFromWebPush,
} from '../lib/webPushClient';

interface StochChartPageProps {
  isWebMode?: boolean;
  onGoToTelegram?: () => void;
  telegramSyncedReady?: boolean | null;
}

interface LiveFeedResponse {
  symbol: TradingSymbol;
  source: string;
  marketState: string;
  fetchedAt: string;
  lastTickAt?: string | null;
  bid?: number;
  ask?: number;
  bars: M5Bar[];
  xmBridgeConnected?: boolean;
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

export const StochChartPage: React.FC<StochChartPageProps> = ({
  isWebMode = false,
  onGoToTelegram,
  telegramSyncedReady,
}) => {
  const symbol: TradingSymbol = 'US100';
  const spec = SYMBOL_SPECS[symbol];

  const [feedMode, setFeedMode] = useState<'live' | 'sim'>('live');
  const [stochParams, setStochParams] = useState<StochParams>(DEFAULT_STOCH_PARAMS);
  const [bars, setBars] = useState<M5Bar[]>(() => generateInitialSeries('US100', 140));
  const [marketState, setMarketState] = useState<string>('');
  const [feedSource, setFeedSource] = useState<string>('');
  const [liveBidAsk, setLiveBidAsk] = useState<{
    bid?: number;
    ask?: number;
    lastTickAt?: string | null;
  }>({});
  const [xmBridgeConnected, setXmBridgeConnected] = useState(false);
  const [isLoadingLive, setIsLoadingLive] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [barCountdown, setBarCountdown] = useState<string>(() => formatBarCountdown());

  const [isPlaying, setIsPlaying] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [soundSecondsLeft, setSoundSecondsLeft] = useState(0);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [panOffset, setPanOffset] = useState<number>(0);
  const [isDraggingChart, setIsDraggingChart] = useState(false);
  const dragStartXRef = useRef<number | null>(null);
  const dragStartPanRef = useRef<number>(0);

  const [lastSignalBanner, setLastSignalBanner] = useState<{
    signal: 'BUY' | 'SELL';
    triggerType: Exclude<StochTriggerType, null>;
    kPrev: number;
    k: number;
    price: number;
    time: string;
    label: string;
  } | null>(null);
  const [monitorEnabled, setMonitorEnabled] = useState(true);
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [pushEndpoint, setPushEndpoint] = useState<string | undefined>(undefined);
  const [pushSupported] = useState(() => isWebPushSupported());
  const [ntfyTopic, setNtfyTopic] = useState('');
  const [telegramConfigured, setTelegramConfigured] = useState(false);
  const [monitorBusy, setMonitorBusy] = useState(false);
  const [monitorNote, setMonitorNote] = useState<string | null>(null);

  const [recentStochSignals, setRecentStochSignals] = useState<
    Array<{
      id: string;
      time: string;
      signal: 'BUY' | 'SELL';
      triggerType: Exclude<StochTriggerType, null>;
      k: number;
      price: number;
      label: string;
    }>
  >([]);

  const countdownRef = useRef<number | null>(null);
  const barsRef = useRef<M5Bar[]>(bars);
  barsRef.current = bars;

  const lastObservedClosedBucketRef = useRef<number | null>(null);
  const alertedStochBucketsRef = useRef<Set<string>>(new Set<string>());
  const hasLoadedMonitorConfigRef = useRef(false);

  const stochSeries = useMemo(
    () => computeStochasticSeries(bars, stochParams),
    [bars, stochParams]
  );

  const [animatedTip, setAnimatedTip] = useState<{ close: number; k: number }>(() => {
    const last = stochSeries[stochSeries.length - 1];
    return {
      close: last?.close ?? spec.basePrice,
      k: last?.k ?? 50,
    };
  });
  const animatedTipRef = useRef(animatedTip);
  animatedTipRef.current = animatedTip;

  useEffect(() => {
    const latest = stochSeries[stochSeries.length - 1];
    if (!latest) return;

    const fromClose = animatedTipRef.current.close;
    const fromK = animatedTipRef.current.k;
    const toClose = latest.close;
    const toK = latest.k;

    if (Math.abs(toClose - fromClose) < 1e-6 && Math.abs(toK - fromK) < 1e-4) {
      return;
    }

    let rafId = 0;
    const durationMs = 420;
    const startTs = performance.now();

    const step = (now: number) => {
      const progress = Math.min(1, (now - startTs) / durationMs);
      const ease = 1 - Math.pow(1 - progress, 3);
      setAnimatedTip({
        close: fromClose + (toClose - fromClose) * ease,
        k: fromK + (toK - fromK) * ease,
      });
      if (progress < 1) {
        rafId = window.requestAnimationFrame(step);
      }
    };

    rafId = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(rafId);
  }, [stochSeries]);

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

  // Load server Stoch monitor config & existing Web Push subscription on mount
  useEffect(() => {
    fetch('/api/monitor/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) {
          setMonitorEnabled(Boolean(data.enabled));
          if (typeof data.ntfyTopic === 'string') {
            setNtfyTopic(data.ntfyTopic);
          }
          setTelegramConfigured(Boolean(data.telegramConfigured));
          if (data.stochConfig && typeof data.stochConfig === 'object') {
            setStochParams({
              kPeriod: Math.max(1, Number(data.stochConfig.kPeriod) || 15),
              dPeriod: Math.max(1, Number(data.stochConfig.dPeriod) || 3),
              slowing: Math.max(1, Number(data.stochConfig.slowing) || 3),
              upperLevel: Math.min(99, Math.max(51, Number(data.stochConfig.upperLevel) || 80)),
              lowerLevel: Math.max(1, Math.min(49, Number(data.stochConfig.lowerLevel) || 20)),
            });
          }
        }
        hasLoadedMonitorConfigRef.current = true;
      })
      .catch(() => {
        hasLoadedMonitorConfigRef.current = true;
      });

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

  // Sync Stoch parameters with server 24/7 monitor when changed by user
  useEffect(() => {
    if (!hasLoadedMonitorConfigRef.current) return;
    const t = window.setTimeout(() => {
      void fetch('/api/monitor/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stochConfig: stochParams }),
      }).catch(() => {});
    }, 350);
    return () => window.clearTimeout(t);
  }, [stochParams]);

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
          symbols: [symbol],
          ntfyTopic,
          stochConfig: stochParams,
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
          symbols: [symbol],
          ntfyTopic,
          stochConfig: stochParams,
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

  const recordStochSignal = useCallback(
    (
      signal: 'BUY' | 'SELL',
      triggerType: Exclude<StochTriggerType, null>,
      kPrev: number,
      k: number,
      price: number,
      timeLabel: string,
      timestampIso: string,
      mode: 'live' | 'sim'
    ) => {
      const label =
        triggerType === 'ABOVE_80'
          ? `ปิดสูงกว่า ${stochParams.upperLevel}`
          : `ปิดต่ำกว่า ${stochParams.lowerLevel}`;

      setLastSignalBanner({
        signal,
        triggerType,
        kPrev,
        k,
        price,
        time: timeLabel,
        label,
      });

      setRecentStochSignals((prev) =>
        [
          {
            id: `stoch-${timestampIso}-${Math.random().toString(36).slice(2, 6)}`,
            time: timeLabel,
            signal,
            triggerType,
            k,
            price,
            label,
          },
          ...prev,
        ].slice(0, 8)
      );

      trigger10sSound(signal);

      if (mode === 'sim') {
        void fetch('/api/monitor/notify-signal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            indicator: 'STOCH',
            symbol,
            timeframe: 'M5',
            signal,
            triggerType,
            aoPrev: kPrev,
            aoCurr: k,
            price,
            mode: 'sim',
            timestampIso,
          }),
        })
          .then(async (r) => {
            const resData = await r.json().catch(() => null);
            if (!r.ok) {
              setMonitorNote(resData?.error || 'ส่งแจ้งเตือนจำลองไม่สำเร็จ');
              return;
            }
            if (resData?.skipped) {
              setMonitorNote(`จำลอง "${label}" แล้ว (ยังไม่ได้ตั้งค่า Telegram/Push)`);
              return;
            }
            const channels: string[] = [];
            if (resData?.deliveredToTelegram) channels.push('Telegram');
            if (resData?.deliveredWebPushCount > 0) channels.push('มือถือ');
            if (resData?.deliveredToNtfy) channels.push('ntfy');
            setMonitorNote(
              channels.length > 0
                ? `ส่งแจ้งเตือนจำลองไปยัง ${channels.join(' + ')} แล้ว`
                : `บันทึกสัญญาณ "${label}" แล้ว`
            );
          })
          .catch(() => {});
      } else {
        setMonitorNote('ระบบหลังบ้านส่งแจ้งเตือน Telegram / มือถือ รอบปิดแท่งแล้ว');
      }
    },
    [stochParams.lowerLevel, stochParams.upperLevel, symbol, trigger10sSound]
  );

  const fetchLiveBars = useCallback(
    async (silent = false) => {
      if (!silent) setIsLoadingLive(true);
      setLiveError(null);
      try {
        const res = await fetch(
          `/api/market/m5?symbol=${encodeURIComponent(symbol)}&_t=${Date.now()}`,
          { cache: 'no-store' }
        );
        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          throw new Error(errBody.error || 'ดึงข้อมูลกราฟจริงไม่สำเร็จ');
        }
        const data = (await res.json()) as LiveFeedResponse;
        setBars(data.bars);
        setMarketState(data.marketState);
        setFeedSource(data.source);
        setLiveBidAsk({
          bid: data.bid,
          ask: data.ask,
          lastTickAt: data.lastTickAt || data.fetchedAt,
        });
        setXmBridgeConnected(Boolean(data.xmBridgeConnected));

        const computed = computeStochasticSeries(data.bars, stochParams);
        const closedBar = computed[computed.length - 2];
        const prevClosedBar = computed[computed.length - 3];
        if (closedBar && prevClosedBar) {
          const closedOpenMs = Date.parse(closedBar.timestampIso);
          if (Number.isFinite(closedOpenMs)) {
            const closedBucketMs = Math.floor(closedOpenMs / 300000) * 300000;
            const prevObserved = lastObservedClosedBucketRef.current;
            if (prevObserved === null) {
              // Silent baseline on page open: never trigger retroactive signals
              lastObservedClosedBucketRef.current = closedBucketMs;
            } else if (closedBucketMs > prevObserved) {
              lastObservedClosedBucketRef.current = closedBucketMs;
              const secSinceClose = (Date.now() - (closedBucketMs + 300000)) / 1000;
              const bucketKey = `STOCH-${new Date(closedBucketMs).toISOString()}`;
              if (
                closedBar.signal &&
                closedBar.triggerType &&
                secSinceClose >= -5 &&
                secSinceClose <= 90 &&
                !alertedStochBucketsRef.current.has(bucketKey)
              ) {
                alertedStochBucketsRef.current.add(bucketKey);
                recordStochSignal(
                  closedBar.signal,
                  closedBar.triggerType,
                  prevClosedBar.k,
                  closedBar.k,
                  closedBar.close,
                  closedBar.timeLabel,
                  closedBar.timestampIso,
                  'live'
                );
              }
            }
          }
        }
      } catch (err: any) {
        setLiveError(err?.message || 'เชื่อมต่อฟีดกราฟจริงไม่สำเร็จ');
      } finally {
        if (!silent) setIsLoadingLive(false);
      }
    },
    [recordStochSignal, stochParams, symbol]
  );

  // Real-time 2-second polling in Live mode
  useEffect(() => {
    if (feedMode !== 'live') return;
    void fetchLiveBars(false);
    const id = window.setInterval(() => {
      void fetchLiveBars(true);
    }, 2000);
    return () => window.clearInterval(id);
  }, [feedMode, fetchLiveBars]);

  const handleChangeFeedMode = (nextMode: 'live' | 'sim') => {
    setIsPlaying(false);
    setFeedMode(nextMode);
    setHoveredIdx(null);
    setPanOffset(0);
    setLiveError(null);
    setMonitorNote(null);
    if (nextMode === 'live') {
      lastObservedClosedBucketRef.current = null;
    } else {
      const initBars = generateInitialSeries(symbol, 140);
      barsRef.current = initBars;
      setBars(initBars);
      setMarketState('');
      setFeedSource('');
      setLiveBidAsk({});
    }
  };

  const advanceSimBar = (forceCross?: 'BUY' | 'SELL') => {
    const prevSeries = computeStochasticSeries(barsRef.current, stochParams);
    const prevK = prevSeries[prevSeries.length - 1]?.k ?? 50;

    const nextBars = appendStochSimBars(barsRef.current, forceCross, stochParams);
    barsRef.current = nextBars;
    setBars(nextBars);

    const computed = computeStochasticSeries(nextBars, stochParams);
    const latest = computed[computed.length - 1];
    const beforeLatest = computed[computed.length - 2];
    if (latest && (latest.signal || forceCross)) {
      const sig = latest.signal || forceCross!;
      const trig: Exclude<StochTriggerType, null> =
        latest.triggerType || (sig === 'SELL' ? 'ABOVE_80' : 'BELOW_20');
      recordStochSignal(
        sig,
        trig,
        beforeLatest?.k ?? prevK,
        latest.k,
        latest.close,
        latest.timeLabel,
        latest.timestampIso,
        'sim'
      );
    }
  };

  const advanceSimRef = useRef(advanceSimBar);
  advanceSimRef.current = advanceSimBar;

  useEffect(() => {
    if (feedMode !== 'sim' || !isPlaying) return;
    const timer = window.setInterval(() => {
      advanceSimRef.current();
    }, 750);
    return () => window.clearInterval(timer);
  }, [feedMode, isPlaying]);

  const livePoints = useMemo(() => {
    if (stochSeries.length === 0) return stochSeries;
    const copy = stochSeries.slice();
    const last = copy[copy.length - 1];
    copy[copy.length - 1] = {
      ...last,
      close: animatedTip.close,
      high: Math.max(last.high, animatedTip.close),
      low: Math.min(last.low, animatedTip.close),
      k: animatedTip.k,
    };
    return copy;
  }, [stochSeries, animatedTip]);

  const visibleCount = 68;
  const maxPan = Math.max(0, livePoints.length - visibleCount);
  const clampedPan = Math.min(Math.max(0, Math.round(panOffset)), maxPan);

  const visiblePoints = useMemo(() => {
    const endIdx = livePoints.length - clampedPan;
    const startIdx = Math.max(0, endIdx - visibleCount);
    return livePoints.slice(startIdx, endIdx);
  }, [livePoints, clampedPan]);

  const chartMetrics = useMemo(() => {
    const highs = visiblePoints.map((b) => b.high);
    const lows = visiblePoints.map((b) => b.low);
    const maxPrice = Math.max(...highs);
    const minPrice = Math.min(...lows);
    const span = maxPrice - minPrice || spec.stepSize;
    return {
      priceTop: maxPrice + span * 0.14,
      priceBottom: minPrice - span * 0.14,
    };
  }, [visiblePoints, spec.stepSize]);

  const activePoint =
    hoveredIdx !== null && visiblePoints[hoveredIdx]
      ? visiblePoints[hoveredIdx]
      : visiblePoints[visiblePoints.length - 1];
  const latestPoint = livePoints[livePoints.length - 1];

  // Geometry matching XM MT5 mobile layout & the attached Stoch(15,3,3) screenshot
  const svgW = 800;
  const priceH = 290;
  const dividerY = priceH;
  const stochH = 166;
  const xAxisY = dividerY + stochH;
  const totalH = xAxisY + 26;

  const padL = 6;
  const padR = 92;
  const plotLeft = padL;
  const plotRight = svgW - padR;
  const totalPlotW = plotRight - plotLeft;

  const activeCandlesW = clampedPan === 0 ? totalPlotW * 0.72 : totalPlotW * 0.96;
  const slotW = activeCandlesW / Math.max(1, visiblePoints.length);
  const candleW = Math.max(2.6, Math.min(5.2, slotW * 0.56));

  const priceToY = (p: number) => {
    const ratio =
      (chartMetrics.priceTop - p) / (chartMetrics.priceTop - chartMetrics.priceBottom);
    return 12 + ratio * (priceH - 22);
  };

  // Map 0..100 into Stoch pane matching screenshot padding
  const stochToY = (val: number) => {
    const clamped = Math.min(100, Math.max(0, val));
    return dividerY + 12 + ((100 - clamped) / 100) * (stochH - 20);
  };

  const levelUpperY = stochToY(stochParams.upperLevel);
  const levelLowerY = stochToY(stochParams.lowerLevel);

  const kPathD = useMemo(() => {
    if (visiblePoints.length === 0) return '';
    return visiblePoints
      .map((pt, idx) => {
        const x = plotLeft + 6 + idx * slotW + slotW / 2;
        const y = stochToY(pt.k);
        return `${idx === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  }, [visiblePoints, plotLeft, slotW, stochParams]);

  const liveDisplayPrice =
    feedMode === 'live' && typeof liveBidAsk.bid === 'number' && liveBidAsk.bid > 0
      ? liveBidAsk.bid
      : latestPoint.close;
  const liveAskPrice =
    feedMode === 'live' && typeof liveBidAsk.ask === 'number' && liveBidAsk.ask > 0
      ? liveBidAsk.ask
      : liveDisplayPrice + spec.stepSize * 0.05;
  const latestCloseY = Math.min(Math.max(priceToY(liveDisplayPrice), 8), priceH - 8);
  const askLineY = Math.min(
    Math.max(Math.min(priceToY(liveAskPrice), latestCloseY - 1.5), 6),
    priceH - 10
  );
  const showLatestLine =
    liveDisplayPrice <= chartMetrics.priceTop &&
    liveDisplayPrice >= chartMetrics.priceBottom;

  const priceTickRatios = [0.06, 0.21, 0.36, 0.51, 0.66, 0.81, 0.94];

  const handleChartPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    dragStartXRef.current = e.clientX;
    dragStartPanRef.current = panOffset;
    setIsDraggingChart(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handleChartPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!isDraggingChart || dragStartXRef.current === null) return;
    const dx = e.clientX - dragStartXRef.current;
    const barsDelta = Math.round(dx / Math.max(6, slotW));
    setPanOffset(Math.min(Math.max(0, dragStartPanRef.current + barsDelta), maxPan));
  };

  const handleChartPointerEnd = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!isDraggingChart) return;
    setIsDraggingChart(false);
    dragStartXRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const handleChartWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (Math.abs(delta) < 4) return;
    const step = delta > 0 ? -3 : 3;
    setPanOffset((prev) => Math.min(Math.max(0, prev + step), maxPan));
  };

  const zoneText =
    latestPoint.k > stochParams.upperLevel
      ? `ปิดสูงกว่า ${stochParams.upperLevel} (Overbought)`
      : latestPoint.k < stochParams.lowerLevel
      ? `ปิดต่ำกว่า ${stochParams.lowerLevel} (Oversold)`
      : `กลางโซน (${stochParams.lowerLevel}–${stochParams.upperLevel})`;

  const zoneColorClass =
    latestPoint.k > stochParams.upperLevel
      ? 'text-rose-700'
      : latestPoint.k < stochParams.lowerLevel
      ? 'text-emerald-700'
      : 'text-slate-800';

  const triggerCountInView = visiblePoints.filter((p) => p.signal !== null).length;

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

          <div className="inline-flex h-10 items-center gap-2 text-xs text-slate-600 px-1">
            <span className="font-semibold text-blue-700">US100</span>
            <span className="text-slate-400">·</span>
            <span className="font-medium">
              M5 · Stoch({stochParams.kPeriod},{stochParams.dPeriod},{stochParams.slowing})
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {feedMode === 'live' ? (
            <button
              type="button"
              onClick={() => void fetchLiveBars(false)}
              disabled={isLoadingLive}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 whitespace-nowrap transition-colors hover:bg-slate-50 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isLoadingLive ? 'animate-spin' : ''}`} />
              รีเฟรชกราฟจริง
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => advanceSimBar('BUY')}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 text-xs font-medium text-white whitespace-nowrap transition-colors hover:bg-emerald-700"
              >
                <ArrowUpRight className="h-3.5 w-3.5" />
                จำลอง ปิด &lt; {stochParams.lowerLevel}
              </button>

              <button
                type="button"
                onClick={() => advanceSimBar('SELL')}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-rose-600 px-3.5 text-xs font-medium text-white whitespace-nowrap transition-colors hover:bg-rose-700"
              >
                <ArrowDownRight className="h-3.5 w-3.5" />
                จำลอง ปิด &gt; {stochParams.upperLevel}
              </button>

              <button
                type="button"
                onClick={() => {
                  const nextPlaying = !isPlaying;
                  if (nextPlaying) {
                    if (soundEnabled) unlockAlertAudio();
                    advanceSimBar();
                  }
                  setIsPlaying(nextPlaying);
                }}
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
                onClick={() => advanceSimBar()}
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
                  const resetBars = generateInitialSeries(symbol, 140);
                  barsRef.current = resetBars;
                  setBars(resetBars);
                  setLastSignalBanner(null);
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

      {/* Main Split: XM MT5 Black Chart + Stoch(15,3,3) Left & Signal/Settings Right */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-stretch">
        {/* Chart Card */}
        <div className="lg:col-span-8 flex flex-col rounded-xl border border-neutral-800 bg-black p-3 sm:p-4 text-neutral-200 shadow-sm">
          {/* Top Readout Strip */}
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 border-b border-neutral-900 px-1 pb-2 text-xs">
            <div className="flex items-center gap-2.5">
              <span className="font-semibold text-[#1e90ff]">{symbol} · M5</span>
              {feedMode === 'live' && marketState && (
                <span className="inline-flex items-center gap-1.5 text-neutral-400">
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      marketState === 'MARKET CLOSED'
                        ? 'bg-neutral-500'
                        : 'bg-emerald-400 animate-pulse'
                    }`}
                  />
                  {marketState === 'MARKET CLOSED'
                    ? 'ตลาดปิด (ล่าสุด)'
                    : `${xmBridgeConnected ? 'XM MT5' : 'MT5 CFD'} · อัปเดตทุก 2 วิ${
                        liveBidAsk.lastTickAt
                          ? ` (${new Date(liveBidAsk.lastTickAt).toLocaleTimeString('th-TH', {
                              hour: '2-digit',
                              minute: '2-digit',
                              second: '2-digit',
                              hour12: false,
                              timeZone: 'Asia/Bangkok',
                            })})`
                          : ''
                      }`}
                </span>
              )}
              {feedMode === 'sim' && <span className="text-neutral-400">· โหมดจำลอง</span>}
            </div>

            <div className="flex flex-wrap items-center gap-3 font-mono text-[11px] tabular-nums">
              <span className="text-neutral-400">{activePoint.timeLabel}</span>
              <span className="hidden sm:inline text-neutral-400">
                O {activePoint.open.toFixed(spec.digits)} · H {activePoint.high.toFixed(spec.digits)} · L {activePoint.low.toFixed(spec.digits)}
              </span>
              <span className="text-neutral-100 font-medium">
                C {activePoint.close.toFixed(spec.digits)}
              </span>
              <span className="font-semibold text-[#00b8b8]">
                Stoch {activePoint.k.toFixed(2)}
              </span>
            </div>
          </div>

          <div className="relative w-full overflow-hidden">
            {clampedPan > 0 && (
              <button
                type="button"
                onClick={() => setPanOffset(0)}
                className="absolute bottom-9 right-24 z-10 rounded-md border border-neutral-600 bg-neutral-900/90 px-2.5 py-1 text-[11px] font-medium text-sky-400 shadow hover:bg-neutral-800"
              >
                ล่าสุด ›
              </button>
            )}

            <svg
              viewBox={`0 0 ${svgW} ${totalH}`}
              onPointerDown={handleChartPointerDown}
              onPointerMove={handleChartPointerMove}
              onPointerUp={handleChartPointerEnd}
              onPointerCancel={handleChartPointerEnd}
              onWheel={handleChartWheel}
              className={`h-auto w-full select-none touch-pan-y ${
                isDraggingChart ? 'cursor-grabbing' : 'cursor-grab'
              }`}
              role="img"
              aria-label={`กราฟราคา M5 และ Stoch(${stochParams.kPeriod},${stochParams.dPeriod},${stochParams.slowing}) ของ ${symbol}`}
            >
              {/* Pure Black MT5 Canvas */}
              <rect x={0} y={0} width={svgW} height={totalH} fill="#000000" />

              {/* Right Y-Axis Divider */}
              <line
                x1={plotRight}
                y1={0}
                x2={plotRight}
                y2={xAxisY}
                stroke="#3a3a3a"
                strokeWidth="1"
              />

              {/* Price Right Y-Axis Ticks */}
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
                      fontSize="12.5"
                      fill="#9ca3af"
                      className="font-mono tabular-nums"
                    >
                      {priceVal.toFixed(spec.digits)}
                    </text>
                  </g>
                );
              })}

              {/* Pane Separator between Price and Stoch(15,3,3) */}
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

              {/* Stoch Horizontal Dashed Levels (80.00 and 20.00 matching screenshot) */}
              <line
                x1={plotLeft}
                y1={levelUpperY}
                x2={plotRight}
                y2={levelUpperY}
                stroke="#6b7280"
                strokeWidth="1"
                strokeDasharray="5 4"
              />
              <line
                x1={plotRight}
                y1={levelUpperY}
                x2={plotRight + 4}
                y2={levelUpperY}
                stroke="#6b7280"
                strokeWidth="1"
              />
              <text
                x={plotRight + 7}
                y={levelUpperY + 4}
                fontSize="12.5"
                fill="#9ca3af"
                className="font-mono tabular-nums"
              >
                {stochParams.upperLevel.toFixed(2)}
              </text>

              <line
                x1={plotLeft}
                y1={levelLowerY}
                x2={plotRight}
                y2={levelLowerY}
                stroke="#6b7280"
                strokeWidth="1"
                strokeDasharray="5 4"
              />
              <line
                x1={plotRight}
                y1={levelLowerY}
                x2={plotRight + 4}
                y2={levelLowerY}
                stroke="#6b7280"
                strokeWidth="1"
              />
              <text
                x={plotRight + 7}
                y={levelLowerY + 4}
                fontSize="12.5"
                fill="#9ca3af"
                className="font-mono tabular-nums"
              >
                {stochParams.lowerLevel.toFixed(2)}
              </text>

              {/* Candlesticks + Hover + X-axis */}
              {visiblePoints.map((pt, idx) => {
                const xCenter = plotLeft + 6 + idx * slotW + slotW / 2;
                const isBull = pt.close >= pt.open;
                const bodyColor = isBull ? '#1e88e5' : '#e5e7eb';
                const wickColor = isBull ? '#38bdf8' : '#e5e7eb';
                const yHigh = priceToY(pt.high);
                const yLow = priceToY(pt.low);
                const yOpen = priceToY(pt.open);
                const yClose = priceToY(pt.close);
                const bodyTop = Math.min(yOpen, yClose);
                const bodyH = Math.max(1.5, Math.abs(yClose - yOpen));
                const isHovered = hoveredIdx === idx;
                const showXTick = idx === 2 || idx === 22 || idx === 42 || idx === 62;

                return (
                  <g
                    key={`${pt.timestampIso}-${idx}`}
                    onMouseEnter={() => setHoveredIdx(idx)}
                    onMouseLeave={() => setHoveredIdx(null)}
                    className="cursor-crosshair"
                  >
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
                          stroke="#525252"
                          strokeWidth="1"
                        />
                        <text
                          x={xCenter}
                          y={xAxisY + 18}
                          textAnchor="middle"
                          fontSize="12"
                          fill="#9ca3af"
                          className="font-sans tabular-nums"
                        >
                          {formatMt5AxisDate(pt.timestampIso)}
                        </text>
                      </g>
                    )}
                  </g>
                );
              })}

              {/* Single Main %K Solid Cyan Line */}
              {kPathD && (
                <path
                  d={kPathD}
                  fill="none"
                  stroke="#00b8b8"
                  strokeWidth="2.2"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              )}

              {/* Threshold Close Markers (> 80 or < 20) */}
              {visiblePoints.map((pt, idx) => {
                if (!pt.signal) return null;
                const xCenter = plotLeft + 6 + idx * slotW + slotW / 2;
                const yK = stochToY(pt.k);
                return (
                  <circle
                    key={`sig-${pt.timestampIso}-${idx}`}
                    cx={xCenter}
                    cy={yK}
                    r="3"
                    fill={pt.signal === 'BUY' ? '#22c55e' : '#ef4444'}
                  />
                );
              })}

              {/* Top-left XM MT5 Price Watermark */}
              <text
                x={plotLeft + 8}
                y={22}
                fontSize="14.5"
                fontWeight="700"
                fill="#1e88e5"
                className="font-sans"
              >
                {symbol}
                <tspan fill="#9ca3af" fontWeight="400" fontSize="13.5">
                  {' '}
                  ▾ M5
                </tspan>
              </text>
              <text x={plotLeft + 8} y={40} fontSize="13" fill="#9ca3af" className="font-sans">
                {spec.label}
              </text>

              {/* Top-left Stoch Single-Line Readout */}
              <text
                x={plotLeft + 8}
                y={dividerY + 19}
                fontSize="13.5"
                fill="#9ca3af"
                className="font-sans tabular-nums"
              >
                Stoch({stochParams.kPeriod},{stochParams.dPeriod},{stochParams.slowing}){' '}
                <tspan fill="#00b8b8" className="font-mono font-semibold">
                  {activePoint.k.toFixed(2)}
                </tspan>
              </text>

              {/* Horizontal Ask/Bid Price Lines + MT5 Dark Gray Price & Countdown Box */}
              {showLatestLine && (
                <>
                  <line
                    x1={plotLeft}
                    y1={askLineY}
                    x2={svgW}
                    y2={askLineY}
                    stroke="#b91c1c"
                    strokeWidth="0.95"
                    opacity={0.9}
                  />
                  <line
                    x1={plotLeft}
                    y1={latestCloseY}
                    x2={plotRight}
                    y2={latestCloseY}
                    stroke="#6b7280"
                    strokeWidth="0.95"
                    opacity={0.85}
                  />
                </>
              )}

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
                  fontWeight="600"
                  fill="#ffffff"
                  className="font-mono tabular-nums"
                >
                  {liveDisplayPrice.toFixed(spec.digits)}
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
            </svg>
          </div>
        </div>

        {/* Right Column: Notification Preview + Autonomous Background Monitor (Matching AO Page) */}
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
              {lastSignalBanner ? (
                <div>
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2">
                      <Bell
                        className={`h-3.5 w-3.5 ${
                          lastSignalBanner.signal === 'BUY'
                            ? 'text-emerald-400'
                            : 'text-rose-400'
                        }`}
                      />
                      <span className="font-semibold text-white">
                        {symbol} · {lastSignalBanner.label}
                      </span>
                    </div>
                    <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                      {lastSignalBanner.time}
                    </span>
                  </div>
                  <p className="mt-2 font-mono text-xs text-slate-300 tabular-nums">
                    Stoch({stochParams.kPeriod},{stochParams.dPeriod},{stochParams.slowing}) | %K{' '}
                    {lastSignalBanner.kPrev.toFixed(2)} → {lastSignalBanner.k.toFixed(2)} · ราคา{' '}
                    {lastSignalBanner.price.toFixed(spec.digits)}
                  </p>
                </div>
              ) : (
                <p className="py-1.5 text-xs text-slate-400">
                  {feedMode === 'live'
                    ? `กำลังติดตามกราฟจริง ${symbol} M5 อัตโนมัติ (ปิด > ${stochParams.upperLevel} / < ${stochParams.lowerLevel})`
                    : `กด “จำลอง ปิด < ${stochParams.lowerLevel}” หรือ “จำลอง ปิด > ${stochParams.upperLevel}”`}
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
                {onGoToTelegram && (
                  <button
                    type="button"
                    onClick={onGoToTelegram}
                    className="font-medium text-blue-600 hover:underline"
                  >
                    ตั้งค่า Telegram
                  </button>
                )}
              </div>

              {/* Stoch Settings (15,3,3 & >80 / <20) — shown in Sim/Studio mode only */}
              {!isWebMode && feedMode === 'sim' && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-800">
                      ตั้งค่า Stoch({stochParams.kPeriod},{stochParams.dPeriod},{stochParams.slowing}) · เส้นเดียว
                    </span>
                    <button
                      type="button"
                      onClick={() => setStochParams(DEFAULT_STOCH_PARAMS)}
                      className="text-[11px] font-medium text-blue-600 hover:underline whitespace-nowrap"
                    >
                      ค่าเริ่มต้น
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="space-y-1">
                      <span className="block text-[11px] text-slate-500">%K period</span>
                      <input
                        type="number"
                        min={1}
                        max={100}
                        value={stochParams.kPeriod}
                        onChange={(e) =>
                          setStochParams((p) => ({
                            ...p,
                            kPeriod: Math.max(1, Number(e.target.value) || 15),
                          }))
                        }
                        className="h-8 w-full rounded-md border border-slate-200 bg-white px-2 font-mono text-xs text-slate-900 tabular-nums focus:border-blue-600 focus:outline-none"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="block text-[11px] text-slate-500">Slowing</span>
                      <input
                        type="number"
                        min={1}
                        max={50}
                        value={stochParams.slowing}
                        onChange={(e) =>
                          setStochParams((p) => ({
                            ...p,
                            slowing: Math.max(1, Number(e.target.value) || 3),
                          }))
                        }
                        className="h-8 w-full rounded-md border border-slate-200 bg-white px-2 font-mono text-xs text-slate-900 tabular-nums focus:border-blue-600 focus:outline-none"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="block text-[11px] text-slate-500">
                        แจ้งเตือนเมื่อปิดสูงกว่า
                      </span>
                      <input
                        type="number"
                        min={51}
                        max={99}
                        value={stochParams.upperLevel}
                        onChange={(e) =>
                          setStochParams((p) => ({
                            ...p,
                            upperLevel: Math.min(99, Math.max(51, Number(e.target.value) || 80)),
                          }))
                        }
                        className="h-8 w-full rounded-md border border-slate-200 bg-white px-2 font-mono text-xs text-slate-900 tabular-nums focus:border-blue-600 focus:outline-none"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="block text-[11px] text-slate-500">
                        แจ้งเตือนเมื่อปิดต่ำกว่า
                      </span>
                      <input
                        type="number"
                        min={1}
                        max={49}
                        value={stochParams.lowerLevel}
                        onChange={(e) =>
                          setStochParams((p) => ({
                            ...p,
                            lowerLevel: Math.max(1, Math.min(49, Number(e.target.value) || 20)),
                          }))
                        }
                        className="h-8 w-full rounded-md border border-slate-200 bg-white px-2 font-mono text-xs text-slate-900 tabular-nums focus:border-blue-600 focus:outline-none"
                      />
                    </label>
                  </div>
                </div>
              )}

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

              {monitorNote && <p className="text-[11px] text-slate-600">{monitorNote}</p>}
            </div>

            {/* Recent Threshold Alerts */}
            <div className="mt-4 border-t border-slate-100 pt-4">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-medium text-slate-500">
                  สัญญาณ Stoch ล่าสุด ({recentStochSignals.length})
                </h4>
                <span className="font-mono text-[11px] text-teal-600">เส้นสีฟ้าเส้นเดียว</span>
              </div>

              {recentStochSignals.length === 0 ? (
                <p className="mt-2 text-xs text-slate-400">ยังไม่มีรายการ</p>
              ) : (
                <ul className="mt-2 divide-y divide-slate-100">
                  {recentStochSignals.slice(0, 3).map((item) => (
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
                          {item.label}
                        </span>
                        <span className="text-slate-600">{item.time}</span>
                      </div>
                      <span className="font-mono text-teal-700 tabular-nums">
                        {item.k.toFixed(2)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 4-Column Summary Strip (shown in Sim/Studio mode only) */}
      {!isWebMode && feedMode === 'sim' && (
        <div className="grid grid-cols-2 gap-4 rounded-xl border border-slate-200 bg-white p-5 lg:grid-cols-4">
          <div>
            <p className="text-xs text-slate-500">สินทรัพย์</p>
            <p className="mt-1 text-base font-semibold text-slate-900 tabular-nums">
              {symbol} · M5
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-500">
              เส้นฟ้า Stoch({stochParams.kPeriod},{stochParams.dPeriod},{stochParams.slowing})
            </p>
            <p className="mt-1 font-mono text-base font-semibold text-teal-700 tabular-nums">
              {latestPoint.k.toFixed(2)}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-500">เงื่อนไขแจ้งเตือน</p>
            <p className="mt-1 text-base font-semibold text-slate-900 tabular-nums">
              ปิด &gt; {stochParams.upperLevel} หรือ &lt; {stochParams.lowerLevel}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-500">
              สถานะปัจจุบัน · เกิด {triggerCountInView} ครั้งในหน้าจอ
            </p>
            <p className={`mt-1 text-base font-semibold tabular-nums ${zoneColorClass}`}>
              {zoneText}
            </p>
          </div>
        </div>
      )}
    </section>
  );
};
