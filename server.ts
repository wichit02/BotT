import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '-1004382980885';
const TELEGRAM_RUNTIME_FILE = path.resolve(__dirname, '.telegram-runtime.json');
const FIVE_MIN_MS = 5 * 60 * 1000;

interface RuntimeTelegramStore {
  botToken: string;
  botUsername: string;
  chatId: string;
  sendCondition: 'always' | 'fallback';
  lastSentLiveKey?: string;
}

function maskTelegramToken(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) return '';
  const colonIdx = trimmed.indexOf(':');
  if (colonIdx > 0) {
    const prefix = trimmed.slice(0, colonIdx);
    const suffix = trimmed.slice(-4);
    return `${prefix}:••••••${suffix}`;
  }
  if (trimmed.length <= 8) return '••••••••';
  return `${trimmed.slice(0, 4)}••••••${trimmed.slice(-4)}`;
}

function loadRuntimeTelegramStore(): RuntimeTelegramStore {
  const envToken = process.env.TELEGRAM_BOT_TOKEN?.trim() || '';
  const fallback: RuntimeTelegramStore = {
    botToken: envToken,
    botUsername: '',
    chatId: DEFAULT_TELEGRAM_CHAT_ID,
    sendCondition: 'always',
  };
  try {
    if (!fs.existsSync(TELEGRAM_RUNTIME_FILE)) return fallback;
    const parsed = JSON.parse(
      fs.readFileSync(TELEGRAM_RUNTIME_FILE, 'utf8')
    ) as Partial<RuntimeTelegramStore>;
    return {
      botToken:
        typeof parsed.botToken === 'string' && parsed.botToken.trim()
          ? parsed.botToken.trim()
          : envToken,
      botUsername: typeof parsed.botUsername === 'string' ? parsed.botUsername : '',
      chatId:
        typeof parsed.chatId === 'string' && parsed.chatId.trim()
          ? parsed.chatId.trim()
          : DEFAULT_TELEGRAM_CHAT_ID,
      sendCondition: parsed.sendCondition === 'fallback' ? 'fallback' : 'always',
      lastSentLiveKey:
        typeof parsed.lastSentLiveKey === 'string' ? parsed.lastSentLiveKey : undefined,
    };
  } catch {
    return fallback;
  }
}

function saveRuntimeTelegramStore(store: RuntimeTelegramStore): void {
  try {
    fs.writeFileSync(TELEGRAM_RUNTIME_FILE, JSON.stringify(store, null, 2), 'utf8');
  } catch {
    // non-fatal if filesystem is read-only; in-memory store still works
  }
}

const GITHUB_RUNTIME_FILE = path.resolve(__dirname, '.github-runtime.json');

interface RuntimeGitHubStore {
  token: string;
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

function maskGitHubToken(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 10) return '••••••••';
  return `${trimmed.slice(0, 4)}••••••${trimmed.slice(-4)}`;
}

function loadRuntimeGitHubStore(): RuntimeGitHubStore {
  const envToken = process.env.GITHUB_TOKEN?.trim() || '';
  const fallback: RuntimeGitHubStore = {
    token: envToken,
    username: '',
    repoName: '',
    repo: '',
    branch: 'main',
    isPrivate: true,
    autoUploadCode: true,
    autoLogSignals: true,
    uploadAllowed: false,
  };
  try {
    if (!fs.existsSync(GITHUB_RUNTIME_FILE)) return fallback;
    const parsed = JSON.parse(
      fs.readFileSync(GITHUB_RUNTIME_FILE, 'utf8')
    ) as Partial<RuntimeGitHubStore>;
    const rawRepo = typeof parsed.repo === 'string' ? parsed.repo : '';
    const derivedRepoName =
      typeof parsed.repoName === 'string' && parsed.repoName.trim()
        ? parsed.repoName.trim()
        : rawRepo.includes('/')
          ? rawRepo.split('/')[1] || ''
          : rawRepo;
    return {
      token:
        typeof parsed.token === 'string' && parsed.token.trim()
          ? parsed.token.trim()
          : envToken,
      username: typeof parsed.username === 'string' ? parsed.username : '',
      repoName: derivedRepoName,
      repo: rawRepo,
      branch:
        typeof parsed.branch === 'string' && parsed.branch.trim()
          ? parsed.branch.trim()
          : 'main',
      isPrivate: typeof parsed.isPrivate === 'boolean' ? parsed.isPrivate : true,
      autoUploadCode:
        typeof parsed.autoUploadCode === 'boolean' ? parsed.autoUploadCode : true,
      autoLogSignals:
        typeof parsed.autoLogSignals === 'boolean' ? parsed.autoLogSignals : true,
      uploadAllowed:
        typeof parsed.uploadAllowed === 'boolean' ? parsed.uploadAllowed : false,
      syncedFileCount:
        typeof parsed.syncedFileCount === 'number' ? parsed.syncedFileCount : undefined,
      lastUploadAt:
        typeof parsed.lastUploadAt === 'string' ? parsed.lastUploadAt : undefined,
      lastCommitUrl:
        typeof parsed.lastCommitUrl === 'string' ? parsed.lastCommitUrl : undefined,
    };
  } catch {
    return fallback;
  }
}

function saveRuntimeGitHubStore(store: RuntimeGitHubStore): void {
  try {
    fs.writeFileSync(GITHUB_RUNTIME_FILE, JSON.stringify(store, null, 2), 'utf8');
  } catch {
    // ignore read-only fs errors
  }
}

function collectProjectFilesForUpload(): Array<{ path: string; contentBase64: string }> {
  const ignoredDirs = new Set([
    'node_modules',
    'dist',
    'build',
    '.git',
    '.data',
    'coverage',
    '.aistudio',
  ]);
  const ignoredFiles = new Set([
    '.telegram-runtime.json',
    '.github-runtime.json',
    '.DS_Store',
  ]);
  const out: Array<{ path: string; contentBase64: string }> = [];

  const walk = (absDir: string, relDir: string) => {
    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      const absPath = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        if (ignoredDirs.has(entry.name)) continue;
        if (relPath === 'public/assets/aistudio') continue;
        walk(absPath, relPath);
      } else if (entry.isFile()) {
        if (ignoredFiles.has(entry.name)) continue;
        if (entry.name.startsWith('.env') && entry.name !== '.env.example') continue;
        if (entry.name.endsWith('.log')) continue;
        const stat = fs.statSync(absPath);
        if (stat.size > 512 * 1024) continue;
        const buf = fs.readFileSync(absPath);
        out.push({ path: relPath, contentBase64: buf.toString('base64') });
      }
    }
  };

  walk(__dirname, '');
  return out;
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'US100-M5-Studio',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

interface RawBar {
  timestampMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

const CFD_FEED_CANDIDATES = [
  { tvSymbol: 'VANTAGE:NAS100', label: 'US100Cash (CFD Real-time)' },
  { tvSymbol: 'FPMARKETS:US100', label: 'US100Cash (FP CFD Real-time)' },
  { tvSymbol: 'CAPITALCOM:NAS100', label: 'US100Cash (Capital CFD Real-time)' },
];

function packTvMessage(method: string, params: unknown[]): string {
  const payload = JSON.stringify({ m: method, p: params });
  return `~m~${payload.length}~m~${payload}`;
}

function parseTvFrames(raw: string): Array<{ heartbeat?: string; message?: { m: string; p: unknown[] } }> {
  const frames: Array<{ heartbeat?: string; message?: { m: string; p: unknown[] } }> = [];
  let cursor = 0;

  while (cursor < raw.length) {
    if (!raw.startsWith('~m~', cursor)) break;
    cursor += 3;
    const lenEnd = raw.indexOf('~m~', cursor);
    if (lenEnd === -1) break;
    const length = Number.parseInt(raw.slice(cursor, lenEnd), 10);
    if (!Number.isFinite(length) || length < 0) break;
    cursor = lenEnd + 3;
    const body = raw.slice(cursor, cursor + length);
    cursor += length;

    if (body.startsWith('~h~')) {
      frames.push({ heartbeat: body });
    } else if (body.startsWith('{')) {
      try {
        const parsed = JSON.parse(body) as { m?: string; p?: unknown[] };
        if (parsed.m && Array.isArray(parsed.p)) {
          frames.push({ message: { m: parsed.m, p: parsed.p } });
        }
      } catch {
        // Ignore malformed partial JSON frame
      }
    }
  }

  return frames;
}

function formatBkkHm(ms: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(ms));
}

class LiveUs100CfdFeed {
  private ws: WebSocket | null = null;
  private barsByTime = new Map<number, RawBar>();
  private candidateIdx = 0;
  private seriesReady = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectAttemptId = 0;
  private readyResolvers: Array<() => void> = [];

  public bid: number | null = null;
  public ask: number | null = null;
  public lastPrice: number | null = null;
  public lastTickMs: number = 0;
  public barCloseTimeMs: number | null = null;
  public activeProvider: string = CFD_FEED_CANDIDATES[0].tvSymbol;

  public start(): void {
    this.connect();
  }

  private resolveWaiters(): void {
    const waiters = this.readyResolvers.splice(0, this.readyResolvers.length);
    for (const resolve of waiters) {
      resolve();
    }
  }

  public async waitForBars(timeoutMs = 5500): Promise<boolean> {
    if (this.barsByTime.size >= 40 && this.seriesReady) {
      return true;
    }
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
      this.connect();
    }
    await Promise.race([
      new Promise<void>((resolve) => {
        this.readyResolvers.push(resolve);
      }),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
    return this.barsByTime.size >= 38;
  }

  private scheduleReconnect(delayMs = 2500, rotateCandidate = false): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    if (rotateCandidate) {
      this.candidateIdx = (this.candidateIdx + 1) % CFD_FEED_CANDIDATES.length;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  private connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const attemptId = ++this.connectAttemptId;
    const candidate = CFD_FEED_CANDIDATES[this.candidateIdx];
    this.activeProvider = candidate.tvSymbol;
    this.seriesReady = false;

    const chartSession = `cs_${Date.now().toString(36)}`;
    const quoteSession = `qs_${Date.now().toString(36)}`;

    let socket: WebSocket;
    try {
      socket = new WebSocket('wss://data.tradingview.com/socket.io/websocket?from=chart%2F', {
        headers: {
          Origin: 'https://www.tradingview.com',
          'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36',
        },
      } as unknown as string[]);
    } catch {
      this.scheduleReconnect(3000, true);
      return;
    }

    this.ws = socket;

    // If initial series hasn't arrived in 7s, rotate to next CFD candidate
    const startupWatchdog = setTimeout(() => {
      if (attemptId === this.connectAttemptId && !this.seriesReady) {
        try {
          socket.close();
        } catch {
          // ignore
        }
        this.scheduleReconnect(1000, true);
      }
    }, 7000);

    socket.addEventListener('open', () => {
      if (attemptId !== this.connectAttemptId) return;
      socket.send(packTvMessage('set_auth_token', ['unauthorized_user_token']));
      socket.send(packTvMessage('chart_create_session', [chartSession, '']));
      socket.send(packTvMessage('quote_create_session', [quoteSession]));
      socket.send(packTvMessage('quote_add_symbols', [quoteSession, candidate.tvSymbol]));
      socket.send(
        packTvMessage('resolve_symbol', [
          chartSession,
          'sds_sym_1',
          `=${JSON.stringify({ symbol: candidate.tvSymbol, adjustment: 'splits' })}`,
        ])
      );
      socket.send(packTvMessage('create_series', [chartSession, 'sds_1', 's1', 'sds_sym_1', '5', 90]));
    });

    socket.addEventListener('message', (event) => {
      if (attemptId !== this.connectAttemptId) return;
      const raw = String(event.data);
      const frames = parseTvFrames(raw);

      for (const frame of frames) {
        if (frame.heartbeat) {
          const reply = `~m~${frame.heartbeat.length}~m~${frame.heartbeat}`;
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(reply);
          }
          continue;
        }

        const msg = frame.message;
        if (!msg) continue;

        if (msg.m === 'qsd') {
          const data = msg.p[1] as {
            s?: string;
            v?: { bid?: number; ask?: number; lp?: number; lp_time?: number };
          };
          if (data?.v) {
            if (typeof data.v.bid === 'number' && Number.isFinite(data.v.bid)) {
              this.bid = data.v.bid;
            }
            if (typeof data.v.ask === 'number' && Number.isFinite(data.v.ask)) {
              this.ask = data.v.ask;
            }
            if (typeof data.v.lp === 'number' && Number.isFinite(data.v.lp)) {
              this.lastPrice = data.v.lp;
              this.applyLivePriceToFormingBar(data.v.lp);
            } else if (typeof this.bid === 'number') {
              this.applyLivePriceToFormingBar(this.bid);
            }
            this.lastTickMs =
              typeof data.v.lp_time === 'number' && data.v.lp_time > 0
                ? data.v.lp_time * 1000
                : Date.now();
          }
        } else if (msg.m === 'timescale_update' || msg.m === 'du') {
          const body = msg.p[1] as {
            sds_1?: {
              s?: Array<{ v?: number[] }>;
              lbs?: { bar_close_time?: number };
            };
          };
          const series = body?.sds_1;
          if (series?.lbs?.bar_close_time) {
            this.barCloseTimeMs = series.lbs.bar_close_time * 1000;
          }
          if (Array.isArray(series?.s)) {
            for (const barObj of series.s) {
              const v = barObj.v;
              if (!Array.isArray(v) || v.length < 5) continue;
              const tsMs = Math.round(v[0] * 1000);
              const open = v[1];
              const high = v[2];
              const low = v[3];
              const close = v[4];
              if (
                Number.isFinite(tsMs) &&
                Number.isFinite(open) &&
                Number.isFinite(high) &&
                Number.isFinite(low) &&
                Number.isFinite(close)
              ) {
                this.barsByTime.set(tsMs, { timestampMs: tsMs, open, high, low, close });
              }
            }
            this.trimBars();
            this.lastTickMs = Date.now();
          }
        } else if (msg.m === 'series_completed') {
          this.seriesReady = true;
          clearTimeout(startupWatchdog);
          this.resolveWaiters();
        } else if (msg.m === 'symbol_error' || msg.m === 'series_error') {
          clearTimeout(startupWatchdog);
          try {
            socket.close();
          } catch {
            // ignore
          }
          this.scheduleReconnect(800, true);
        }
      }
    });

    socket.addEventListener('close', () => {
      clearTimeout(startupWatchdog);
      if (attemptId === this.connectAttemptId) {
        this.ws = null;
        this.scheduleReconnect(2500, !this.seriesReady);
      }
    });

    socket.addEventListener('error', () => {
      clearTimeout(startupWatchdog);
      if (attemptId === this.connectAttemptId) {
        try {
          socket.close();
        } catch {
          // ignore
        }
      }
    });
  }

  private applyLivePriceToFormingBar(price: number): void {
    if (this.barsByTime.size === 0 || !Number.isFinite(price)) return;
    const nowAligned = Math.floor(Date.now() / FIVE_MIN_MS) * FIVE_MIN_MS;
    const latestKey = Math.max(...this.barsByTime.keys());
    const existing = this.barsByTime.get(latestKey);
    if (!existing) return;

    if (nowAligned > latestKey && nowAligned - latestKey <= FIVE_MIN_MS * 6) {
      // Seamlessly open the new M5 bar right on the 5m boundary while awaiting next `du`
      this.barsByTime.set(nowAligned, {
        timestampMs: nowAligned,
        open: existing.close,
        high: Math.max(existing.close, price),
        low: Math.min(existing.close, price),
        close: price,
      });
      this.barCloseTimeMs = nowAligned + FIVE_MIN_MS;
      this.trimBars();
    } else if (nowAligned === latestKey) {
      existing.close = price;
      if (price > existing.high) existing.high = price;
      if (price < existing.low) existing.low = price;
    }
  }

  private trimBars(): void {
    if (this.barsByTime.size <= 110) return;
    const sortedKeys = Array.from(this.barsByTime.keys()).sort((a, b) => a - b);
    const excess = sortedKeys.length - 100;
    for (let i = 0; i < excess; i++) {
      this.barsByTime.delete(sortedKeys[i]);
    }
  }

  public getOrderedBars(): RawBar[] {
    return Array.from(this.barsByTime.values()).sort((a, b) => a.timestampMs - b.timestampMs);
  }
}

function buildAoMarketPayload(params: {
  rawBars: RawBar[];
  feedSymbol: string;
  feedProvider: string;
  isRealtimeStream: boolean;
  bid: number | null;
  ask: number | null;
  lastPrice: number | null;
  lastTickMs: number;
  barCloseTimeMs: number | null;
}) {
  const recentRaw = params.rawBars.slice(-90);
  const medians = recentRaw.map((b) => (b.high + b.low) / 2);
  const aoValues = new Array<number>(recentRaw.length).fill(0);

  for (let i = 33; i < recentRaw.length; i++) {
    let sum5 = 0;
    for (let j = i - 4; j <= i; j++) sum5 += medians[j];
    let sum34 = 0;
    for (let j = i - 33; j <= i; j++) sum34 += medians[j];
    aoValues[i] = sum5 / 5 - sum34 / 34;
  }

  const visibleCount = 38;
  const startIdx = recentRaw.length - visibleCount;

  const candles = recentRaw.slice(startIdx).map((b, idx) => {
    const absIdx = startIdx + idx;
    const aoVal = aoValues[absIdx];
    const prevAoVal = absIdx > 0 ? aoValues[absIdx - 1] : aoVal;
    const shift = visibleCount - 1 - idx;

    return {
      index: idx,
      timeLabel: formatBkkHm(b.timestampMs),
      timestampIso: new Date(b.timestampMs).toISOString(),
      open: Number(b.open.toFixed(2)),
      high: Number(b.high.toFixed(2)),
      low: Number(b.low.toFixed(2)),
      close: Number(b.close.toFixed(2)),
      median: (b.high + b.low) / 2,
      ao: aoVal,
      aoRising: aoVal >= prevAoVal,
      shift,
    };
  });

  let latestBarCross: 'BUY' | 'SELL' | null = null;
  let lastHistoricalCross: {
    direction: 'BUY' | 'SELL';
    shift: number;
    timeLabel: string;
    timestampIso: string;
    price: number;
    aoPrev: number;
    aoCurr: number;
  } | null = null;

  for (let i = candles.length - 2; i >= 1; i--) {
    const curr = candles[i];
    const prev = candles[i - 1];
    const isBuy = prev.ao <= 0 && curr.ao > 0;
    const isSell = prev.ao >= 0 && curr.ao < 0;

    if (isBuy || isSell) {
      const direction = isBuy ? 'BUY' : 'SELL';
      if (curr.shift === 1) {
        latestBarCross = direction;
      }
      if (!lastHistoricalCross) {
        lastHistoricalCross = {
          direction,
          shift: curr.shift,
          timeLabel: curr.timeLabel,
          timestampIso: curr.timestampIso,
          price: curr.close,
          aoPrev: prev.ao,
          aoCurr: curr.ao,
        };
      }
    }
  }

  const lastCandle = candles[candles.length - 1];
  const resolvedBid =
    params.bid !== null
      ? Number(params.bid.toFixed(2))
      : params.lastPrice !== null
        ? Number(params.lastPrice.toFixed(2))
        : lastCandle.close;
  const resolvedAsk =
    params.ask !== null
      ? Number(params.ask.toFixed(2))
      : Number((resolvedBid + 0.9).toFixed(2));
  const spread = Number(Math.max(0, resolvedAsk - resolvedBid).toFixed(2));

  const nextCloseMs =
    params.barCloseTimeMs && params.barCloseTimeMs > Date.now()
      ? params.barCloseTimeMs
      : Math.floor(Date.now() / FIVE_MIN_MS) * FIVE_MIN_MS + FIVE_MIN_MS;

  return {
    ok: true,
    feedSymbol: params.feedSymbol,
    feedProvider: params.feedProvider,
    isRealtimeStream: params.isRealtimeStream,
    displaySymbol: 'US100',
    marketPrice: resolvedBid,
    bid: resolvedBid,
    ask: resolvedAsk,
    spread,
    marketState: params.isRealtimeStream ? 'LIVE' : 'FALLBACK',
    barCloseTimeIso: new Date(nextCloseMs).toISOString(),
    lastTickAt: new Date(params.lastTickMs || Date.now()).toISOString(),
    updatedAt: new Date().toISOString(),
    candles,
    latestBarCross,
    lastHistoricalCross,
  };
}

async function fetchYahooFallbackBars(): Promise<{ bars: RawBar[]; symbol: string; price: number | null }> {
  const fetchYahoo = async (ticker: string) => {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      ticker
    )}?interval=5m&range=5d&includePrePost=true`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`Feed HTTP ${response.status}`);
    }
    return (await response.json()) as {
      chart?: {
        result?: Array<{
          meta?: { symbol?: string; regularMarketPrice?: number };
          timestamp?: number[];
          indicators?: {
            quote?: Array<{
              open?: Array<number | null>;
              high?: Array<number | null>;
              low?: Array<number | null>;
              close?: Array<number | null>;
            }>;
          };
        }>;
      };
    };
  };

  let data = await fetchYahoo('NQ=F');
  let result = data.chart?.result?.[0];
  if (!result?.timestamp?.length) {
    data = await fetchYahoo('^NDX');
    result = data.chart?.result?.[0];
  }

  const timestamps = result?.timestamp ?? [];
  const quote = result?.indicators?.quote?.[0];
  const rawBars: RawBar[] = [];

  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i];
    const o = quote?.open?.[i];
    const h = quote?.high?.[i];
    const l = quote?.low?.[i];
    const c = quote?.close?.[i];
    if (
      typeof ts === 'number' &&
      typeof o === 'number' &&
      typeof h === 'number' &&
      typeof l === 'number' &&
      typeof c === 'number' &&
      Number.isFinite(o) &&
      Number.isFinite(h) &&
      Number.isFinite(l) &&
      Number.isFinite(c)
    ) {
      rawBars.push({ timestampMs: ts * 1000, open: o, high: h, low: l, close: c });
    }
  }

  return {
    bars: rawBars,
    symbol: result?.meta?.symbol || 'NQ=F',
    price:
      typeof result?.meta?.regularMarketPrice === 'number'
        ? result.meta.regularMarketPrice
        : null,
  };
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  const liveCfdFeed = new LiveUs100CfdFeed();
  liveCfdFeed.start();

  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'ao-zerocross-m5-studio' });
  });

  app.get('/api/market/us100-m5', async (_req, res) => {
    try {
      const hasRealtimeBars = await liveCfdFeed.waitForBars(5000);
      const realtimeBars = liveCfdFeed.getOrderedBars();

      if (hasRealtimeBars && realtimeBars.length >= 38) {
        const payload = buildAoMarketPayload({
          rawBars: realtimeBars,
          feedSymbol: 'US100Cash',
          feedProvider: liveCfdFeed.activeProvider,
          isRealtimeStream: true,
          bid: liveCfdFeed.bid,
          ask: liveCfdFeed.ask,
          lastPrice: liveCfdFeed.lastPrice,
          lastTickMs: liveCfdFeed.lastTickMs,
          barCloseTimeMs: liveCfdFeed.barCloseTimeMs,
        });
        res.json(payload);
        return;
      }

      const fallback = await fetchYahooFallbackBars();
      if (fallback.bars.length < 38) {
        res.status(502).json({
          ok: false,
          error: 'จำนวนแท่งเทียน M5 ไม่เพียงพอสำหรับคำนวณ AO(5, 34)',
        });
        return;
      }

      const payload = buildAoMarketPayload({
        rawBars: fallback.bars,
        feedSymbol: fallback.symbol,
        feedProvider: `Yahoo (${fallback.symbol})`,
        isRealtimeStream: false,
        bid: fallback.price,
        ask: fallback.price !== null ? fallback.price + 0.9 : null,
        lastPrice: fallback.price,
        lastTickMs: Date.now(),
        barCloseTimeMs: null,
      });
      res.json(payload);
    } catch (error) {
      res.status(502).json({
        ok: false,
        error:
          error instanceof Error
            ? `ดึงข้อมูลกราฟจริง US100 ไม่สำเร็จ: ${error.message}`
            : 'ไม่สามารถเชื่อมต่อฟีดข้อมูลตลาดได้',
      });
    }
  });

  let telegramStore = loadRuntimeTelegramStore();

  app.get('/api/telegram/config', (_req, res) => {
    const activeToken =
      telegramStore.botToken.trim() || process.env.TELEGRAM_BOT_TOKEN?.trim() || '';
    res.json({
      configured: activeToken.length > 0,
      maskedToken: activeToken ? maskTelegramToken(activeToken) : '',
      botUsername: telegramStore.botUsername || undefined,
      defaultChatId: DEFAULT_TELEGRAM_CHAT_ID,
      chatId: telegramStore.chatId || DEFAULT_TELEGRAM_CHAT_ID,
      sendCondition: telegramStore.sendCondition,
    });
  });

  app.post('/api/telegram/config', async (req, res) => {
    try {
      const { botToken, chatId, sendCondition, testSend, parseMode } = req.body as {
        botToken?: string;
        chatId?: string;
        sendCondition?: 'always' | 'fallback';
        testSend?: boolean;
        parseMode?: 'HTML' | 'Markdown';
      };

      const incomingToken = typeof botToken === 'string' ? botToken.trim() : '';
      const resolvedToken =
        incomingToken ||
        telegramStore.botToken.trim() ||
        process.env.TELEGRAM_BOT_TOKEN?.trim() ||
        '';
      const resolvedChatId =
        typeof chatId === 'string' && chatId.trim()
          ? chatId.trim()
          : telegramStore.chatId || DEFAULT_TELEGRAM_CHAT_ID;
      const resolvedCondition =
        sendCondition === 'fallback' ? 'fallback' : 'always';

      if (!resolvedToken) {
        res.status(400).json({
          ok: false,
          message: 'กรุณากรอก Telegram Bot Token จาก @BotFather ก่อนบันทึก',
        });
        return;
      }

      let verifiedUsername = telegramStore.botUsername;
      if (incomingToken || !verifiedUsername) {
        const meRes = await fetch(
          `https://api.telegram.org/bot${resolvedToken}/getMe`
        );
        const meData = (await meRes.json()) as {
          ok?: boolean;
          description?: string;
          result?: { username?: string; first_name?: string };
        };
        if (!meRes.ok || !meData.ok) {
          res.status(400).json({
            ok: false,
            message: `Bot Token ไม่ถูกต้อง: ${meData.description || 'Unauthorized'}`,
          });
          return;
        }
        verifiedUsername = meData.result?.username || meData.result?.first_name || '';
      }

      telegramStore = {
        ...telegramStore,
        botToken: resolvedToken,
        botUsername: verifiedUsername,
        chatId: resolvedChatId,
        sendCondition: resolvedCondition,
      };
      saveRuntimeTelegramStore(telegramStore);

      let testMessageId: number | undefined;
      let testChatTitle: string | undefined;

      if (testSend) {
        const bkkTime = formatBkkHm(Date.now());
        const botLabel = verifiedUsername ? `@${verifiedUsername}` : 'TelegramBot';
        const testText =
          parseMode === 'Markdown'
            ? [
                `*🟢 BUY · US100 (M5)*`,
                `____________________`,
                `เงื่อนไข: AO ตัดเส้น 0 ขึ้น 🟢⬆️`,
                `ค่า AO: -1.250 → +0.420`,
                `โหมด: ทดสอบ (${botLabel})`,
                `เวลา: ${bkkTime} น.`,
              ].join('\n')
            : [
                `<b>🟢 BUY · US100 (M5)</b>`,
                `____________________`,
                `เงื่อนไข: AO ตัดเส้น 0 ขึ้น 🟢⬆️`,
                `ค่า AO: -1.250 → +0.420`,
                `โหมด: ทดสอบ (${botLabel})`,
                `เวลา: ${bkkTime} น.`,
              ].join('\n');

        const tgRes = await fetch(
          `https://api.telegram.org/bot${resolvedToken}/sendMessage`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: resolvedChatId,
              text: testText,
              parse_mode: parseMode || 'HTML',
              disable_web_page_preview: true,
            }),
          }
        );
        const tgData = (await tgRes.json()) as {
          ok?: boolean;
          description?: string;
          result?: { message_id?: number; chat?: { title?: string } };
        };
        if (!tgRes.ok || !tgData.ok) {
          res.status(400).json({
            ok: false,
            configured: true,
            maskedToken: maskTelegramToken(resolvedToken),
            botUsername: verifiedUsername,
            chatId: resolvedChatId,
            sendCondition: resolvedCondition,
            message: `บันทึก Token แล้ว แต่ส่งเข้า Chat ID ${resolvedChatId} ไม่สำเร็จ: ${
              tgData.description || 'ตรวจสอบว่าดึงบอทเข้ากลุ่มแล้ว'
            }`,
          });
          return;
        }
        testMessageId = tgData.result?.message_id;
        testChatTitle = tgData.result?.chat?.title;
      }

      res.json({
        ok: true,
        configured: true,
        maskedToken: maskTelegramToken(resolvedToken),
        botUsername: verifiedUsername,
        chatId: resolvedChatId,
        sendCondition: resolvedCondition,
        messageId: testMessageId,
        chatTitle: testChatTitle,
        message: testSend
          ? `บันทึกและทดสอบส่งข้อความเข้า ${testChatTitle || resolvedChatId} สำเร็จ (Message #${testMessageId})`
          : `บันทึกการตั้งค่า Telegram Bot (@${verifiedUsername}) เรียบร้อยแล้ว`,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        message: error instanceof Error ? error.message : 'Server error',
      });
    }
  });

  app.post('/api/telegram/discover-chats', async (req, res) => {
    try {
      const { botToken, chatId } = req.body as {
        botToken?: string;
        chatId?: string;
      };
      const resolvedToken =
        (typeof botToken === 'string' && botToken.trim()) ||
        telegramStore.botToken.trim() ||
        process.env.TELEGRAM_BOT_TOKEN?.trim() ||
        '';
      const targetChatId =
        (typeof chatId === 'string' && chatId.trim()) ||
        telegramStore.chatId ||
        DEFAULT_TELEGRAM_CHAT_ID;

      if (!resolvedToken) {
        res.status(400).json({
          ok: false,
          message: 'กรุณากรอก Telegram Bot Token ก่อนตรวจสอบสิทธิ์และดึงรายชื่อกลุ่ม',
        });
        return;
      }

      const meRes = await fetch(`https://api.telegram.org/bot${resolvedToken}/getMe`);
      const meData = (await meRes.json()) as {
        ok?: boolean;
        description?: string;
        result?: { username?: string; first_name?: string };
      };
      if (!meRes.ok || !meData.ok) {
        res.status(400).json({
          ok: false,
          message: `Bot Token ไม่ถูกต้อง: ${meData.description || 'Unauthorized'}`,
        });
        return;
      }

      const botUsername = meData.result?.username || meData.result?.first_name || '';

      // Check current Chat ID access via getChat
      let currentChatCheck: {
        ok: boolean;
        chatId: string;
        title?: string;
        type?: string;
        error?: string;
      } = { ok: false, chatId: targetChatId };

      try {
        const chatRes = await fetch(
          `https://api.telegram.org/bot${resolvedToken}/getChat?chat_id=${encodeURIComponent(
            targetChatId
          )}`
        );
        const chatData = (await chatRes.json()) as {
          ok?: boolean;
          description?: string;
          result?: { id?: number; title?: string; type?: string; username?: string };
        };
        if (chatRes.ok && chatData.ok && chatData.result) {
          currentChatCheck = {
            ok: true,
            chatId: String(chatData.result.id ?? targetChatId),
            title:
              chatData.result.title ||
              chatData.result.username ||
              `Chat ${targetChatId}`,
            type: chatData.result.type,
          };
        } else {
          currentChatCheck = {
            ok: false,
            chatId: targetChatId,
            error: chatData.description || 'ไม่พบกลุ่มหรือบอทยังไม่ได้เข้าร่วมกลุ่มนี้',
          };
        }
      } catch {
        currentChatCheck = {
          ok: false,
          chatId: targetChatId,
          error: 'ไม่สามารถตรวจสอบกลุ่มได้',
        };
      }

      // Discover all recent joined groups/chats via getUpdates
      const discoveredMap = new Map<
        string,
        { id: string; title: string; type: string; username?: string }
      >();

      try {
        const updRes = await fetch(
          `https://api.telegram.org/bot${resolvedToken}/getUpdates?limit=50`
        );
        const updData = (await updRes.json()) as {
          ok?: boolean;
          result?: Array<{
            message?: {
              chat?: {
                id: number;
                title?: string;
                first_name?: string;
                username?: string;
                type: string;
              };
            };
            channel_post?: {
              chat?: { id: number; title?: string; username?: string; type: string };
            };
            my_chat_member?: {
              chat?: { id: number; title?: string; username?: string; type: string };
              new_chat_member?: { status?: string };
            };
          }>;
        };

        if (updRes.ok && updData.ok && Array.isArray(updData.result)) {
          for (const upd of updData.result) {
            const chats = [
              upd.message?.chat,
              upd.channel_post?.chat,
              upd.my_chat_member?.chat,
            ];
            for (const c of chats) {
              if (!c || !c.id) continue;
              const idStr = String(c.id);
              const title =
                c.title ||
                ('first_name' in c && typeof c.first_name === 'string'
                  ? c.first_name
                  : '') ||
                c.username ||
                idStr;
              discoveredMap.set(idStr, {
                id: idStr,
                title,
                type: c.type || 'group',
                username: c.username,
              });
            }
          }
        }
      } catch {
        // ignore update polling error
      }

      if (currentChatCheck.ok && currentChatCheck.title) {
        discoveredMap.set(currentChatCheck.chatId, {
          id: currentChatCheck.chatId,
          title: currentChatCheck.title,
          type: currentChatCheck.type || 'group',
        });
      }

      res.json({
        ok: true,
        botUsername,
        currentChatCheck,
        discoveredChats: Array.from(discoveredMap.values()),
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        message: error instanceof Error ? error.message : 'Server error',
      });
    }
  });

  app.post('/api/telegram/send', async (req, res) => {
    try {
      const { chatId, text, parseMode, dedupeKey } = req.body as {
        chatId?: string;
        text?: string;
        parseMode?: 'HTML' | 'Markdown';
        dedupeKey?: string;
      };

      const targetChatId =
        (chatId && chatId.trim()) || telegramStore.chatId || DEFAULT_TELEGRAM_CHAT_ID;
      if (!text || typeof text !== 'string' || !text.trim()) {
        res.status(400).json({ ok: false, error: 'Message text is required' });
        return;
      }

      if (dedupeKey && telegramStore.lastSentLiveKey === dedupeKey) {
        res.json({
          ok: true,
          deduplicated: true,
          chatId: targetChatId,
        });
        return;
      }

      const botToken =
        telegramStore.botToken.trim() || process.env.TELEGRAM_BOT_TOKEN?.trim() || '';
      const payload = {
        chat_id: targetChatId,
        text: text.trim(),
        parse_mode: parseMode || 'HTML',
        disable_web_page_preview: true,
      };

      if (!botToken) {
        res.status(200).json({
          ok: false,
          reason: 'missing_server_token',
          message:
            'ยังไม่ได้ตั้งค่า Telegram Bot Token (กด "ตั้งค่า Telegram" เพื่อใส่ Bot Token และเชื่อมต่อกลุ่ม ' +
            targetChatId +
            ')',
          previewPayload: payload,
        });
        return;
      }

      if (dedupeKey) {
        telegramStore = { ...telegramStore, lastSentLiveKey: dedupeKey };
        saveRuntimeTelegramStore(telegramStore);
      }

      const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const tgData = (await tgRes.json()) as {
        ok?: boolean;
        description?: string;
        result?: { message_id?: number; chat?: { id?: number; title?: string } };
      };

      if (!tgRes.ok || !tgData.ok) {
        if (dedupeKey && telegramStore.lastSentLiveKey === dedupeKey) {
          telegramStore = { ...telegramStore, lastSentLiveKey: undefined };
          saveRuntimeTelegramStore(telegramStore);
        }
        res.status(400).json({
          ok: false,
          reason: 'telegram_api_error',
          message: tgData.description || 'Telegram API rejected the request',
          previewPayload: payload,
        });
        return;
      }

      res.json({
        ok: true,
        messageId: tgData.result?.message_id,
        chatId: targetChatId,
        chatTitle: tgData.result?.chat?.title,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        reason: 'server_error',
        message: error instanceof Error ? error.message : 'Unexpected server error',
      });
    }
  });

  // --- GitHub Connection & Upload Routes ---
  let githubStore = loadRuntimeGitHubStore();
  const signalHistoryBuffer: Array<Record<string, unknown>> = [];

  const ensureGitHubRepoExists = async (params: {
    token: string;
    username: string;
    repoName: string;
    isPrivate: boolean;
  }): Promise<{ ok: true; fullRepo: string; created: boolean } | { ok: false; message: string }> => {
    const fullRepo = `${params.username}/${params.repoName}`;
    const checkRes = await fetch(`https://api.github.com/repos/${fullRepo}`, {
      headers: ghHeaders(params.token),
    });
    if (checkRes.ok) {
      return { ok: true, fullRepo, created: false };
    }
    if (checkRes.status !== 404) {
      const errData = (await checkRes.json().catch(() => ({}))) as { message?: string };
      return {
        ok: false,
        message: `ไม่สามารถตรวจสอบ Repository "${fullRepo}": ${errData.message || checkRes.status}`,
      };
    }
    // Repository does not exist yet — create automatically
    const createRes = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: {
        ...ghHeaders(params.token),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: params.repoName,
        private: params.isPrivate,
        auto_init: false,
        description: 'US100 M5 AO ZeroCross Monitor & Alert System',
      }),
    });
    const createData = (await createRes.json().catch(() => ({}))) as {
      full_name?: string;
      message?: string;
    };
    if (!createRes.ok) {
      return {
        ok: false,
        message: `สร้าง Repository "${params.repoName}" อัตโนมัติไม่สำเร็จ: ${
          createData.message || createRes.status
        }`,
      };
    }
    return { ok: true, fullRepo: createData.full_name || fullRepo, created: true };
  };

  app.get('/api/github/config', (_req, res) => {
    const activeToken =
      githubStore.token.trim() || process.env.GITHUB_TOKEN?.trim() || '';
    res.json({
      connected:
        activeToken.length > 0 &&
        githubStore.username.trim().length > 0 &&
        githubStore.repoName.trim().length > 0,
      hasToken: activeToken.length > 0,
      maskedToken: activeToken ? maskGitHubToken(activeToken) : '',
      username: githubStore.username,
      repoName: githubStore.repoName,
      repo: githubStore.repo,
      branch: githubStore.branch || 'main',
      isPrivate: githubStore.isPrivate,
      autoUploadCode: githubStore.autoUploadCode,
      autoLogSignals: githubStore.autoLogSignals,
      uploadAllowed: githubStore.uploadAllowed,
      syncedFileCount: githubStore.syncedFileCount,
      lastUploadAt: githubStore.lastUploadAt,
      lastCommitUrl: githubStore.lastCommitUrl,
    });
  });

  app.post('/api/github/config', async (req, res) => {
    try {
      const {
        token,
        repoName,
        repo,
        username,
        branch,
        isPrivate,
        autoUploadCode,
        autoLogSignals,
      } = req.body as {
        token?: string;
        repoName?: string;
        repo?: string;
        username?: string;
        branch?: string;
        isPrivate?: boolean;
        autoUploadCode?: boolean;
        autoLogSignals?: boolean;
      };

      const incomingToken = typeof token === 'string' ? token.trim() : '';
      const activeToken =
        incomingToken ||
        githubStore.token.trim() ||
        process.env.GITHUB_TOKEN?.trim() ||
        '';

      if (!activeToken) {
        res.status(400).json({
          ok: false,
          message: 'กรุณากรอก GitHub Personal Access Token (สิทธิ์ repo) ก่อนบันทึก',
        });
        return;
      }

      const rawRepoInput = (
        typeof repoName === 'string'
          ? repoName
          : typeof repo === 'string'
            ? repo
            : githubStore.repoName || githubStore.repo
      )
        .trim()
        .replace(/^https?:\/\/github\.com\//i, '')
        .replace(/\.git$/i, '')
        .replace(/^\/+|\/+$/g, '');

      let cleanRepoName = rawRepoInput;
      let parsedOwnerFromRepo = '';
      if (rawRepoInput.includes('/')) {
        const parts = rawRepoInput.split('/').filter(Boolean);
        parsedOwnerFromRepo = parts[0] || '';
        cleanRepoName = parts[1] || '';
      }

      if (!cleanRepoName) {
        res.status(400).json({
          ok: false,
          message: 'กรุณาระบุชื่อ Repository (เช่น BotT)',
        });
        return;
      }

      // Verify GitHub token and resolve username
      const userRes = await fetch('https://api.github.com/user', {
        headers: ghHeaders(activeToken),
      });
      const userData = (await userRes.json()) as {
        login?: string;
        message?: string;
      };
      if (!userRes.ok || !userData.login) {
        res.status(400).json({
          ok: false,
          message: `GitHub Token ไม่ถูกต้อง: ${userData.message || 'Unauthorized'}`,
        });
        return;
      }

      const resolvedUsername =
        (typeof username === 'string' && username.trim()) ||
        parsedOwnerFromRepo ||
        userData.login;
      const cleanBranch =
        (typeof branch === 'string' && branch.trim()) || githubStore.branch || 'main';
      const nextPrivate =
        typeof isPrivate === 'boolean' ? isPrivate : githubStore.isPrivate;
      const nextAutoUploadCode =
        typeof autoUploadCode === 'boolean' ? autoUploadCode : githubStore.autoUploadCode;
      const nextAutoLogSignals =
        typeof autoLogSignals === 'boolean' ? autoLogSignals : githubStore.autoLogSignals;

      const repoCheck = await ensureGitHubRepoExists({
        token: activeToken,
        username: resolvedUsername,
        repoName: cleanRepoName,
        isPrivate: nextPrivate,
      });
      if (!repoCheck.ok) {
        res.status(400).json({ ok: false, message: repoCheck.message });
        return;
      }

      githubStore = {
        ...githubStore,
        token: activeToken,
        username: resolvedUsername,
        repoName: cleanRepoName,
        repo: repoCheck.fullRepo,
        branch: cleanBranch,
        isPrivate: nextPrivate,
        autoUploadCode: nextAutoUploadCode,
        autoLogSignals: nextAutoLogSignals,
      };
      saveRuntimeGitHubStore(githubStore);

      res.json({
        ok: true,
        connected: true,
        maskedToken: maskGitHubToken(activeToken),
        username: githubStore.username,
        repoName: githubStore.repoName,
        repo: githubStore.repo,
        branch: githubStore.branch,
        isPrivate: githubStore.isPrivate,
        autoUploadCode: githubStore.autoUploadCode,
        autoLogSignals: githubStore.autoLogSignals,
        uploadAllowed: githubStore.uploadAllowed,
        syncedFileCount: githubStore.syncedFileCount,
        lastUploadAt: githubStore.lastUploadAt,
        lastCommitUrl: githubStore.lastCommitUrl,
        message: repoCheck.created
          ? `สร้าง Repository "${githubStore.repo}" และบันทึกการเชื่อมต่อสำเร็จ (ยังไม่ส่งไฟล์จนกว่าจะกดอนุญาตอัปโหลด)`
          : `บันทึกการเชื่อมต่อ GitHub (${githubStore.repo}) สำเร็จ`,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        message: error instanceof Error ? error.message : 'GitHub config error',
      });
    }
  });

  app.post('/api/github/permission', (req, res) => {
    const { uploadAllowed } = req.body as { uploadAllowed?: boolean };
    githubStore = {
      ...githubStore,
      uploadAllowed: Boolean(uploadAllowed),
    };
    saveRuntimeGitHubStore(githubStore);
    res.json({
      ok: true,
      uploadAllowed: githubStore.uploadAllowed,
      message: githubStore.uploadAllowed
        ? 'อนุญาตอัปโหลดขึ้น GitHub แล้ว'
        : 'ปิดการอนุญาตอัปโหลดแล้ว (โหมดเชื่อมต่ออย่างเดียว)',
    });
  });

  app.post('/api/github/disconnect', (_req, res) => {
    githubStore = {
      token: '',
      username: '',
      repoName: '',
      repo: '',
      branch: 'main',
      isPrivate: true,
      autoUploadCode: true,
      autoLogSignals: true,
      uploadAllowed: false,
    };
    saveRuntimeGitHubStore(githubStore);
    res.json({ ok: true, message: 'ยกเลิกการเชื่อมต่อ GitHub แล้ว' });
  });

  app.post('/api/github/signal-log', async (req, res) => {
    try {
      const { signal } = req.body as { signal?: Record<string, unknown> };
      if (signal && typeof signal === 'object') {
        signalHistoryBuffer.unshift(signal);
        if (signalHistoryBuffer.length > 50) {
          signalHistoryBuffer.length = 50;
        }
      }

      const activeToken =
        githubStore.token.trim() || process.env.GITHUB_TOKEN?.trim() || '';
      if (
        !activeToken ||
        !githubStore.repo ||
        !githubStore.uploadAllowed ||
        !githubStore.autoLogSignals
      ) {
        res.json({
          ok: true,
          skipped: true,
          reason: 'upload_not_allowed_or_auto_log_disabled',
        });
        return;
      }

      const targetPath = 'data/signals-log.json';
      const targetRepo = githubStore.repo;
      const targetBranch = githubStore.branch || 'main';
      const jsonContent = JSON.stringify(
        {
          updatedAt: new Date().toISOString(),
          count: signalHistoryBuffer.length,
          signals: signalHistoryBuffer,
        },
        null,
        2
      );
      const contentBase64 = Buffer.from(jsonContent, 'utf8').toString('base64');

      let existingSha: string | undefined;
      const getRes = await fetch(
        `https://api.github.com/repos/${targetRepo}/contents/${targetPath}?ref=${encodeURIComponent(
          targetBranch
        )}`,
        { headers: ghHeaders(activeToken) }
      );
      if (getRes.ok) {
        const getData = (await getRes.json()) as { sha?: string };
        existingSha = getData.sha;
      }

      const putRes = await fetch(
        `https://api.github.com/repos/${targetRepo}/contents/${targetPath}`,
        {
          method: 'PUT',
          headers: {
            ...ghHeaders(activeToken),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message: `chore: log US100 M5 signal (${formatBkkHm(Date.now())})`,
            content: contentBase64,
            branch: targetBranch,
            ...(existingSha ? { sha: existingSha } : {}),
          }),
        }
      );
      const putData = (await putRes.json()) as {
        message?: string;
        commit?: { sha?: string; html_url?: string };
      };
      if (!putRes.ok) {
        res.status(400).json({
          ok: false,
          message: putData.message || `HTTP ${putRes.status}`,
        });
        return;
      }

      const uploadedAt = new Date().toISOString();
      githubStore = {
        ...githubStore,
        lastUploadAt: uploadedAt,
        lastCommitUrl: putData.commit?.html_url || githubStore.lastCommitUrl,
      };
      saveRuntimeGitHubStore(githubStore);

      res.json({
        ok: true,
        uploadedAt,
        commitUrl: githubStore.lastCommitUrl,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        message: error instanceof Error ? error.message : 'Signal log upload error',
      });
    }
  });

  app.post('/api/github/upload', async (req, res) => {
    try {
      const { latestSignal } = (req.body || {}) as {
        latestSignal?: Record<string, unknown> | null;
      };

      const activeToken =
        githubStore.token.trim() || process.env.GITHUB_TOKEN?.trim() || '';
      const targetRepo = githubStore.repo.trim();
      const targetBranch = githubStore.branch.trim() || 'main';

      if (!activeToken || !targetRepo) {
        res.status(400).json({
          ok: false,
          message: 'กรุณากรอก Token และบันทึกการเชื่อมต่อ GitHub ก่อนอัปโหลด',
        });
        return;
      }

      if (!githubStore.uploadAllowed) {
        res.status(403).json({
          ok: false,
          message: 'ยังไม่อนุญาตอัปโหลด — กรุณากดปุ่ม "อนุญาตอัปโหลดขึ้น GitHub" ก่อน',
        });
        return;
      }

      if (latestSignal && typeof latestSignal === 'object') {
        const exists = signalHistoryBuffer.some((s) => s.id === latestSignal.id);
        if (!exists) {
          signalHistoryBuffer.unshift(latestSignal);
          if (signalHistoryBuffer.length > 50) signalHistoryBuffer.length = 50;
        }
      }

      if (githubStore.username && githubStore.repoName) {
        const ensured = await ensureGitHubRepoExists({
          token: activeToken,
          username: githubStore.username,
          repoName: githubStore.repoName,
          isPrivate: githubStore.isPrivate,
        });
        if (!ensured.ok) {
          res.status(400).json({ ok: false, message: ensured.message });
          return;
        }
      }

      const projectFiles = collectProjectFilesForUpload();
      if (githubStore.autoLogSignals) {
        const signalsJson = JSON.stringify(
          {
            updatedAt: new Date().toISOString(),
            count: signalHistoryBuffer.length,
            signals: signalHistoryBuffer,
          },
          null,
          2
        );
        projectFiles.push({
          path: 'data/signals-log.json',
          contentBase64: Buffer.from(signalsJson, 'utf8').toString('base64'),
        });
      }

      if (projectFiles.length === 0) {
        res.status(400).json({ ok: false, message: 'ไม่พบไฟล์โปรเจกต์สำหรับอัปโหลด' });
        return;
      }

      let refRes = await fetch(
        `https://api.github.com/repos/${targetRepo}/git/ref/heads/${encodeURIComponent(
          targetBranch
        )}`,
        { headers: ghHeaders(activeToken) }
      );

      if (refRes.status === 404 || refRes.status === 409) {
        const firstFile =
          projectFiles.find((f) => f.path === '.gitignore') || projectFiles[0];
        const initRes = await fetch(
          `https://api.github.com/repos/${targetRepo}/contents/${firstFile.path}`,
          {
            method: 'PUT',
            headers: {
              ...ghHeaders(activeToken),
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              message: `chore: initialize ${targetBranch} branch`,
              content: firstFile.contentBase64,
              branch: targetBranch,
            }),
          }
        );
        if (!initRes.ok) {
          const initErr = (await initRes.json().catch(() => ({}))) as {
            message?: string;
          };
          res.status(400).json({
            ok: false,
            message: `ไม่พบ Branch "${targetBranch}" และสร้าง Branch ใหม่ไม่สำเร็จ: ${
              initErr.message || initRes.status
            }`,
          });
          return;
        }
        refRes = await fetch(
          `https://api.github.com/repos/${targetRepo}/git/ref/heads/${encodeURIComponent(
            targetBranch
          )}`,
          { headers: ghHeaders(activeToken) }
        );
      }

      if (!refRes.ok) {
        const refErr = (await refRes.json().catch(() => ({}))) as { message?: string };
        res.status(400).json({
          ok: false,
          message: `ไม่สามารถอ่าน Branch "${targetBranch}": ${
            refErr.message || refRes.status
          }`,
        });
        return;
      }

      const refData = (await refRes.json()) as { object?: { sha?: string } };
      const headSha = refData.object?.sha;
      if (!headSha) {
        res.status(400).json({ ok: false, message: 'ไม่พบ Commit SHA ล่าสุดของ Branch' });
        return;
      }

      const headCommitRes = await fetch(
        `https://api.github.com/repos/${targetRepo}/git/commits/${headSha}`,
        { headers: ghHeaders(activeToken) }
      );
      const headCommitData = (await headCommitRes.json()) as {
        tree?: { sha?: string };
      };
      const baseTreeSha = headCommitData.tree?.sha;

      const treeEntries: Array<{
        path: string;
        mode: '100644';
        type: 'blob';
        sha: string;
      }> = [];

      for (let i = 0; i < projectFiles.length; i += 5) {
        const batch = projectFiles.slice(i, i + 5);
        const batchResults = await Promise.all(
          batch.map(async (f) => {
            const blobRes = await fetch(
              `https://api.github.com/repos/${targetRepo}/git/blobs`,
              {
                method: 'POST',
                headers: {
                  ...ghHeaders(activeToken),
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  content: f.contentBase64,
                  encoding: 'base64',
                }),
              }
            );
            const blobData = (await blobRes.json()) as {
              sha?: string;
              message?: string;
            };
            if (!blobRes.ok || !blobData.sha) {
              throw new Error(
                `อัปโหลดไฟล์ ${f.path} ไม่สำเร็จ: ${blobData.message || blobRes.status}`
              );
            }
            return {
              path: f.path,
              mode: '100644' as const,
              type: 'blob' as const,
              sha: blobData.sha,
            };
          })
        );
        treeEntries.push(...batchResults);
      }

      const treeRes = await fetch(
        `https://api.github.com/repos/${targetRepo}/git/trees`,
        {
          method: 'POST',
          headers: {
            ...ghHeaders(activeToken),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            ...(baseTreeSha ? { base_tree: baseTreeSha } : {}),
            tree: treeEntries,
          }),
        }
      );
      const treeData = (await treeRes.json()) as { sha?: string; message?: string };
      if (!treeRes.ok || !treeData.sha) {
        res.status(400).json({
          ok: false,
          message: `สร้าง Git Tree ไม่สำเร็จ: ${treeData.message || treeRes.status}`,
        });
        return;
      }

      const commitMsg = `chore: sync US100 M5 Studio (${formatBkkHm(Date.now())})`;
      const commitRes = await fetch(
        `https://api.github.com/repos/${targetRepo}/git/commits`,
        {
          method: 'POST',
          headers: {
            ...ghHeaders(activeToken),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message: commitMsg,
            tree: treeData.sha,
            parents: [headSha],
          }),
        }
      );
      const commitData = (await commitRes.json()) as {
        sha?: string;
        html_url?: string;
        message?: string;
      };
      if (!commitRes.ok || !commitData.sha) {
        res.status(400).json({
          ok: false,
          message: `สร้าง Commit ไม่สำเร็จ: ${commitData.message || commitRes.status}`,
        });
        return;
      }

      const updateRefRes = await fetch(
        `https://api.github.com/repos/${targetRepo}/git/refs/heads/${encodeURIComponent(
          targetBranch
        )}`,
        {
          method: 'PATCH',
          headers: {
            ...ghHeaders(activeToken),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ sha: commitData.sha }),
        }
      );
      if (!updateRefRes.ok) {
        const refUpdErr = (await updateRefRes.json().catch(() => ({}))) as {
          message?: string;
        };
        res.status(400).json({
          ok: false,
          message: `อัปเดต Branch ไม่สำเร็จ: ${
            refUpdErr.message || updateRefRes.status
          }`,
        });
        return;
      }

      const uploadedAt = new Date().toISOString();
      const commitUrl =
        commitData.html_url ||
        `https://github.com/${targetRepo}/commit/${commitData.sha}`;
      githubStore = {
        ...githubStore,
        syncedFileCount: treeEntries.length,
        lastUploadAt: uploadedAt,
        lastCommitUrl: commitUrl,
      };
      saveRuntimeGitHubStore(githubStore);

      res.json({
        ok: true,
        fileCount: treeEntries.length,
        commitSha: commitData.sha,
        commitUrl,
        uploadedAt,
        message: `ซิงค์ ${treeEntries.length} ไฟล์ขึ้น ${targetRepo} (${targetBranch}) สำเร็จแล้ว`,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        message: error instanceof Error ? error.message : 'GitHub upload failed',
      });
    }
  });

  // 24/7 Server-side Live M5 AO ZeroCross Telegram Watcher (deduplicated with frontend)
  const formatAo3 = (val: number) => `${val >= 0 ? '+' : '-'}${Math.abs(val).toFixed(3)}`;
  setInterval(async () => {
    try {
      const bars = liveCfdFeed.getOrderedBars();
      if (bars.length < 38) return;
      const payload = buildAoMarketPayload({
        rawBars: bars,
        feedSymbol: 'US100Cash',
        feedProvider: liveCfdFeed.activeProvider,
        isRealtimeStream: true,
        bid: liveCfdFeed.bid,
        ask: liveCfdFeed.ask,
        lastPrice: liveCfdFeed.lastPrice,
        lastTickMs: liveCfdFeed.lastTickMs,
        barCloseTimeMs: liveCfdFeed.barCloseTimeMs,
      });
      if (!payload.latestBarCross) return;

      const bar1 = payload.candles.find((c) => c.shift === 1);
      const bar2 = payload.candles.find((c) => c.shift === 2);
      if (!bar1 || !bar2) return;

      const liveKey = `${bar1.timestampIso}_${payload.latestBarCross}`;
      if (telegramStore.lastSentLiveKey === liveKey) return;

      const botToken =
        telegramStore.botToken.trim() || process.env.TELEGRAM_BOT_TOKEN?.trim() || '';
      const targetChatId = telegramStore.chatId.trim() || DEFAULT_TELEGRAM_CHAT_ID;
      if (!botToken || !targetChatId) return;

      telegramStore = { ...telegramStore, lastSentLiveKey: liveKey };
      saveRuntimeTelegramStore(telegramStore);

      const headIcon = payload.latestBarCross === 'BUY' ? '🟢' : '🔴';
      const condText =
        payload.latestBarCross === 'BUY'
          ? 'AO ตัดเส้น 0 ขึ้น 🟢⬆️'
          : 'AO ตัดเส้น 0 ลง 🔴⬇️';
      const msgText = [
        `<b>${headIcon} ${payload.latestBarCross} · US100 (M5)</b>`,
        `____________________`,
        `เงื่อนไข: ${condText}`,
        `ค่า AO: ${formatAo3(bar2.ao)} → ${formatAo3(bar1.ao)}`,
        `โหมด: กราฟจริง`,
        `เวลา: ${bar1.timeLabel} น.`,
      ].join('\n');

      const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: targetChatId,
          text: msgText,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });
      if (!tgRes.ok) {
        telegramStore = { ...telegramStore, lastSentLiveKey: undefined };
        saveRuntimeTelegramStore(telegramStore);
      }
    } catch {
      // keep background monitor resilient
    }
  }, 5000);

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`AO ZeroCross M5 Studio running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
