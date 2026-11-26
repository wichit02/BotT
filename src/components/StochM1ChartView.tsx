import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowDownRight,
  ArrowUpRight,
  Bell,
  CheckCircle2,
  Pause,
  Play,
  Radio,
  RefreshCw,
  RotateCcw,
  Send,
  SkipForward,
  Smartphone,
  Square,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { SYMBOL_SPECS, type TradingSymbol } from '../lib/aoSimulator';
import {
  type LastStochSwitchInfo,
  type StochM1Bar,
  type StochSide,
  detectStochOnBars,
} from '../lib/stochDetector';
import {
  appendNextStochM1Bar,
  finalizeStochM1BarAndOpenNext,
  generateInitialStochM1Series,
  planNextStochM1CloseDelta,
  tickFormingStochM1Bar,
} from '../lib/stochM1Simulator';
import type { SignalLogRecord } from '../lib/sheetsApi';
import {
  play10SecondSound,
  stop10SecondSound,
  unlockAudioAlert,
} from '../lib/audioAlert';
import {
  dispatchMobileSignalNotification,
  getExistingPushSubscription,
  sendTestWebPush,
  showLocalMobileNotification,
  subscribeDeviceToWebPush,
} from '../lib/webPushClient';

export type StochM1DirectionFilter = 'both' | 'over80_only' | 'under20_only';

interface StochM1ChartViewProps {
  customPrefix: string;
  onSignalDetected: (record: SignalLogRecord) => void;
  onGoToTelegram: () => void;
  telegramSyncedReady?: boolean | null;
  isWebMode?: boolean;
}

export interface T01StateSnapshot {
  activeBias: 'BUY' | 'SELL' | null;
  biasBarIso: string | null;
  biasCloseIso: string | null;
  biasCisdLevel: number | null;
  waitingReset: boolean;
  roundCount: number;
  lastAlertBarIso: string | null;
  m15StandaloneAlerts: boolean;
}

interface LiveStochFeedResponse {
  symbol: TradingSymbol;
  timeframe: 'M1';
  source: string;
  feedProvider?: 'xm_bridge' | 'cfd_ws' | 'yahoo_fallback';
  brokerSymbol?: string;
  xmBridgeConnected?: boolean;
  cfdWsConnected?: boolean;
  marketState: string;
  fetchedAt: string;
  bars: StochM1Bar[];
  currentSide: StochSide | null;
  serverLastSide: StochSide | null;
  serverLastAlertBarIso: string | null;
  latestStochK: number | null;
  latestClosedStochK: number | null;
  lastSwitchInfo: LastStochSwitchInfo | null;
  t01State?: T01StateSnapshot;
}

interface StochAlertToast {
  id: string;
  mode: 'live' | 'sim';
  side: StochSide;
  stochK: number;
  price: number;
  cisdLevel: number | null;
  t01Round: number;
  timeLabel: string;
  telegramDelivered: boolean;
  telegramMissingToken: boolean;
  telegramError?: string;
  mobileDelivered: boolean;
}

function formatM1AxisDate(timestampIso: string): string {
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

function formatM1Countdown(): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const remaining = 60 - (nowSec % 60);
  return `00:${String(remaining === 60 ? 0 : remaining).padStart(2, '0')}`;
}

export const StochM1ChartView: React.FC<StochM1ChartViewProps> = ({
  customPrefix,
  onSignalDetected,
  onGoToTelegram,
  telegramSyncedReady,
  isWebMode = false,
}) => {
  const symbol: TradingSymbol = 'US100';
  const spec = SYMBOL_SPECS[symbol];

  const [feedMode, setFeedMode] = useState<'live' | 'sim'>('live');
  const [directionFilter, setDirectionFilter] = useState<StochM1DirectionFilter>('both');
  const [seriesState, setSeriesState] = useState(() =>
    generateInitialStochM1Series(symbol)
  );
  const [marketState, setMarketState] = useState<string>('');
  const [isLoadingLive, setIsLoadingLive] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [barCountdown, setBarCountdown] = useState<string>(() => formatM1Countdown());

  const [isPlaying, setIsPlaying] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [soundSecondsLeft, setSoundSecondsLeft] = useState(0);
  const [tickFlash, setTickFlash] = useState<'up' | 'down' | null>(null);
  const [lastTickTime, setLastTickTime] = useState<string | null>(null);
  const [simTickStep, setSimTickStep] = useState(0);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const [mobileNotifyReady, setMobileNotifyReady] = useState<boolean>(() =>
    typeof window !== 'undefined' &&
    'Notification' in window &&
    Notification.permission === 'granted'
  );
  const [mobileNotifyBusy, setMobileNotifyBusy] = useState(false);
  const [mobileNotifyHint, setMobileNotifyHint] = useState<string | null>(null);
  const [mobileNotifySuccess, setMobileNotifySuccess] = useState<string | null>(null);

  const [serverStochEnabled, setServerStochEnabled] = useState<boolean>(true);
  const [serverLastSide, setServerLastSide] = useState<StochSide | null>(null);
  const [serverLastAlertBarIso, setServerLastAlertBarIso] = useState<string | null>(null);
  const [serverTelegramConfigured, setServerTelegramConfigured] = useState<boolean | null>(
    null
  );
  const [serverTelegramMode, setServerTelegramMode] = useState<'always' | 'fallback'>(
    'always'
  );
  const [serverSubscribersCount, setServerSubscribersCount] = useState<number>(0);
  const [serverLastCheckedAt, setServerLastCheckedAt] = useState<string | null>(null);
  const [togglingServerMonitor, setTogglingServerMonitor] = useState(false);

  const [ntfyTopic, setNtfyTopic] = useState('');
  const [ntfySaving, setNtfySaving] = useState(false);
  const [ntfyFeedback, setNtfyFeedback] = useState<{
    type: 'ok' | 'err';
    text: string;
  } | null>(null);

  const [feedProvider, setFeedProvider] = useState<
    'xm_bridge' | 'cfd_ws' | 'yahoo_fallback' | null
  >(null);
  const [brokerSymbolLabel, setBrokerSymbolLabel] = useState<string>('');
  const [alertToast, setAlertToast] = useState<StochAlertToast | null>(null);
  const [simNoticeToast, setSimNoticeToast] = useState<string | null>(null);
  const [latestAlertBanner, setLatestAlertBanner] = useState<string | null>(null);
  const [t01State, setT01State] = useState<T01StateSnapshot | null>(null);

  // Sim mode Step 1 (M15 CISD bias) & Rule 1/Rule 2 state
  const [simBias, setSimBias] = useState<'BUY' | 'SELL'>('BUY');
  const [simWaitingReset, setSimWaitingReset] = useState<boolean>(false);
  const [simRoundCount, setSimRoundCount] = useState<number>(0);

  const countdownRef = useRef<number | null>(null);
  const tickFlashTimerRef = useRef<number | null>(null);
  const chartScrollRef = useRef<HTMLDivElement | null>(null);
  const userPannedChartRef = useRef<boolean>(false);
  const expectedAutoScrollRef = useRef<number | null>(null);
  const simPlanRef = useRef<{ open: number; targetClose: number; step: number } | null>(null);
  const simStepFnRef = useRef<() => void>(() => {});
  const alertedLiveBarsRef = useRef<Set<string>>(new Set());
  const lastKnownClosedIsoRef = useRef<string | undefined>(undefined);
  const activeLiveSideRef = useRef<StochSide | null>(null);
  const t01StateRef = useRef<T01StateSnapshot | null>(null);
  const liveWaitingResetRef = useRef<boolean>(false);
  const liveBiasBarIsoRef = useRef<string | null>(null);
  const simBiasRef = useRef<'BUY' | 'SELL'>(simBias);
  simBiasRef.current = simBias;
  const simWaitingResetRef = useRef<boolean>(simWaitingReset);
  simWaitingResetRef.current = simWaitingReset;
  const simRoundCountRef = useRef<number>(simRoundCount);
  simRoundCountRef.current = simRoundCount;
  const prevRolloverBucketRef = useRef<number | null>(null);
  const fetchLiveStochFnRef = useRef<
    (opts?: { updateChart?: boolean; fresh?: boolean; showSpinner?: boolean }) => Promise<void>
  >(async () => {});
  const barsRef = useRef<StochM1Bar[]>(seriesState.bars);
  barsRef.current = seriesState.bars;

  useEffect(() => {
    setBarCountdown(formatM1Countdown());
    const id = window.setInterval(() => {
      setBarCountdown(formatM1Countdown());
      if (feedMode === 'live') {
        const currBucket = Math.floor(Date.now() / 60000);
        const prev = prevRolloverBucketRef.current;
        prevRolloverBucketRef.current = currBucket;
        if (prev !== null && currBucket !== prev) {
          void fetchLiveStochFnRef.current({
            updateChart: true,
            fresh: true,
          });
        }
      } else {
        prevRolloverBucketRef.current = null;
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [feedMode]);

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
      if (tickFlashTimerRef.current !== null) {
        window.clearTimeout(tickFlashTimerRef.current);
      }
    };
  }, []);

  const trigger10sSound = useCallback(
    (signal: 'BUY' | 'SELL', forcePlay = false) => {
      if (!soundEnabled && !forcePlay) return;
      unlockAudioAlert();
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

  useEffect(() => {
    if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
      void navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
    void getExistingPushSubscription()
      .then((sub) => {
        if (
          sub ||
          (typeof window !== 'undefined' &&
            'Notification' in window &&
            Notification.permission === 'granted')
        ) {
          setMobileNotifyReady(true);
        }
      })
      .catch(() => {});
  }, []);

  const syncServerMonitorStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/monitor/status');
      if (!r.ok) return;
      const data = await r.json();
      if (typeof data.stochM1Enabled === 'boolean') {
        setServerStochEnabled(data.stochM1Enabled);
      }
      if (data.stochM1LastSide === 'OVER_80' || data.stochM1LastSide === 'UNDER_20') {
        setServerLastSide(data.stochM1LastSide);
        activeLiveSideRef.current = data.stochM1LastSide;
      } else if (data.stochM1LastSide === null) {
        setServerLastSide(null);
      }
      if (typeof data.stochM1LastAlertBarIso === 'string' || data.stochM1LastAlertBarIso === null) {
        setServerLastAlertBarIso(data.stochM1LastAlertBarIso);
      }
      if (data.t01State) {
        const nextT01 = data.t01State as T01StateSnapshot;
        t01StateRef.current = nextT01;
        setT01State(nextT01);
        if (liveBiasBarIsoRef.current !== nextT01.biasBarIso) {
          liveBiasBarIsoRef.current = nextT01.biasBarIso;
          liveWaitingResetRef.current = nextT01.waitingReset;
        } else {
          liveWaitingResetRef.current = nextT01.waitingReset;
        }
      }
      if (
        data.stochM1Direction === 'both' ||
        data.stochM1Direction === 'over80_only' ||
        data.stochM1Direction === 'under20_only'
      ) {
        setDirectionFilter(data.stochM1Direction);
      }
      if (typeof data.telegramConfigured === 'boolean') {
        setServerTelegramConfigured(data.telegramConfigured);
      }
      if (data.telegramMode === 'always' || data.telegramMode === 'fallback') {
        setServerTelegramMode(data.telegramMode);
      }
      if (typeof data.subscribersCount === 'number') {
        setServerSubscribersCount(data.subscribersCount);
      }
      if (typeof data.lastCheckedAt === 'string') {
        setServerLastCheckedAt(data.lastCheckedAt);
      }
      if (typeof data.ntfyTopic === 'string' && data.ntfyTopic) {
        setNtfyTopic((prev) => prev || data.ntfyTopic);
      }
    } catch {
      // Ignore transient polling failures
    }
  }, []);

  useEffect(() => {
    void syncServerMonitorStatus();
    const id = window.setInterval(() => {
      void syncServerMonitorStatus();
    }, 10000);
    return () => window.clearInterval(id);
  }, [syncServerMonitorStatus]);

  const emitStochAlert = useCallback(
    (
      side: StochSide,
      stochK: number,
      closePrice: number,
      timeLabel: string,
      timestampIso: string,
      mode: 'live' | 'sim',
      t01Round = 1,
      cisdLevel: number | null = null,
      skipServerNotify = false
    ) => {
      const signal: 'BUY' | 'SELL' = side === 'OVER_80' ? 'SELL' : 'BUY';
      const condLabel =
        signal === 'BUY'
          ? 'M15 CISD ขาขึ้น + M1 Stoch(15,3,3) ปิด < 20'
          : 'M15 CISD ขาลง + M1 Stoch(15,3,3) ปิด > 80';
      const roundTag = t01Round > 0 ? ` รอบ ${t01Round}` : '';

      trigger10sSound(signal);

      setLatestAlertBanner(
        `${mode === 'sim' ? '[จำลอง] ' : ''}ท่า T01 ${signal}${roundTag} · ${condLabel} (${stochK.toFixed(
          2
        )}) · ปิด ${closePrice.toFixed(spec.digits)} (${timeLabel})`
      );

      const toastId = `stoch-${mode}-${timestampIso}-${Date.now()}`;
      setSimNoticeToast(null);
      setAlertToast({
        id: toastId,
        mode,
        side,
        stochK,
        price: closePrice,
        cisdLevel,
        t01Round,
        timeLabel,
        telegramDelivered: false,
        telegramMissingToken: false,
        mobileDelivered: false,
      });

      void dispatchMobileSignalNotification({
        symbol,
        timeframe: 'M1',
        strategy: 'STOCH',
        signal,
        aoPrev: 0,
        aoCurr: 0,
        price: closePrice,
        cisdLevel,
        stochK,
        t01Round,
        mode,
        timestampIso,
        prefix: customPrefix,
        skipServerNotify,
      }).then((result) => {
        setAlertToast((prev) =>
          prev && prev.id === toastId
            ? {
                ...prev,
                telegramDelivered: skipServerNotify
                  ? true
                  : result.deliveredToTelegram,
                telegramMissingToken: Boolean(result.telegramMissingToken),
                telegramError: result.telegramError,
                mobileDelivered:
                  result.deliveredWebPushCount > 0 || result.localNotificationShown,
              }
            : prev
        );
      });

      const timeStr = new Date(timestampIso).toLocaleString('th-TH', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });

      onSignalDetected({
        id: `T01-M1-${symbol}-${timestampIso}-${signal}-R${t01Round}`,
        timestamp: timeStr,
        symbol,
        timeframe: 'M1',
        signal,
        aoPrev: signal === 'SELL' ? 80 : 20,
        aoCurr: stochK,
        price: closePrice,
        pushStatus: mode === 'live' ? `ท่า T01${roundTag}` : `จำลอง T01${roundTag}`,
        note: `${condLabel} (${stochK.toFixed(2)})`,
        syncedToSheet: false,
      });
    },
    [customPrefix, onSignalDetected, spec.digits, symbol, trigger10sSound]
  );

  const fetchLiveStochBars = useCallback(
    async (options?: {
      updateChart?: boolean;
      fresh?: boolean;
      showSpinner?: boolean;
    }) => {
      const updateChart = options?.updateChart ?? true;
      const freshParam = options?.fresh ? '&fresh=1' : '';
      const showSpinner = options?.showSpinner ?? false;
      if (updateChart && (showSpinner || barsRef.current.length === 0)) {
        setIsLoadingLive(true);
      }
      if (updateChart) {
        setLiveError(null);
      }

      try {
        const res = await fetch(
          `/api/market/stoch?symbol=${encodeURIComponent(symbol)}${freshParam}`
        );
        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          throw new Error(errBody.error || 'ดึงข้อมูลกราฟจริง M1 Stoch(15,3,3) ไม่สำเร็จ');
        }
        const data = (await res.json()) as LiveStochFeedResponse;

        if (updateChart) {
          setSeriesState({
            bars: data.bars,
            currentSide: data.currentSide,
            latestStochK: data.latestStochK,
            latestClosedStochK: data.latestClosedStochK,
            lastSwitchInfo: data.lastSwitchInfo,
          });
          setMarketState(data.marketState);
          if (data.feedProvider) setFeedProvider(data.feedProvider);
          if (data.brokerSymbol) setBrokerSymbolLabel(data.brokerSymbol);
          if (data.serverLastSide !== undefined) {
            setServerLastSide(data.serverLastSide);
            if (activeLiveSideRef.current === null && data.serverLastSide !== null) {
              activeLiveSideRef.current = data.serverLastSide;
            }
          }
          if (data.serverLastAlertBarIso !== undefined) {
            setServerLastAlertBarIso(data.serverLastAlertBarIso);
          }
          if (data.t01State) {
            setT01State(data.t01State);
            t01StateRef.current = data.t01State;
            if (liveBiasBarIsoRef.current !== data.t01State.biasBarIso) {
              liveBiasBarIsoRef.current = data.t01State.biasBarIso;
              liveWaitingResetRef.current = data.t01State.waitingReset;
            } else {
              liveWaitingResetRef.current = data.t01State.waitingReset;
            }
          }
        }

        // Closed bar is ALWAYS bars[length - 2]; also check [length - 3] if rollover skipped quickly
        const latestClosedBar = data.bars[data.bars.length - 2];
        const priorClosedBar = data.bars[data.bars.length - 3];
        const currT01 = data.t01State ?? t01StateRef.current;

        if (latestClosedBar) {
          const prevClosedIso = lastKnownClosedIsoRef.current;
          lastKnownClosedIsoRef.current = latestClosedBar.timestampIso;
          const isInitialSync = prevClosedIso === undefined;
          const isJustClosed = !isInitialSync && prevClosedIso !== latestClosedBar.timestampIso;

          // Step 1 + Step 2 ท่า T01: only evaluate M1 closed bars strictly AFTER M15 CISD close
          if (!isInitialSync && currT01 && currT01.activeBias) {
            const activeBias = currT01.activeBias;
            const biasCloseMs = currT01.biasCloseIso
              ? new Date(currT01.biasCloseIso).getTime()
              : 0;
            const candidates = isJustClosed
              ? [priorClosedBar, latestClosedBar]
              : [latestClosedBar];

            for (const closedBar of candidates) {
              if (!closedBar || closedBar.stochK === null) continue;
              const barCloseMs = new Date(closedBar.timestampIso).getTime() + 60000;
              const closeAgeMin = (Date.now() - barCloseMs) / 60000;
              if (closeAgeMin < -0.5 || closeAgeMin > 5) continue;
              if (biasCloseMs > 0 && barCloseMs <= biasCloseMs) continue;

              const serverAlreadyAlertedThisBar =
                currT01.lastAlertBarIso === closedBar.timestampIso;

              if (activeBias === 'BUY') {
                // Rule 1 reset: M1 bounced > 80 silently resets cycle for Round 2 < 20
                if (closedBar.stochK > 80 && !serverAlreadyAlertedThisBar) {
                  liveWaitingResetRef.current = false;
                  continue;
                }

                if (closedBar.stochK < 20) {
                  const shouldTrigger =
                    (isJustClosed && serverAlreadyAlertedThisBar) ||
                    (!liveWaitingResetRef.current && !serverAlreadyAlertedThisBar);
                  if (!shouldTrigger) continue;

                  const key = `T01-M1-${closedBar.timestampIso}-BUY-${currT01.biasBarIso || ''}`;
                  if (alertedLiveBarsRef.current.has(key)) continue;

                  liveWaitingResetRef.current = true;
                  activeLiveSideRef.current = 'UNDER_20';
                  setServerLastSide('UNDER_20');

                  const dirMatch =
                    directionFilter === 'both' || directionFilter === 'under20_only';
                  if (dirMatch) {
                    alertedLiveBarsRef.current.add(key);
                    const displayRound = serverAlreadyAlertedThisBar
                      ? Math.max(1, currT01.roundCount)
                      : currT01.roundCount + 1;
                    emitStochAlert(
                      'UNDER_20',
                      closedBar.stochK,
                      closedBar.close,
                      closedBar.timeLabel,
                      closedBar.timestampIso,
                      'live',
                      displayRound,
                      currT01.biasCisdLevel,
                      serverAlreadyAlertedThisBar
                    );
                  }
                }
              } else if (activeBias === 'SELL') {
                // Rule 1 reset: M1 dipped < 20 silently resets cycle for Round 2 > 80
                if (closedBar.stochK < 20 && !serverAlreadyAlertedThisBar) {
                  liveWaitingResetRef.current = false;
                  continue;
                }

                if (closedBar.stochK > 80) {
                  const shouldTrigger =
                    (isJustClosed && serverAlreadyAlertedThisBar) ||
                    (!liveWaitingResetRef.current && !serverAlreadyAlertedThisBar);
                  if (!shouldTrigger) continue;

                  const key = `T01-M1-${closedBar.timestampIso}-SELL-${currT01.biasBarIso || ''}`;
                  if (alertedLiveBarsRef.current.has(key)) continue;

                  liveWaitingResetRef.current = true;
                  activeLiveSideRef.current = 'OVER_80';
                  setServerLastSide('OVER_80');

                  const dirMatch =
                    directionFilter === 'both' || directionFilter === 'over80_only';
                  if (dirMatch) {
                    alertedLiveBarsRef.current.add(key);
                    const displayRound = serverAlreadyAlertedThisBar
                      ? Math.max(1, currT01.roundCount)
                      : currT01.roundCount + 1;
                    emitStochAlert(
                      'OVER_80',
                      closedBar.stochK,
                      closedBar.close,
                      closedBar.timeLabel,
                      closedBar.timestampIso,
                      'live',
                      displayRound,
                      currT01.biasCisdLevel,
                      serverAlreadyAlertedThisBar
                    );
                  }
                }
              }
            }
          }
        }
      } catch (err: any) {
        if (updateChart) {
          setLiveError(err?.message || 'เชื่อมต่อฟีดกราฟจริง M1 ไม่สำเร็จ');
        }
      } finally {
        if (updateChart) {
          setIsLoadingLive(false);
        }
      }
    },
    [directionFilter, emitStochAlert, symbol]
  );

  fetchLiveStochFnRef.current = fetchLiveStochBars;

  const fetchLiveTick = useCallback(async () => {
    try {
      const res = await fetch(`/api/market/tick?symbol=${encodeURIComponent(symbol)}`);
      if (!res.ok) return;
      const tick = (await res.json()) as {
        symbol: TradingSymbol;
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

      setSeriesState((prev) => {
        if (prev.bars.length === 0) return prev;
        const lastIdx = prev.bars.length - 1;
        const lastBar = prev.bars[lastIdx];
        if (tick.price !== lastBar.close) {
          setTickFlash(tick.price > lastBar.close ? 'up' : 'down');
          if (tickFlashTimerRef.current !== null) {
            window.clearTimeout(tickFlashTimerRef.current);
          }
          tickFlashTimerRef.current = window.setTimeout(() => {
            setTickFlash(null);
          }, 700);
        }
        const updatedRaw = prev.bars.map((b, idx) => {
          if (idx !== lastIdx) return b;
          return {
            ...b,
            close: tick.price,
            high: Math.max(b.high, tick.price),
            low: Math.min(b.low, tick.price),
          };
        });
        return detectStochOnBars(updatedRaw, { excludeLastBar: true });
      });
    } catch {
      // Transient tick error; 2s bar polling keeps state synced
    }
  }, [symbol]);

  useEffect(() => {
    if (feedMode !== 'live') return;
    void fetchLiveStochBars({ updateChart: true, showSpinner: true });
    const barPollId = window.setInterval(() => {
      void fetchLiveStochBars({ updateChart: true, showSpinner: false });
    }, 2000);
    const tickPollId = window.setInterval(() => {
      void fetchLiveTick();
    }, 2000);
    return () => {
      window.clearInterval(barPollId);
      window.clearInterval(tickPollId);
    };
  }, [feedMode, fetchLiveStochBars, fetchLiveTick]);

  const handleChangeFeedMode = (nextMode: 'live' | 'sim') => {
    setIsPlaying(false);
    setFeedMode(nextMode);
    setHoveredIdx(null);
    setLiveError(null);
    simPlanRef.current = null;
    setSimTickStep(0);
    if (nextMode === 'sim') {
      setSeriesState(generateInitialStochM1Series(symbol));
      setMarketState('');
    }
  };

  const handleDirectionChange = async (nextDir: StochM1DirectionFilter) => {
    setDirectionFilter(nextDir);
    try {
      await fetch('/api/monitor/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stochM1Direction: nextDir }),
      });
    } catch {
      // Non-blocking sync
    }
  };

  const handleToggleServerMonitor = async () => {
    const nextEnabled = !serverStochEnabled;
    setTogglingServerMonitor(true);
    try {
      const res = await fetch('/api/monitor/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stochM1Enabled: nextEnabled }),
      });
      if (res.ok) {
        const data = await res.json();
        setServerStochEnabled(Boolean(data.stochM1Enabled));
        if (typeof data.lastCheckedAt === 'string') {
          setServerLastCheckedAt(data.lastCheckedAt);
        }
      }
    } catch {
      // Ignore transient errors
    } finally {
      setTogglingServerMonitor(false);
    }
  };

  const handleEnableMobileNotify = async () => {
    unlockAudioAlert();
    setMobileNotifyBusy(true);
    setMobileNotifyHint(null);
    setMobileNotifySuccess(null);
    try {
      if (!serverStochEnabled) {
        await fetch('/api/monitor/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stochM1Enabled: true }),
        }).catch(() => {});
        setServerStochEnabled(true);
      }

      const sub = await subscribeDeviceToWebPush();
      setMobileNotifyReady(true);

      let pushedViaServer = false;
      try {
        await sendTestWebPush(sub.endpoint);
        pushedViaServer = true;
      } catch {
        pushedViaServer = false;
      }

      if (!pushedViaServer) {
        await showLocalMobileNotification({
          title: 'เปิดแจ้งเตือน ท่า T01 (US100 M15 + M1) สำเร็จ',
          body: 'เซิร์ฟเวอร์พร้อมแจ้งเตือนเมื่อครบ Step 1 M15 CISD + Step 2 M1 Stoch (<20 / >80)',
          tag: `stoch-mobile-ready-${Date.now()}`,
          url: '/?tab=m1',
        });
      }

      setMobileNotifySuccess(
        'เปิดแจ้งเตือนเข้ามือถือและทดสอบส่งข้อความสำเร็จแล้ว พร้อมรับสัญญาณ ท่า T01'
      );
      void syncServerMonitorStatus();
    } catch (err: any) {
      if (
        typeof window !== 'undefined' &&
        'Notification' in window &&
        Notification.permission === 'granted'
      ) {
        setMobileNotifyReady(true);
        const shown = await showLocalMobileNotification({
          title: 'เปิดแจ้งเตือน ท่า T01 (US100 M15 + M1) สำเร็จ',
          body: 'เซิร์ฟเวอร์พร้อมแจ้งเตือนเมื่อครบ Step 1 M15 CISD + Step 2 M1 Stoch (<20 / >80)',
          tag: `stoch-mobile-ready-${Date.now()}`,
          url: '/?tab=m1',
        });
        if (shown) {
          setMobileNotifySuccess('ส่งแจ้งเตือนทดสอบเข้าอุปกรณ์นี้สำเร็จแล้ว');
        }
      } else {
        const insideIframe =
          typeof window !== 'undefined' && window.self !== window.top;
        setMobileNotifyHint(
          insideIframe
            ? 'หน้าเว็บกำลังเปิดอยู่ในกรอบพรีวิว (Chrome บล็อก Popup แจ้งเตือนในกรอบ) กรุณากดเปิดเต็มจอในแท็บใหม่ แล้วกดปุ่มรับแจ้งเตือนอีกครั้ง'
            : err?.message ||
                'เบราว์เซอร์นี้ยังไม่อนุญาตแจ้งเตือน (แนะนำกดอนุญาต Notification หรือรับแจ้งเตือนผ่าน Telegram)'
        );
      }
    } finally {
      setMobileNotifyBusy(false);
    }
  };

  const handleSaveAndTestNtfy = async () => {
    setNtfySaving(true);
    setNtfyFeedback(null);
    try {
      await fetch('/api/monitor/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ntfyTopic: ntfyTopic.trim() }),
      });
      if (!ntfyTopic.trim()) {
        setNtfyFeedback({ type: 'ok', text: 'ล้างค่า ntfy Topic แล้ว' });
        return;
      }
      const res = await fetch('/api/monitor/test-push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ntfyTopic: ntfyTopic.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'ส่งทดสอบ ntfy ไม่สำเร็จ');
      }
      setNtfyFeedback({ type: 'ok', text: `ส่งทดสอบเข้า ntfy (${ntfyTopic.trim()}) สำเร็จแล้ว` });
    } catch (err: any) {
      setNtfyFeedback({ type: 'err', text: err?.message || 'เชื่อมต่อ ntfy ไม่สำเร็จ' });
    } finally {
      setNtfySaving(false);
    }
  };

  const triggerTickFlash = useCallback((prevClose: number, nextClose: number) => {
    if (nextClose === prevClose) return;
    setTickFlash(nextClose > prevClose ? 'up' : 'down');
    if (tickFlashTimerRef.current !== null) {
      window.clearTimeout(tickFlashTimerRef.current);
    }
    tickFlashTimerRef.current = window.setTimeout(() => {
      setTickFlash(null);
    }, 550);
  }, []);

  const handleSimBiasChange = (nextBias: 'BUY' | 'SELL') => {
    setSimBias(nextBias);
    simBiasRef.current = nextBias;
    // Rule 2: switching M15 CISD cancels previous waiting state immediately
    setSimWaitingReset(false);
    simWaitingResetRef.current = false;
    setSimRoundCount(0);
    simRoundCountRef.current = 0;
    const msg = `[จำลอง] M15 CISD สลับเป็นฝั่ง${
      nextBias === 'BUY'
        ? 'ขาขึ้น (BUY) → ยกเลิกฝั่งเดิม รอ M1 Stoch ปิด < 20'
        : 'ขาลง (SELL) → ยกเลิกฝั่งเดิม รอ M1 Stoch ปิด > 80'
    }`;
    setLatestAlertBanner(msg);
    setSimNoticeToast(msg);
  };

  const notifyIfSimClosedBarSwitched = useCallback(
    (closedBar: StochM1Bar | undefined, showResetToast = false) => {
      if (!closedBar || closedBar.stochK === null) return;
      const bias = simBiasRef.current;

      if (bias === 'BUY') {
        if (closedBar.stochK > 80 && simWaitingResetRef.current) {
          simWaitingResetRef.current = false;
          setSimWaitingReset(false);
          const msg = `[จำลอง] M1 Stoch เด้ง > 80 (${closedBar.stochK.toFixed(
            2
          )}) → รีเซ็ตสิทธิ์แล้ว รอย่อปิด < 20 รอบ ${simRoundCountRef.current + 1}`;
          setLatestAlertBanner(msg);
          if (showResetToast) setSimNoticeToast(msg);
          return;
        }
        if (closedBar.stochK < 20 && !simWaitingResetRef.current) {
          simWaitingResetRef.current = true;
          setSimWaitingReset(true);
          const nextRound = simRoundCountRef.current + 1;
          simRoundCountRef.current = nextRound;
          setSimRoundCount(nextRound);
          const dirMatch =
            directionFilter === 'both' || directionFilter === 'under20_only';
          if (dirMatch) {
            emitStochAlert(
              'UNDER_20',
              closedBar.stochK,
              closedBar.close,
              closedBar.timeLabel,
              closedBar.timestampIso,
              'sim',
              nextRound,
              null
            );
          }
        }
      } else {
        if (closedBar.stochK < 20 && simWaitingResetRef.current) {
          simWaitingResetRef.current = false;
          setSimWaitingReset(false);
          const msg = `[จำลอง] M1 Stoch ย่อ < 20 (${closedBar.stochK.toFixed(
            2
          )}) → รีเซ็ตสิทธิ์แล้ว รอเด้งปิด > 80 รอบ ${simRoundCountRef.current + 1}`;
          setLatestAlertBanner(msg);
          if (showResetToast) setSimNoticeToast(msg);
          return;
        }
        if (closedBar.stochK > 80 && !simWaitingResetRef.current) {
          simWaitingResetRef.current = true;
          setSimWaitingReset(true);
          const nextRound = simRoundCountRef.current + 1;
          simRoundCountRef.current = nextRound;
          setSimRoundCount(nextRound);
          const dirMatch =
            directionFilter === 'both' || directionFilter === 'over80_only';
          if (dirMatch) {
            emitStochAlert(
              'OVER_80',
              closedBar.stochK,
              closedBar.close,
              closedBar.timeLabel,
              closedBar.timestampIso,
              'sim',
              nextRound,
              null
            );
          }
        }
      }
    },
    [directionFilter, emitStochAlert]
  );

  const advanceBar = (forceTarget?: StochSide) => {
    simPlanRef.current = null;
    setSimTickStep(0);

    // Manual test buttons ("ทดสอบ > 80" / "ทดสอบ < 20") should always respond immediately:
    // If waiting for reset on the opposite bias, it performs the reset; if idle on the opposite bias, switch M15 bias to test that direction.
    if (forceTarget === 'OVER_80' && simBiasRef.current === 'BUY' && !simWaitingResetRef.current) {
      setSimBias('SELL');
      simBiasRef.current = 'SELL';
      setSimWaitingReset(false);
      simWaitingResetRef.current = false;
      setSimRoundCount(0);
      simRoundCountRef.current = 0;
    } else if (
      forceTarget === 'UNDER_20' &&
      simBiasRef.current === 'SELL' &&
      !simWaitingResetRef.current
    ) {
      setSimBias('BUY');
      simBiasRef.current = 'BUY';
      setSimWaitingReset(false);
      simWaitingResetRef.current = false;
      setSimRoundCount(0);
      simRoundCountRef.current = 0;
    }

    const prevBars = barsRef.current;
    const prevLast = prevBars[prevBars.length - 1];
    const prevLastClosedIso = prevBars[prevBars.length - 2]?.timestampIso;

    const nextResult = appendNextStochM1Bar(prevBars, symbol, forceTarget);
    barsRef.current = nextResult.bars;
    setSeriesState(nextResult);

    const endClosedIdx = nextResult.bars.length - 2;
    const latestClosed = nextResult.bars[endClosedIdx];
    if (prevLast && latestClosed) {
      triggerTickFlash(prevLast.close, latestClosed.close);
    }

    // Evaluate every newly closed bar in order so intermediate >80 / <20 bars reset Round 2 properly
    const prevClosedIdx = prevLastClosedIso
      ? nextResult.bars.findIndex((b) => b.timestampIso === prevLastClosedIso)
      : -1;
    const startIdx = prevClosedIdx >= 0 ? prevClosedIdx + 1 : endClosedIdx;
    for (let idx = startIdx; idx <= endClosedIdx; idx++) {
      const isFinalBar = idx === endClosedIdx;
      notifyIfSimClosedBarSwitched(nextResult.bars[idx], Boolean(forceTarget && isFinalBar));
    }
  };

  const stepSimTick = () => {
    const currentBars = barsRef.current;
    if (currentBars.length === 0) return;
    const openBar = currentBars[currentBars.length - 1];

    if (!simPlanRef.current) {
      const delta = planNextStochM1CloseDelta(openBar.timestampIso, symbol);
      simPlanRef.current = {
        open: openBar.open,
        targetClose: openBar.open + delta,
        step: 1,
      };
    }

    const plan = simPlanRef.current;
    const delta = plan.targetClose - plan.open;

    if (plan.step < 4) {
      const fraction = plan.step === 1 ? 0.35 : plan.step === 2 ? 1.1 : 0.86;
      const intrabarPrice = plan.open + delta * fraction;
      triggerTickFlash(openBar.close, intrabarPrice);
      const ticked = tickFormingStochM1Bar(currentBars, intrabarPrice, symbol);
      barsRef.current = ticked.bars;
      setSeriesState(ticked);
      setSimTickStep(plan.step);
      plan.step += 1;
      return;
    }

    triggerTickFlash(openBar.close, plan.targetClose);
    const closedResult = finalizeStochM1BarAndOpenNext(
      currentBars,
      plan.targetClose,
      symbol
    );
    barsRef.current = closedResult.bars;
    setSeriesState(closedResult);
    simPlanRef.current = null;
    setSimTickStep(0);

    const newlyClosedBar = closedResult.bars[closedResult.bars.length - 2];
    notifyIfSimClosedBarSwitched(newlyClosedBar);
  };

  simStepFnRef.current = stepSimTick;

  useEffect(() => {
    if (feedMode !== 'sim' || !isPlaying) return;
    const timer = window.setInterval(() => {
      simStepFnRef.current();
    }, 280);
    return () => window.clearInterval(timer);
  }, [feedMode, isPlaying]);

  const visibleSliceCount = 72;
  const visibleStartIdx = Math.max(0, seriesState.bars.length - visibleSliceCount);
  const visibleBars = useMemo(
    () => seriesState.bars.slice(visibleStartIdx),
    [seriesState.bars, visibleStartIdx]
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

  // SVG Layout: Upper Candlestick Pane + Lower Stoch(15,3,3) Pane
  const svgW = 860;
  const priceTopY = 8;
  const priceH = 260;
  const stochTopY = 278;
  const stochH = 148;
  const xAxisY = stochTopY + stochH;
  const totalH = xAxisY + 26;

  const padL = 8;
  const padR = 88;
  const plotLeft = padL;
  const plotRight = svgW - padR;
  const totalPlotW = plotRight - plotLeft;

  const activeCandlesW = totalPlotW * 0.72;
  const slotW = activeCandlesW / Math.max(1, visibleBars.length);
  const candleW = Math.max(3.0, Math.min(5.4, slotW * 0.6));

  useEffect(() => {
    userPannedChartRef.current = false;
  }, [feedMode]);

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
  }, [feedMode, visibleBars.length, plotLeft, slotW, svgW]);

  const priceToY = (p: number) => {
    const ratio =
      (chartMetrics.priceTop - p) / (chartMetrics.priceTop - chartMetrics.priceBottom);
    return priceTopY + 12 + ratio * (priceH - 24);
  };

  const stochToY = (val: number) => {
    const clamped = Math.max(0, Math.min(100, val));
    return stochTopY + 14 + ((100 - clamped) / 100) * (stochH - 22);
  };

  const stochKPoints = useMemo(() => {
    const pts: string[] = [];
    visibleBars.forEach((b, idx) => {
      if (b.stochK === null) return;
      const xCenter = plotLeft + 6 + idx * slotW + slotW / 2;
      const y = stochToY(b.stochK);
      pts.push(`${xCenter.toFixed(1)},${y.toFixed(1)}`);
    });
    return pts.join(' ');
  }, [visibleBars, plotLeft, slotW]);

  const latestCloseY = latestFormingBar ? priceToY(latestFormingBar.close) : priceH / 2;
  const priceTickRatios = [0.06, 0.25, 0.44, 0.63, 0.82];

  const effectiveTelegramConfigured =
    serverTelegramConfigured ?? telegramSyncedReady ?? false;

  const activeStochVal = activeBar?.stochK ?? seriesState.latestStochK;
  const effectiveDisplaySide =
    feedMode === 'live' ? serverLastSide ?? seriesState.currentSide : seriesState.currentSide;

  return (
    <section className="space-y-5">
      {/* Control Toolbar matching clean mobile/desktop layout */}
      <div className="rounded-2xl border border-slate-200/90 bg-white p-4 sm:p-5 space-y-3.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Live vs Sim Switch (M1 only, no M5 toggle) */}
          <div className="flex items-center gap-1 rounded-xl bg-slate-100 p-1">
            <button
              type="button"
              onClick={() => handleChangeFeedMode('live')}
              className={`inline-flex h-9 items-center gap-1.5 rounded-lg px-3.5 text-[13px] font-medium whitespace-nowrap shrink-0 transition-colors ${
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
              className={`h-9 rounded-lg px-3.5 text-[13px] font-medium whitespace-nowrap shrink-0 transition-colors ${
                feedMode === 'sim'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              จำลอง
            </button>
          </div>

          <div className="flex items-center gap-2 text-[13px] text-slate-600">
            <span className="font-semibold text-blue-600">US100</span>
            <span aria-hidden="true" className="text-slate-300">·</span>
            <span className="font-medium text-slate-700">M1 · Stoch(15,3,3)</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {feedMode === 'sim' && (
            <div className="flex items-center gap-1 rounded-xl bg-slate-100 p-1">
              <button
                type="button"
                onClick={() => handleSimBiasChange('BUY')}
                className={`h-9 rounded-lg px-3 text-xs font-semibold whitespace-nowrap shrink-0 transition-colors ${
                  simBias === 'BUY'
                    ? 'bg-emerald-600 text-white shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                M15 CISD ขึ้น (รอ &lt; 20)
              </button>
              <button
                type="button"
                onClick={() => handleSimBiasChange('SELL')}
                className={`h-9 rounded-lg px-3 text-xs font-semibold whitespace-nowrap shrink-0 transition-colors ${
                  simBias === 'SELL'
                    ? 'bg-rose-600 text-white shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                M15 CISD ลง (รอ &gt; 80)
              </button>
            </div>
          )}

          {feedMode === 'live' ? (
            <button
              type="button"
              onClick={() =>
                void fetchLiveStochBars({ updateChart: true, fresh: true })
              }
              disabled={isLoadingLive}
              className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 text-[13px] font-medium text-slate-700 whitespace-nowrap shrink-0 transition-colors hover:bg-slate-50 disabled:opacity-50"
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
                onClick={() => {
                  unlockAudioAlert();
                  advanceBar('OVER_80');
                }}
                className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-rose-600 px-3.5 text-[13px] font-medium text-white whitespace-nowrap shrink-0 transition-colors hover:bg-rose-700"
              >
                <ArrowUpRight className="h-4 w-4" />
                ทดสอบ &gt; 80
              </button>

              <button
                type="button"
                onClick={() => {
                  unlockAudioAlert();
                  advanceBar('UNDER_20');
                }}
                className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-emerald-600 px-3.5 text-[13px] font-medium text-white whitespace-nowrap shrink-0 transition-colors hover:bg-emerald-700"
              >
                <ArrowDownRight className="h-4 w-4" />
                ทดสอบ &lt; 20
              </button>

              <button
                type="button"
                onClick={() => {
                  unlockAudioAlert();
                  setIsPlaying((p) => !p);
                }}
                className={`inline-flex h-10 items-center gap-1.5 rounded-xl px-3.5 text-[13px] font-medium whitespace-nowrap shrink-0 transition-colors ${
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
                onClick={() => {
                  unlockAudioAlert();
                  advanceBar();
                }}
                className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 text-[13px] font-medium text-slate-700 whitespace-nowrap shrink-0 transition-colors hover:bg-slate-50"
              >
                <SkipForward className="h-3.5 w-3.5" />
                +1 แท่ง
              </button>

              <button
                type="button"
                onClick={() => {
                  setIsPlaying(false);
                  simPlanRef.current = null;
                  setSimTickStep(0);
                  setSimWaitingReset(false);
                  simWaitingResetRef.current = false;
                  setSimRoundCount(0);
                  simRoundCountRef.current = 0;
                  stopAudioAndTimer();
                  setSeriesState(generateInitialStochM1Series(symbol));
                }}
                aria-label="รีเซ็ตกราฟ M1"
                className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-800"
              >
                <RotateCcw className="h-4 w-4" />
              </button>
            </>
          )}

          <button
            type="button"
            onClick={() => {
              unlockAudioAlert();
              if (soundEnabled) stopAudioAndTimer();
              setSoundEnabled((s) => !s);
            }}
            aria-label="สลับเสียงเตือน 10 วินาที"
            className={`inline-flex h-10 items-center gap-1.5 rounded-xl border px-3.5 text-[13px] font-medium whitespace-nowrap shrink-0 transition-colors ${
              soundEnabled
                ? 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                : 'border-slate-200 bg-slate-100 text-slate-500'
            }`}
          >
            {soundEnabled ? (
              <Volume2 className="h-4 w-4 text-blue-600" />
            ) : (
              <VolumeX className="h-4 w-4" />
            )}
            เสียง 10 วิ
          </button>

          {!isWebMode && (
            <button
              type="button"
              onClick={() => {
                unlockAudioAlert();
                setSoundEnabled(true);
                trigger10sSound('SELL', true);
              }}
              className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-blue-200 bg-blue-50/70 px-3.5 text-[13px] font-medium text-blue-700 whitespace-nowrap shrink-0 transition-colors hover:bg-blue-100"
            >
              <Bell className="h-3.5 w-3.5" />
              ทดสอบเสียง
            </button>
          )}

          <select
            aria-label="เงื่อนไขทิศทาง ท่า T01"
            value={directionFilter}
            onChange={(e) =>
              void handleDirectionChange(e.target.value as StochM1DirectionFilter)
            }
            className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-[13px] font-medium text-slate-700 focus:border-blue-600 focus:outline-none"
          >
            <option value="both">ท่า T01 ทั้ง BUY &amp; SELL</option>
            <option value="under20_only">เฉพาะ BUY (M15 ขึ้น + M1 &lt; 20)</option>
            <option value="over80_only">เฉพาะ SELL (M15 ลง + M1 &gt; 80)</option>
          </select>

          {soundSecondsLeft > 0 && (
            <button
              type="button"
              onClick={stopAudioAndTimer}
              className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-amber-600 px-3.5 text-[13px] font-medium text-white whitespace-nowrap shrink-0 transition-colors hover:bg-amber-700"
            >
              <Square className="h-3.5 w-3.5" />
              หยุด ({soundSecondsLeft}s)
            </button>
          )}
        </div>
      </div>

      {simNoticeToast && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-sky-200 bg-sky-50 px-4 py-2.5 text-xs font-medium text-sky-900">
          <span>{simNoticeToast}</span>
          <button
            type="button"
            onClick={() => setSimNoticeToast(null)}
            aria-label="ปิดข้อความสถานะจำลอง"
            className="rounded p-1 text-sky-700 hover:bg-sky-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {alertToast && (
        <div
          className={`flex flex-wrap items-start justify-between gap-3 rounded-xl border px-4 py-3 text-xs shadow-xs ${
            alertToast.side === 'UNDER_20'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-950'
              : 'border-rose-200 bg-rose-50 text-rose-950'
          }`}
        >
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2 font-semibold text-[13px]">
              {alertToast.side === 'UNDER_20' ? (
                <ArrowDownRight className="h-4 w-4 text-emerald-700" />
              ) : (
                <ArrowUpRight className="h-4 w-4 text-rose-700" />
              )}
              <span>
                {alertToast.mode === 'sim' ? '[จำลอง] ' : '[กราฟจริง] '}
                ท่า T01 {alertToast.side === 'UNDER_20' ? 'BUY' : 'SELL'} (รอบ {alertToast.t01Round}) ·{' '}
                {alertToast.side === 'UNDER_20' ? 'M15 ขึ้น + M1 < 20' : 'M15 ลง + M1 > 80'} (Stoch{' '}
                {alertToast.stochK.toFixed(2)}) · ปิด {alertToast.price.toFixed(spec.digits)}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-[11px]">
              <span className="inline-flex items-center gap-1">
                {alertToast.telegramDelivered ? (
                  <>
                    <CheckCircle2 className="h-3.5 w-3.5 text-sky-600" />
                    <span className="text-sky-800 font-medium">
                      ส่งเข้า Telegram (8217822307) แล้ว
                    </span>
                  </>
                ) : alertToast.telegramMissingToken ? (
                  <button
                    type="button"
                    onClick={onGoToTelegram}
                    className="inline-flex items-center gap-1 font-semibold text-rose-700 underline"
                  >
                    <AlertCircle className="h-3.5 w-3.5" />
                    ยังไม่ได้ใส่ Bot Token (คลิกเพื่อตั้งค่า Telegram)
                  </button>
                ) : (
                  <span className="text-slate-600">
                    {alertToast.telegramError || 'กำลังส่งเข้า Telegram...'}
                  </span>
                )}
              </span>
              <span className="text-slate-300">·</span>
              <span className="inline-flex items-center gap-1 text-slate-700">
                <Smartphone className="h-3.5 w-3.5" />
                {alertToast.mobileDelivered
                  ? 'เด้งแจ้งเตือนมือถือแล้ว'
                  : 'เสียงเตือน 10 วิทำงานแล้ว'}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setAlertToast(null)}
            aria-label="ปิดการแจ้งเตือน"
            className="rounded p-1 text-slate-500 hover:bg-black/5 hover:text-slate-800"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {liveError && feedMode === 'live' && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-2.5 text-xs text-rose-800">
          {liveError}
        </div>
      )}

      {/* Dark MT5 Chart Container + Stoch(15,3,3) Sub-Pane */}
      <div className="flex flex-col rounded-2xl border border-slate-800 bg-[#05080f] p-3.5 sm:p-4 text-neutral-200 shadow-sm">
        {/* Top Telemetry Header */}
        <div className="mb-2.5 space-y-1.5 border-b border-slate-800/80 px-1 pb-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-blue-400">US100 · M1 · ท่า T01</span>
              <span aria-hidden="true" className="text-slate-600">·</span>
              {feedMode === 'live' ? (
                <span className="text-slate-300 tabular-nums">
                  {marketState === 'MARKET CLOSED'
                    ? 'ตลาดปิด (ล่าสุด)'
                    : feedProvider === 'xm_bridge'
                    ? `XM MT5 Bridge · อัปเดตทุก 2 วิ${lastTickTime ? ` (${lastTickTime})` : ''}`
                    : feedProvider === 'cfd_ws'
                    ? `MT5 CFD${brokerSymbolLabel ? ` (${brokerSymbolLabel})` : ''} · อัปเดตทุก 2 วิ${
                        lastTickTime ? ` (${lastTickTime})` : ''
                      }`
                    : `MT5 เรียลไทม์ · อัปเดตทุก 2 วิ${lastTickTime ? ` (${lastTickTime})` : ''}`}
                </span>
              ) : (
                <span className="text-amber-300 tabular-nums">
                  {isPlaying
                    ? `โหมดจำลอง (${Math.max(1, simTickStep)}/4 รอปิดแท่ง M1)`
                    : 'โหมดจำลอง ท่า T01 (M15 + M1)'}
                </span>
              )}
            </div>

            <span className="font-mono text-[11px] tabular-nums">
              {feedMode === 'live' ? (
                t01State?.activeBias === 'BUY' ? (
                  <span className="text-emerald-400">
                    Step 1: M15 CISD ขึ้น
                    {t01State.biasCisdLevel !== null
                      ? ` (${t01State.biasCisdLevel.toFixed(spec.digits)})`
                      : ''}{' '}
                    · Step 2:{' '}
                    {t01State.waitingReset
                      ? `เตือนรอบ ${t01State.roundCount} แล้ว (รอ > 80 รีเซ็ต)`
                      : `รอ M1 < 20${
                          t01State.roundCount > 0 ? ` (รอบ ${t01State.roundCount + 1})` : ''
                        }`}
                  </span>
                ) : t01State?.activeBias === 'SELL' ? (
                  <span className="text-rose-400">
                    Step 1: M15 CISD ลง
                    {t01State.biasCisdLevel !== null
                      ? ` (${t01State.biasCisdLevel.toFixed(spec.digits)})`
                      : ''}{' '}
                    · Step 2:{' '}
                    {t01State.waitingReset
                      ? `เตือนรอบ ${t01State.roundCount} แล้ว (รอ < 20 รีเซ็ต)`
                      : `รอ M1 > 80${
                          t01State.roundCount > 0 ? ` (รอบ ${t01State.roundCount + 1})` : ''
                        }`}
                  </span>
                ) : (
                  <span className="text-slate-400">
                    Step 1: รอ M15 ปิดยืนยัน CISD ขึ้น/ลง
                  </span>
                )
              ) : (
                <span className={simBias === 'BUY' ? 'text-emerald-400' : 'text-rose-400'}>
                  Sim Step 1: M15 {simBias === 'BUY' ? 'ขึ้น' : 'ลง'} · Step 2:{' '}
                  {simWaitingReset
                    ? `เตือนรอบ ${simRoundCount} แล้ว (รอ ${
                        simBias === 'BUY' ? '> 80' : '< 20'
                      } รีเซ็ต)`
                    : `รอ M1 ${simBias === 'BUY' ? '< 20' : '> 80'} (รอบ ${simRoundCount + 1})`}
                </span>
              )}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-3 font-mono text-xs tabular-nums">
            <span className="text-slate-400">{activeBar?.timeLabel || '--:--'}</span>
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
            <span className="font-semibold text-teal-400">
              Stoch {activeStochVal !== null ? activeStochVal.toFixed(2) : '—'}
            </span>
            {activeBar?.stochSwitchSide && (
              <span
                className={`font-semibold ${
                  activeBar.stochSwitchSide === 'OVER_80'
                    ? 'text-rose-400'
                    : 'text-emerald-400'
                }`}
              >
                {activeBar.stochSwitchSide === 'OVER_80'
                  ? 'สลับฝั่งปิด > 80'
                  : 'สลับฝั่งปิด < 20'}
              </span>
            )}
          </div>
        </div>

        {/* Dual-Pane Candlestick + Stoch(15,3,3) SVG */}
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
            aria-label="กราฟแท่งเทียน US100 M1 และ Stoch(15,3,3) สำหรับระบบ ท่า T01"
          >
            <rect x={0} y={0} width={svgW} height={totalH} fill="#05080f" />

            {/* Right Y-axis border */}
            <line
              x1={plotRight}
              y1={priceTopY}
              x2={plotRight}
              y2={xAxisY}
              stroke="#1e293b"
              strokeWidth="1"
            />

            {/* Price Y-axis Ticks */}
            {priceTickRatios.map((ratio, idx) => {
              const y = priceTopY + 12 + ratio * (priceH - 24);
              const priceVal =
                chartMetrics.priceTop -
                ratio * (chartMetrics.priceTop - chartMetrics.priceBottom);
              return (
                <g key={`m1-p-tick-${idx}`}>
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
                ▾ M1
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
                  key={`candle-${bar.timestampIso}-${idx}`}
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
                        {formatM1AxisDate(bar.timestampIso)}
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
                    {feedMode === 'live'
                      ? barCountdown
                      : isPlaying
                      ? `00:${String(Math.max(1, 4 - simTickStep) * 3).padStart(2, '0')}`
                      : 'SIM'}
                  </text>
                </g>
              </>
            )}

            {/* Separator between Price Pane & Stoch(15,3,3) Pane */}
            <line
              x1={plotLeft}
              y1={stochTopY - 4}
              x2={plotRight}
              y2={stochTopY - 4}
              stroke="#1e293b"
              strokeWidth="1"
            />

            {/* Stoch(15,3,3) Sub-pane Label */}
            <text
              x={plotLeft + 8}
              y={stochTopY + 12}
              fontSize="11.5"
              fill="#94a3b8"
              className="font-sans"
            >
              Stoch(15,3,3){' '}
              <tspan fill="#2dd4bf" fontWeight="600" className="font-mono tabular-nums">
                {activeStochVal !== null ? activeStochVal.toFixed(2) : ''}
              </tspan>
            </text>

            {/* Stoch 80.00 & 20.00 Horizontal Dashed Lines */}
            {[80, 20].map((level) => {
              const yLvl = stochToY(level);
              return (
                <g key={`stoch-lvl-${level}`}>
                  <line
                    x1={plotLeft}
                    y1={yLvl}
                    x2={plotRight}
                    y2={yLvl}
                    stroke="#334155"
                    strokeWidth="1"
                    strokeDasharray="3 3"
                  />
                  <text
                    x={plotRight + 8}
                    y={yLvl + 3.5}
                    fontSize="11"
                    fill="#94a3b8"
                    className="font-mono tabular-nums"
                  >
                    {level.toFixed(2)}
                  </text>
                </g>
              );
            })}

            {/* Stoch %K Teal Line */}
            {stochKPoints && (
              <polyline
                fill="none"
                stroke="#14b8a6"
                strokeWidth="1.75"
                strokeLinejoin="round"
                strokeLinecap="round"
                points={stochKPoints}
              />
            )}

            {/* Single Side-Switch Dots ONLY on closed switch bars (Red = >80, Green = <20; active T01 entry side gets outer highlight) */}
            {visibleBars.map((bar, idx) => {
              if (!bar.stochSwitchSide || bar.stochK === null) return null;
              const xCenter = plotLeft + 6 + idx * slotW + slotW / 2;
              const yDot = stochToY(bar.stochK);
              const isOver80 = bar.stochSwitchSide === 'OVER_80';
              const activeBias =
                feedMode === 'live' ? t01State?.activeBias ?? null : simBias;
              const matchesActiveBias =
                (activeBias === 'BUY' && !isOver80) ||
                (activeBias === 'SELL' && isOver80);
              return (
                <g key={`switch-dot-${bar.timestampIso}-${idx}`}>
                  {matchesActiveBias && (
                    <circle
                      cx={xCenter}
                      cy={yDot}
                      r={6.4}
                      fill="none"
                      stroke={isOver80 ? '#fb7185' : '#4ade80'}
                      strokeWidth="1.2"
                      opacity={0.75}
                    />
                  )}
                  <circle
                    cx={xCenter}
                    cy={yDot}
                    r={matchesActiveBias ? 4.0 : 3.0}
                    fill={isOver80 ? '#ef4444' : '#22c55e'}
                    stroke="#05080f"
                    strokeWidth="1.2"
                    opacity={matchesActiveBias || !activeBias ? 1 : 0.65}
                  />
                </g>
              );
            })}

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

      {/* Bottom Alert Status Card matching reference screenshot */}
      <div className="rounded-2xl border border-slate-200/90 bg-white p-4 sm:p-5 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-base font-semibold text-slate-900">
            <Smartphone className="h-4 w-4 text-slate-700" />
            <span>แจ้งเตือน ท่า T01 (M15 CISD + M1 Stoch)</span>
          </div>
          <span className="font-mono text-xs font-medium text-slate-500">
            {feedMode === 'live' ? 'Live M1' : 'Sim M1'}
          </span>
        </div>

        {/* Dark Alert Status Box */}
        <div className="rounded-xl bg-[#0d1629] px-4 py-4 text-sm leading-relaxed text-slate-200">
          {latestAlertBanner ? (
            latestAlertBanner
          ) : feedMode === 'live' ? (
            t01State?.activeBias === 'BUY' ? (
              t01State.waitingReset ? (
                `Step 1: M15 CISD ขาขึ้น (${
                  t01State.biasCisdLevel !== null
                    ? t01State.biasCisdLevel.toFixed(spec.digits)
                    : '-'
                }) · แจ้งเตือน BUY รอบ ${t01State.roundCount} แล้ว · กำลังรอ M1 เด้ง > 80 เพื่อรีเซ็ตรอบ ${
                  t01State.roundCount + 1
                }`
              ) : (
                `Step 1: M15 CISD ขาขึ้น (${
                  t01State.biasCisdLevel !== null
                    ? t01State.biasCisdLevel.toFixed(spec.digits)
                    : '-'
                }) พร้อมแล้ว · Step 2: กำลังรอแท่ง M1 ปิด Stoch < 20${
                  t01State.roundCount > 0 ? ` (รอบ ${t01State.roundCount + 1})` : ''
                }`
              )
            ) : t01State?.activeBias === 'SELL' ? (
              t01State.waitingReset ? (
                `Step 1: M15 CISD ขาลง (${
                  t01State.biasCisdLevel !== null
                    ? t01State.biasCisdLevel.toFixed(spec.digits)
                    : '-'
                }) · แจ้งเตือน SELL รอบ ${t01State.roundCount} แล้ว · กำลังรอ M1 ย่อ < 20 เพื่อรีเซ็ตรอบ ${
                  t01State.roundCount + 1
                }`
              ) : (
                `Step 1: M15 CISD ขาลง (${
                  t01State.biasCisdLevel !== null
                    ? t01State.biasCisdLevel.toFixed(spec.digits)
                    : '-'
                }) พร้อมแล้ว · Step 2: กำลังรอแท่ง M1 ปิด Stoch > 80${
                  t01State.roundCount > 0 ? ` (รอบ ${t01State.roundCount + 1})` : ''
                }`
              )
            ) : (
              'Step 1: กำลังรอแท่ง M15 ปิดยืนยัน CISD ขึ้นหรือลง ก่อนเปิดรอจังหวะ M1 Stoch < 20 / > 80'
            )
          ) : (
            `โหมดจำลอง ท่า T01 (M15 ${
              simBias === 'BUY' ? 'CISD ขึ้น → รอ M1 < 20' : 'CISD ลง → รอ M1 > 80'
            }) — กดทดสอบ < 20 หรือ > 80 เพื่อทดสอบรอบ 1, รีเซ็ต และรอบ 2`
          )}
        </div>

        {/* Server Auto-Monitor Toggle */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <Radio
              className={`h-4 w-4 shrink-0 ${
                serverStochEnabled ? 'text-emerald-600' : 'text-slate-400'
              }`}
            />
            <span className="text-sm font-semibold text-slate-900 truncate">
              เซิร์ฟเวอร์เฝ้ากราฟ ท่า T01 (M15 + M1) อัตโนมัติ
            </span>
          </div>

          <button
            type="button"
            disabled={togglingServerMonitor}
            onClick={() => void handleToggleServerMonitor()}
            className={`shrink-0 text-xs font-semibold transition-colors disabled:opacity-50 ${
              serverStochEnabled
                ? 'text-emerald-700 hover:text-emerald-800'
                : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            {togglingServerMonitor
              ? 'กำลังสลับ...'
              : serverStochEnabled
              ? 'กำลังทำงาน'
              : 'พักชั่วคราว'}
          </button>
        </div>

        {/* Blue Mobile Push CTA */}
        <button
          type="button"
          disabled={mobileNotifyBusy}
          onClick={() => void handleEnableMobileNotify()}
          className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-60"
        >
          <Bell className="h-4 w-4 shrink-0" />
          {mobileNotifyBusy
            ? 'กำลังเชื่อมต่อแจ้งเตือนเข้ามือถือ...'
            : mobileNotifyReady
            ? 'รับแจ้งเตือนเข้ามือถือ (เปิดอยู่ · กดทดสอบ)'
            : 'รับแจ้งเตือนเข้ามือถือ (ไม่ต้องลงแอป)'}
        </button>

        {mobileNotifySuccess && (
          <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
            <span>{mobileNotifySuccess}</span>
          </div>
        )}

        {mobileNotifyHint && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <span>{mobileNotifyHint}</span>
            {typeof window !== 'undefined' && window.self !== window.top && (
              <a
                href={window.location.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-7 items-center rounded-md bg-amber-600 px-2.5 text-[11px] font-semibold text-white hover:bg-amber-700"
              >
                เปิดเต็มจอในแท็บใหม่
              </a>
            )}
          </div>
        )}

        {/* Telegram Connection Row */}
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs pt-0.5">
          <div className="flex items-center gap-1.5">
            <span className="text-slate-500">Telegram:</span>
            <span
              className={`font-semibold ${
                effectiveTelegramConfigured ? 'text-emerald-700' : 'text-amber-700'
              }`}
            >
              {effectiveTelegramConfigured
                ? serverTelegramMode === 'always'
                  ? 'เชื่อมต่อแล้ว (ส่งทุกสัญญาณ)'
                  : 'เชื่อมต่อแล้ว (สำรอง)'
                : 'ยังไม่ใส่ Bot Token (แชท 8217822307)'}
            </span>
          </div>

          <button
            type="button"
            onClick={onGoToTelegram}
            className="inline-flex items-center gap-1 font-semibold text-blue-600 hover:underline"
          >
            <Send className="h-3.5 w-3.5" />
            ตั้งค่า Telegram
          </button>
        </div>

        {/* Secondary Channel: ntfy */}
        <details className="border-t border-slate-100 pt-3 text-xs text-slate-600">
          <summary className="cursor-pointer select-none font-medium text-slate-700 hover:text-slate-900">
            ช่องทางเสริม: ntfy (เลือกเสียง 10 วิได้)
          </summary>
          <div className="mt-3 space-y-2.5">
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                type="text"
                value={ntfyTopic}
                onChange={(e) => setNtfyTopic(e.target.value)}
                placeholder="เช่น us100-m1-alert"
                className="h-9 flex-1 rounded-lg border border-slate-200 px-3 font-mono text-xs text-slate-900 focus:border-blue-600 focus:outline-none"
              />
              <button
                type="button"
                disabled={ntfySaving}
                onClick={() => void handleSaveAndTestNtfy()}
                className="inline-flex h-9 shrink-0 items-center justify-center rounded-lg bg-slate-900 px-3.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
              >
                {ntfySaving ? 'กำลังส่ง...' : 'บันทึก & ทดสอบ ntfy'}
              </button>
            </div>
            {ntfyFeedback && (
              <p
                className={
                  ntfyFeedback.type === 'ok' ? 'text-emerald-700' : 'text-rose-700'
                }
              >
                {ntfyFeedback.text}
              </p>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
              <span>
                {serverSubscribersCount > 0
                  ? `อุปกรณ์รับ Web Push เชื่อมต่ออยู่ ${serverSubscribersCount} เครื่อง`
                  : 'แจ้งเตือน 1 ครั้งต่อฝั่ง (>80 รอปิด <20 จึงจะเตือนซ้ำได้)'}
              </span>
              {serverLastCheckedAt && (
                <span className="font-mono tabular-nums">
                  สแกนล่าสุด{' '}
                  {new Date(serverLastCheckedAt).toLocaleTimeString('th-TH', {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    hour12: false,
                    timeZone: 'Asia/Bangkok',
                  })}
                </span>
              )}
            </div>
          </div>
        </details>
      </div>
    </section>
  );
};
