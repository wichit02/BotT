export type TradingSymbol = 'US100';

export type SignalDirection = 'BUY' | 'SELL';

export type ChartMode = 'live' | 'simulator';

export interface CandleWithAO {
  index: number;
  timeLabel: string;
  timestampIso: string;
  open: number;
  high: number;
  low: number;
  close: number;
  median: number;
  ao: number;
  aoRising: boolean;
  shift: number;
}

export interface SignalRecord {
  id: string;
  timestamp: string;
  symbol: TradingSymbol;
  timeframe: 'M5';
  direction: SignalDirection;
  price: number;
  priceFormatted: string;
  aoPrev: number; // AO[2]
  aoCurr: number; // AO[1]
  aoPrevFormatted: string;
  aoCurrFormatted: string;
  pushMessage: string;
  timeLabel?: string;
  source: 'Live US100 M5' | 'M5 Simulator' | 'Manual Test';
  telegramStatus: 'pending' | 'sent' | 'skipped' | 'error';
  sheetsLogged: boolean;
}

export interface LiveHistoricalCross {
  direction: SignalDirection;
  shift: number;
  timeLabel: string;
  timestampIso: string;
  price: number;
  aoPrev: number;
  aoCurr: number;
}

export interface LiveMarketResponse {
  ok: boolean;
  feedSymbol: string;
  feedProvider?: string;
  isRealtimeStream?: boolean;
  displaySymbol: TradingSymbol;
  marketPrice: number;
  bid?: number;
  ask?: number;
  spread?: number;
  marketState: string;
  barCloseTimeIso?: string;
  lastTickAt?: string;
  updatedAt: string;
  candles: CandleWithAO[];
  latestBarCross: SignalDirection | null;
  lastHistoricalCross: LiveHistoricalCross | null;
  error?: string;
}

export interface TelegramConfigState {
  enabled: boolean;
  chatId: string;
  serverTokenConfigured: boolean;
  maskedToken: string;
  botUsername?: string;
  parseMode: 'HTML' | 'Markdown';
  sendCondition: 'always' | 'fallback';
  autoSendLive: boolean;
  autoSendSim: boolean;
  customTag: string;
}

export interface GitHubConfigState {
  connected: boolean;
  maskedToken: string;
  username: string;
  repoName: string;
  repo: string;
  branch: string;
  isPrivate: boolean;
  autoUploadCode: boolean;
  autoLogSignals: boolean;
  uploadAllowed: boolean;
  syncedFileCount?: number;
  lastUploadAt?: string;
  lastCommitUrl?: string;
}

export interface ConfirmationDialogState {
  open: boolean;
  kind: 'send_telegram';
  title: string;
  description: string;
  details: Array<{ label: string; value: string }>;
  confirmLabel: string;
  onConfirm: () => Promise<void> | void;
}
