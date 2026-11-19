import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AoChartPanel,
  type AlertDirectionFilter,
} from './components/AoChartPanel';
import { TelegramSettingsModal } from './components/TelegramSettingsModal';
import { ServerSyncPanel } from './components/ServerSyncPanel';
import { playAlertChime } from './lib/soundAlert';
import {
  buildSimulatedM5Raw,
  createSignalFromSeries,
  formatSignedAo,
  getTwoSwingStepInfo,
  rawToCandlesWithAO,
  stepSimStream,
  type SimStreamState,
} from './lib/aoEngine';
import type {
  CandleWithAO,
  ChartMode,
  GitHubConfigState,
  LiveHistoricalCross,
  LiveMarketResponse,
  SignalDirection,
  SignalRecord,
  TelegramConfigState,
  TradingSymbol,
} from './types/trading';

const TELEGRAM_STORAGE_KEY = 'us100_ao_telegram_config_v1';
const LIVE_ALERTED_KEY_STORAGE = 'us100_ao_last_live_alert_key_v1';

function toLocalHm(iso: string, fallback: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return fallback;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function loadSavedTelegramConfig(): Omit<
  TelegramConfigState,
  'serverTokenConfigured' | 'maskedToken' | 'botUsername'
> {
  const defaults: Omit<
    TelegramConfigState,
    'serverTokenConfigured' | 'maskedToken' | 'botUsername'
  > = {
    enabled: true,
    chatId: '-1004382980885',
    parseMode: 'HTML',
    sendCondition: 'always',
    autoSendLive: true,
    autoSendSim: true,
    customTag: '',
  };
  if (typeof window === 'undefined') return defaults;
  try {
    const raw = window.localStorage.getItem(TELEGRAM_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<TelegramConfigState>;
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : defaults.enabled,
      chatId:
        typeof parsed.chatId === 'string' && parsed.chatId.trim()
          ? parsed.chatId.trim()
          : defaults.chatId,
      parseMode: parsed.parseMode === 'Markdown' ? 'Markdown' : 'HTML',
      sendCondition: parsed.sendCondition === 'fallback' ? 'fallback' : 'always',
      autoSendLive: true,
      autoSendSim: true,
      customTag: typeof parsed.customTag === 'string' ? parsed.customTag : '',
    };
  } catch {
    return defaults;
  }
}

export default function App() {
  const symbol: TradingSymbol = 'US100';
  const [activePage, setActivePage] = useState<'chart' | 'server'>('chart');
  const [chartMode, setChartMode] = useState<ChartMode>('live');

  const simStreamRef = useRef<SimStreamState>({
    raw: buildSimulatedM5Raw('US100', 'neutral', 1),
    tickInBar: 0,
    phase: 0,
    swingLabel: getTwoSwingStepInfo(0).label,
  });
  const [simCandles, setSimCandles] = useState<CandleWithAO[]>(() =>
    rawToCandlesWithAO(simStreamRef.current.raw, 'US100', 38)
  );
  const [simDirection, setSimDirection] = useState<SignalDirection | null>(null);
  const [simPlaying, setSimPlaying] = useState(false);
  const [simSpeed, setSimSpeed] = useState<1 | 2>(1);
  const [simTickInBar, setSimTickInBar] = useState(0);
  const [simSwingLabel, setSimSwingLabel] = useState(
    getTwoSwingStepInfo(0).label
  );

  // Live XM MT5-Style US100Cash M5 Feed State
  const [liveCandles, setLiveCandles] = useState<CandleWithAO[]>([]);
  const [liveFeedSymbol, setLiveFeedSymbol] = useState('US100Cash');
  const [liveIsRealtime, setLiveIsRealtime] = useState(true);
  const [liveMarketPrice, setLiveMarketPrice] = useState<number | null>(null);
  const [liveBid, setLiveBid] = useState<number | null>(null);
  const [liveAsk, setLiveAsk] = useState<number | null>(null);
  const [liveSpread, setLiveSpread] = useState<number | null>(null);
  const [liveBarCloseTimeIso, setLiveBarCloseTimeIso] = useState<string | null>(null);
  const [liveUpdatedAt, setLiveUpdatedAt] = useState<string | null>(null);
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [liveDirection, setLiveDirection] = useState<SignalDirection | null>(null);
  const [lastHistoricalCross, setLastHistoricalCross] =
    useState<LiveHistoricalCross | null>(null);
  const [nextRefreshInSec, setNextRefreshInSec] = useState(5);

  const lastAlertedLiveKeyRef = useRef<string | null>(
    typeof window !== 'undefined'
      ? window.localStorage.getItem(LIVE_ALERTED_KEY_STORAGE)
      : null
  );

  const [alertFilter, setAlertFilter] = useState<AlertDirectionFilter>('both');
  const [sound10sEnabled, setSound10sEnabled] = useState(false);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(true);

  const [latestSignal, setLatestSignal] = useState<SignalRecord | null>(null);

  // Configurable Telegram State
  const [serverDefaultChatId, setServerDefaultChatId] = useState('-1004382980885');
  const [telegramConfig, setTelegramConfig] = useState<TelegramConfigState>(() => ({
    ...loadSavedTelegramConfig(),
    serverTokenConfigured: false,
    maskedToken: '',
  }));
  const [telegramSettingsOpen, setTelegramSettingsOpen] = useState(false);

  // GitHub Server Sync State (only uploads when uploadAllowed === true)
  const [githubConfig, setGithubConfig] = useState<GitHubConfigState>({
    connected: false,
    maskedToken: '',
    username: '',
    repoName: '',
    repo: '',
    branch: 'main',
    isPrivate: true,
    autoUploadCode: true,
    autoLogSignals: true,
    uploadAllowed: false,
  });
  const [githubUploading, setGithubUploading] = useState(false);

  useEffect(() => {
    fetch('/api/github/config')
      .then((res) => res.json())
      .then((data: GitHubConfigState & { ok?: boolean }) => {
        if (data && typeof data.connected === 'boolean') {
          setGithubConfig({
            connected: data.connected,
            maskedToken: data.maskedToken || '',
            username: data.username || '',
            repoName: data.repoName || '',
            repo: data.repo || '',
            branch: data.branch || 'main',
            isPrivate: typeof data.isPrivate === 'boolean' ? data.isPrivate : true,
            autoUploadCode:
              typeof data.autoUploadCode === 'boolean' ? data.autoUploadCode : true,
            autoLogSignals:
              typeof data.autoLogSignals === 'boolean' ? data.autoLogSignals : true,
            uploadAllowed: Boolean(data.uploadAllowed),
            syncedFileCount: data.syncedFileCount,
            lastUploadAt: data.lastUploadAt,
            lastCommitUrl: data.lastCommitUrl,
          });
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch('/api/telegram/config')
      .then((res) => res.json())
      .then(
        (data: {
          configured?: boolean;
          maskedToken?: string;
          botUsername?: string;
          defaultChatId?: string;
          chatId?: string;
          sendCondition?: 'always' | 'fallback';
        }) => {
          if (data.defaultChatId) {
            setServerDefaultChatId(data.defaultChatId);
          }
          setTelegramConfig((prev) => {
            const hasStoredChat =
              typeof window !== 'undefined' &&
              Boolean(window.localStorage.getItem(TELEGRAM_STORAGE_KEY));
            return {
              ...prev,
              serverTokenConfigured: Boolean(data.configured),
              maskedToken: data.maskedToken || '',
              botUsername: data.botUsername,
              sendCondition:
                data.sendCondition === 'fallback' ? 'fallback' : prev.sendCondition,
              chatId: hasStoredChat
                ? prev.chatId
                : data.chatId || data.defaultChatId || prev.chatId,
            };
          });
        }
      )
      .catch(() => {});
  }, []);

  const formatTelegramSignalText = useCallback(
    (sig: SignalRecord, cfg: TelegramConfigState) => {
      const headIcon = sig.direction === 'BUY' ? '🟢' : '🔴';
      const condText =
        sig.direction === 'BUY'
          ? 'AO ตัดเส้น 0 ขึ้น 🟢⬆️'
          : 'AO ตัดเส้น 0 ลง 🔴⬇️';
      const modeLabel = sig.source === 'Live US100 M5' ? 'กราฟจริง' : 'กราฟจำลอง';
      const timeText =
        sig.timeLabel ||
        new Date(sig.timestamp).toLocaleTimeString('th-TH', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        });
      const tagLine = cfg.customTag.trim() ? `\n${cfg.customTag.trim()}` : '';

      if (cfg.parseMode === 'Markdown') {
        return [
          `*${headIcon} ${sig.direction} · US100 (M5)*`,
          `____________________`,
          `เงื่อนไข: ${condText}`,
          `ค่า AO: ${sig.aoPrevFormatted} → ${sig.aoCurrFormatted}`,
          `โหมด: ${modeLabel}`,
          `เวลา: ${timeText} น.${tagLine}`,
        ].join('\n');
      }
      return [
        `<b>${headIcon} ${sig.direction} · US100 (M5)</b>`,
        `____________________`,
        `เงื่อนไข: ${condText}`,
        `ค่า AO: ${sig.aoPrevFormatted} → ${sig.aoCurrFormatted}`,
        `โหมด: ${modeLabel}`,
        `เวลา: ${timeText} น.${tagLine}`,
      ].join('\n');
    },
    []
  );

  const sendTelegramPayload = useCallback(
    async (
      text: string,
      cfg: TelegramConfigState,
      dedupeKey?: string
    ): Promise<{ ok: boolean; message: string }> => {
      try {
        const res = await fetch('/api/telegram/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chatId: cfg.chatId,
            text,
            parseMode: cfg.parseMode,
            ...(dedupeKey ? { dedupeKey } : {}),
          }),
        });
        const data = (await res.json()) as {
          ok?: boolean;
          message?: string;
          messageId?: number;
        };

        if (data.ok) {
          return {
            ok: true,
            message: `ส่งเข้า Telegram (${cfg.chatId}) สำเร็จ (Message #${data.messageId})`,
          };
        }
        return {
          ok: false,
          message:
            data.message || `เตรียมข้อความสำหรับกลุ่ม ${cfg.chatId} แล้ว`,
        };
      } catch {
        return {
          ok: false,
          message: 'ไม่สามารถติดต่อเซิร์ฟเวอร์แจ้งเตือน Telegram ได้',
        };
      }
    },
    []
  );

  const triggerFullSystemAlert = useCallback(
    (sig: SignalRecord, dedupeKey?: string) => {
      setLatestSignal(sig);
      playAlertChime(sig.direction);

      const pushGranted =
        typeof window !== 'undefined' &&
        'Notification' in window &&
        Notification.permission === 'granted';
      if (pushGranted) {
        try {
          new Notification(
            `${sig.direction === 'BUY' ? '🟢' : '🔴'} ${sig.direction} · US100 (M5)`,
            {
              body: sig.pushMessage,
            }
          );
        } catch {
          // ignore iframe restrictions
        }
      }

      const shouldTelegramSend =
        telegramConfig.enabled &&
        telegramConfig.serverTokenConfigured &&
        (telegramConfig.sendCondition === 'always' || !pushGranted);

      if (shouldTelegramSend) {
        const tgMsg = formatTelegramSignalText(sig, telegramConfig);
        void sendTelegramPayload(tgMsg, telegramConfig, dedupeKey);
      }

      if (
        githubConfig.connected &&
        githubConfig.uploadAllowed &&
        githubConfig.autoLogSignals
      ) {
        void fetch('/api/github/signal-log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ signal: sig }),
        })
          .then((r) => r.json())
          .then((res: { ok?: boolean; uploadedAt?: string; commitUrl?: string }) => {
            if (res.ok && res.uploadedAt) {
              setGithubConfig((prev) => ({
                ...prev,
                lastUploadAt: res.uploadedAt,
                lastCommitUrl: res.commitUrl || prev.lastCommitUrl,
              }));
            }
          })
          .catch(() => {});
      }
    },
    [
      formatTelegramSignalText,
      githubConfig.autoLogSignals,
      githubConfig.connected,
      githubConfig.uploadAllowed,
      sendTelegramPayload,
      telegramConfig,
    ]
  );

  const fetchLiveUs100 = useCallback(async () => {
    setLiveLoading(true);
    setLiveError(null);
    try {
      const res = await fetch('/api/market/us100-m5', { cache: 'no-store' });
      const data = (await res.json()) as LiveMarketResponse;
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'ไม่สามารถโหลดกราฟจริง US100Cash M5 ได้');
      }

      const localizedCandles = data.candles.map((c) => ({
        ...c,
        timeLabel: toLocalHm(c.timestampIso, c.timeLabel),
      }));

      const localizedHist = data.lastHistoricalCross
        ? {
            ...data.lastHistoricalCross,
            timeLabel: toLocalHm(
              data.lastHistoricalCross.timestampIso,
              data.lastHistoricalCross.timeLabel
            ),
          }
        : null;

      setLiveCandles(localizedCandles);
      setLiveFeedSymbol(data.feedSymbol || 'US100Cash');
      setLiveIsRealtime(Boolean(data.isRealtimeStream));
      setLiveMarketPrice(data.marketPrice);
      setLiveBid(typeof data.bid === 'number' ? data.bid : data.marketPrice);
      setLiveAsk(typeof data.ask === 'number' ? data.ask : null);
      setLiveSpread(typeof data.spread === 'number' ? data.spread : null);
      setLiveBarCloseTimeIso(data.barCloseTimeIso ?? null);
      setLiveUpdatedAt(data.updatedAt);
      setLiveDirection(data.latestBarCross);
      setLastHistoricalCross(localizedHist);
      setNextRefreshInSec(5);

      if (data.latestBarCross && localizedCandles.length >= 3) {
        const bar1 =
          localizedCandles.find((c) => c.shift === 1) ??
          localizedCandles[localizedCandles.length - 2];
        const liveKey = `${bar1.timestampIso}_${data.latestBarCross}`;
        const matchesFilter =
          alertFilter === 'both' ||
          (alertFilter === 'buy_only' && data.latestBarCross === 'BUY') ||
          (alertFilter === 'sell_only' && data.latestBarCross === 'SELL');

        if (matchesFilter && lastAlertedLiveKeyRef.current !== liveKey) {
          lastAlertedLiveKeyRef.current = liveKey;
          if (typeof window !== 'undefined') {
            try {
              window.localStorage.setItem(LIVE_ALERTED_KEY_STORAGE, liveKey);
            } catch {
              // ignore quota errors
            }
          }
          const liveSig = createSignalFromSeries(
            'US100',
            localizedCandles,
            data.latestBarCross,
            'Live US100 M5'
          );
          triggerFullSystemAlert(liveSig, liveKey);
        }
      }
    } catch (err) {
      setLiveError(
        err instanceof Error ? err.message : 'เชื่อมต่อข้อมูลตลาด US100Cash M5 ไม่สำเร็จ'
      );
    } finally {
      setLiveLoading(false);
    }
  }, [alertFilter, triggerFullSystemAlert]);

  useEffect(() => {
    fetchLiveUs100();
  }, [fetchLiveUs100]);

  // 5-second Auto-Refresh polling (keeps Live alerts active in background too) + 1s countdown
  useEffect(() => {
    if (!autoRefreshEnabled) return;

    const pollId = window.setInterval(() => {
      fetchLiveUs100();
    }, 5000);

    const countdownId = window.setInterval(() => {
      setNextRefreshInSec((prev) => (prev <= 1 ? 5 : prev - 1));
    }, 1000);

    return () => {
      window.clearInterval(pollId);
      window.clearInterval(countdownId);
    };
  }, [autoRefreshEnabled, fetchLiveUs100]);

  useEffect(() => {
    if (!sound10sEnabled) return;
    const id = window.setInterval(() => {
      const dir = chartMode === 'live' ? liveDirection : simDirection;
      if (!dir) return;
      if (alertFilter === 'buy_only' && dir !== 'BUY') return;
      if (alertFilter === 'sell_only' && dir !== 'SELL') return;
      playAlertChime(dir);
    }, 10000);
    return () => window.clearInterval(id);
  }, [sound10sEnabled, chartMode, liveDirection, simDirection, alertFilter]);

  // Simulated Moving Candlestick Playback Loop (2-down swings / 2-up swings)
  useEffect(() => {
    if (chartMode !== 'simulator' || !simPlaying) return;
    const intervalMs = simSpeed === 2 ? 350 : 700;

    const id = window.setInterval(() => {
      const { nextState, candles: nextCandles, closedCross } = stepSimStream(
        simStreamRef.current,
        symbol
      );
      simStreamRef.current = nextState;
      setSimCandles(nextCandles);
      setSimTickInBar(nextState.tickInBar);
      setSimSwingLabel(nextState.swingLabel);

      if (closedCross) {
        setSimDirection(closedCross);
        const matchesFilter =
          alertFilter === 'both' ||
          (alertFilter === 'buy_only' && closedCross === 'BUY') ||
          (alertFilter === 'sell_only' && closedCross === 'SELL');

        if (matchesFilter) {
          const newSig = createSignalFromSeries(
            symbol,
            nextCandles,
            closedCross,
            'M5 Simulator'
          );
          triggerFullSystemAlert(newSig);
        }
      }
    }, intervalMs);

    return () => window.clearInterval(id);
  }, [
    chartMode,
    simPlaying,
    simSpeed,
    symbol,
    alertFilter,
    triggerFullSystemAlert,
  ]);

  const handleOpenTelegramAction = () => {
    setTelegramSettingsOpen(true);
  };

  const handleConfigSynced = (
    nextConfig: TelegramConfigState,
    _toastMessage?: string
  ) => {
    setTelegramConfig(nextConfig);
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(
          TELEGRAM_STORAGE_KEY,
          JSON.stringify({
            enabled: nextConfig.enabled,
            chatId: nextConfig.chatId,
            parseMode: nextConfig.parseMode,
            sendCondition: nextConfig.sendCondition,
            autoSendLive: nextConfig.autoSendLive,
            autoSendSim: nextConfig.autoSendSim,
            customTag: nextConfig.customTag,
          })
        );
      } catch {
        // ignore quota errors
      }
    }
  };

  const handleToggleSimPlay = () => {
    setSimPlaying((prev) => {
      const next = !prev;
      if (
        next &&
        typeof window !== 'undefined' &&
        'Notification' in window &&
        Notification.permission === 'default'
      ) {
        void Notification.requestPermission().catch(() => {});
      }
      return next;
    });
  };

  const handleToggleAutoRefresh = () => {
    setAutoRefreshEnabled((prev) => {
      const next = !prev;
      if (next) {
        setNextRefreshInSec(5);
        fetchLiveUs100();
      }
      return next;
    });
  };

  const handleToggleSound10s = () => {
    setSound10sEnabled((prev) => {
      const next = !prev;
      if (next) {
        playAlertChime('TEST');
      }
      return next;
    });
  };

  const displayedCandles = chartMode === 'live' ? liveCandles : simCandles;
  const displayedDirection = chartMode === 'live' ? liveDirection : simDirection;

  const handleTestSound = () => {
    playAlertChime(displayedDirection ?? 'TEST');
  };

  const handleTriggerMobileAlert = async () => {
    const activeSig =
      latestSignal ??
      (displayedCandles.length >= 3
        ? createSignalFromSeries(
            symbol,
            displayedCandles,
            displayedDirection ?? 'BUY',
            chartMode === 'live' ? 'Live US100 M5' : 'M5 Simulator'
          )
        : null);

    if (!activeSig) {
      return;
    }

    playAlertChime(activeSig.direction);
    if (typeof window !== 'undefined' && 'Notification' in window) {
      try {
        if (Notification.permission === 'default') {
          await Notification.requestPermission();
        }
        if (Notification.permission === 'granted') {
          new Notification(
            `${activeSig.direction === 'BUY' ? '🟢' : '🔴'} ${activeSig.direction} · US100 (M5)`,
            {
              body: activeSig.pushMessage,
            }
          );
        }
      } catch {
        // fallback cleanly
      }
    }
  };

  const handleUseHistoricalLiveCross = () => {
    if (!lastHistoricalCross) return;
    const priceFormatted = lastHistoricalCross.price.toFixed(2);
    const aoPrevFormatted = formatSignedAo(lastHistoricalCross.aoPrev, 3);
    const aoCurrFormatted = formatSignedAo(lastHistoricalCross.aoCurr, 3);
    const headIcon = lastHistoricalCross.direction === 'BUY' ? '🟢' : '🔴';
    const condText =
      lastHistoricalCross.direction === 'BUY'
        ? 'AO ตัดเส้น 0 ขึ้น 🟢⬆️'
        : 'AO ตัดเส้น 0 ลง 🔴⬇️';
    const pushMessage = [
      `${headIcon} ${lastHistoricalCross.direction} · US100 (M5)`,
      '____________________',
      `เงื่อนไข: ${condText}`,
      `ค่า AO: ${aoPrevFormatted} → ${aoCurrFormatted}`,
      `โหมด: กราฟจริง`,
      `เวลา: ${lastHistoricalCross.timeLabel} น.`,
    ].join('\n');

    const liveSignal: SignalRecord = {
      id: `live_hist_${Date.now()}`,
      timestamp: lastHistoricalCross.timestampIso,
      symbol: 'US100',
      timeframe: 'M5',
      direction: lastHistoricalCross.direction,
      price: lastHistoricalCross.price,
      priceFormatted,
      aoPrev: lastHistoricalCross.aoPrev,
      aoCurr: lastHistoricalCross.aoCurr,
      aoPrevFormatted,
      aoCurrFormatted,
      pushMessage,
      timeLabel: lastHistoricalCross.timeLabel,
      source: 'Live US100 M5',
      telegramStatus: 'pending',
      sheetsLogged: false,
    };
    setLatestSignal(liveSignal);
    playAlertChime(lastHistoricalCross.direction);
  };

  const handleGitHubConfigSynced = useCallback((nextConfig: GitHubConfigState) => {
    setGithubConfig(nextConfig);
  }, []);

  const handleManualGitHubUpload = useCallback(async () => {
    setGithubUploading(true);
    try {
      const res = await fetch('/api/github/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          latestSignal,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        message?: string;
        fileCount?: number;
        commitUrl?: string;
        uploadedAt?: string;
      };
      if (!res.ok || !data.ok) {
        return {
          ok: false,
          message: data.message || 'อัปโหลดขึ้น GitHub ไม่สำเร็จ',
        };
      }
      const uploadedAt = data.uploadedAt || new Date().toISOString();
      setGithubConfig((prev) => ({
        ...prev,
        syncedFileCount:
          typeof data.fileCount === 'number' ? data.fileCount : prev.syncedFileCount,
        lastUploadAt: uploadedAt,
        lastCommitUrl: data.commitUrl || prev.lastCommitUrl,
      }));
      return {
        ok: true,
        message: data.message || 'ซิงค์โค้ดขึ้น GitHub สำเร็จแล้ว',
        commitUrl: data.commitUrl,
        fileCount: data.fileCount,
        uploadedAt,
      };
    } catch {
      return {
        ok: false,
        message: 'ไม่สามารถติดต่อเซิร์ฟเวอร์เพื่ออัปโหลดขึ้น GitHub ได้',
      };
    } finally {
      setGithubUploading(false);
    }
  }, [latestSignal]);

  const isStandaloneOnlinePreview =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('preview') === 'online';

  return (
    <div className="min-h-screen bg-[#f4f7fb] text-slate-900">
      {/* Top Bar with นำขึ้น Server (hidden inside live iframe preview) */}
      {!isStandaloneOnlinePreview && (
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-2xl items-center justify-between px-3 py-2.5 sm:px-5">
            <button
              type="button"
              onClick={() => setActivePage('chart')}
              className={`border-b-2 pb-1 text-xs font-semibold transition-colors whitespace-nowrap ${
                activePage === 'chart'
                  ? 'border-slate-900 text-slate-900'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              กราฟ & สัญญาณ M5
            </button>

            <button
              type="button"
              onClick={() =>
                setActivePage((prev) => (prev === 'server' ? 'chart' : 'server'))
              }
              aria-pressed={activePage === 'server'}
              className="rounded-xl bg-[#0f172a] px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              นำขึ้น Server
            </button>
          </div>
        </header>
      )}

      <main className="mx-auto max-w-2xl space-y-3.5 px-2.5 py-3 sm:px-5 sm:py-5">
        {!isStandaloneOnlinePreview && activePage === 'server' ? (
          <ServerSyncPanel
            config={githubConfig}
            isUploading={githubUploading}
            onConfigSynced={handleGitHubConfigSynced}
            onManualUpload={handleManualGitHubUpload}
          />
        ) : (
          <AoChartPanel
            symbol={symbol}
            chartMode={chartMode}
            onChangeChartMode={setChartMode}
            alertFilter={alertFilter}
            onChangeAlertFilter={setAlertFilter}
            candles={displayedCandles}
            activeDirection={displayedDirection}
            liveFeedSymbol={liveFeedSymbol}
            liveIsRealtime={liveIsRealtime}
            liveMarketPrice={liveMarketPrice}
            liveBid={liveBid}
            liveAsk={liveAsk}
            liveSpread={liveSpread}
            liveBarCloseTimeIso={liveBarCloseTimeIso}
            liveUpdatedAt={liveUpdatedAt}
            nextRefreshInSec={nextRefreshInSec}
            liveLoading={liveLoading}
            liveError={liveError}
            sound10sEnabled={sound10sEnabled}
            onToggleSound10s={handleToggleSound10s}
            autoRefreshEnabled={autoRefreshEnabled}
            onToggleAutoRefresh={handleToggleAutoRefresh}
            onTestSound={handleTestSound}
            onTriggerMobileAlert={handleTriggerMobileAlert}
            onOpenTelegramAction={handleOpenTelegramAction}
            telegramEnabled={telegramConfig.enabled}
            telegramAutoSend={
              chartMode === 'live'
                ? telegramConfig.autoSendLive
                : telegramConfig.autoSendSim
            }
            telegramReady={telegramConfig.serverTokenConfigured}
            telegramChatId={telegramConfig.chatId}
            onRefreshLive={fetchLiveUs100}
            lastHistoricalCross={lastHistoricalCross}
            onUseHistoricalLiveCross={handleUseHistoricalLiveCross}
            simPlaying={simPlaying}
            simSpeed={simSpeed}
            simTickInBar={simTickInBar}
            simSwingLabel={simSwingLabel}
            onToggleSimPlay={handleToggleSimPlay}
            onChangeSimSpeed={setSimSpeed}
          />
        )}
      </main>

      <TelegramSettingsModal
        open={telegramSettingsOpen}
        config={telegramConfig}
        defaultChatId={serverDefaultChatId}
        onClose={() => setTelegramSettingsOpen(false)}
        onConfigSynced={handleConfigSynced}
      />
    </div>
  );
}
