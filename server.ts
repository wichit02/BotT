import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import type webpushTypes from 'web-push';

const require = createRequire(import.meta.url);
const webpush = require('web-push') as typeof webpushTypes;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type TradingSymbol = 'US100';

interface M5Candle {
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
  signal: 'BUY' | 'SELL' | null;
}

interface MarketFeedResult {
  symbol: TradingSymbol;
  source: string;
  marketState: string;
  fetchedAt: string;
  lastTickAt?: string | null;
  bid?: number;
  ask?: number;
  bars: M5Candle[];
}

interface MonitorAlertEvent {
  id: string;
  timestamp: string;
  symbol: TradingSymbol;
  signal: 'BUY' | 'SELL';
  aoPrev: number;
  aoCurr: number;
  price: number;
  deliveredToNtfy: boolean;
  deliveredToTelegram: boolean;
  deliveredWebPushCount: number;
}

interface StoredPushSubscription {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

interface StochMonitorConfig {
  kPeriod: number;
  dPeriod: number;
  slowing: number;
  upperLevel: number;
  lowerLevel: number;
}

const DEFAULT_STOCH_CONFIG: StochMonitorConfig = {
  kPeriod: 15,
  dPeriod: 3,
  slowing: 3,
  upperLevel: 80,
  lowerLevel: 20,
};

interface PersistedServerState {
  vapidKeys: { publicKey: string; privateKey: string };
  enabled: boolean;
  symbols: TradingSymbol[];
  ntfyTopic: string;
  telegramBotToken: string;
  telegramChatId: string;
  telegramMode: 'fallback' | 'always';
  direction: 'both' | 'buy_only' | 'sell_only';
  subscriptions: StoredPushSubscription[];
  events: MonitorAlertEvent[];
  githubToken: string;
  githubOwner: string;
  githubRepo: string;
  githubBranch: string;
  githubPrivate: boolean;
  githubAutoSyncCode: boolean;
  githubSyncSignals: boolean;
  githubLastSyncedHash: string;
  githubLastSyncAt: string | null;
  githubLastCommitUrl: string | null;
  githubLastError: string | null;
  alertedBarKeys: string[];
  alertedStochBarKeys: string[];
  stochConfig: StochMonitorConfig;
  lastLiveDirectionBySymbol: Partial<Record<TradingSymbol, 'BUY' | 'SELL'>>;
}

const YAHOO_SYMBOL_MAP: Record<TradingSymbol, { ticker: string; digits: number }> = {
  US100: { ticker: 'NQ=F', digits: 2 },
};

const ALL_SYMBOLS: TradingSymbol[] = ['US100'];
const STATE_DIR = path.resolve(__dirname, '.data');
const STATE_FILE = path.join(STATE_DIR, 'ao-server-state.json');

const feedCache = new Map<TradingSymbol, { expiresAt: number; data: MarketFeedResult }>();
const feedCacheM1 = new Map<TradingSymbol, { expiresAt: number; data: MarketFeedResult }>();

function normalizeTelegramChatId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  // Telegram supergroups/channels are 13-digit IDs starting with -100 (often copied without leading '-')
  if (/^100\d{9,}$/.test(trimmed)) {
    return `-${trimmed}`;
  }
  return trimmed;
}

function loadPersistedState(): PersistedServerState {
  const envPublic = process.env.VAPID_PUBLIC_KEY?.trim();
  const envPrivate = process.env.VAPID_PRIVATE_KEY?.trim();
  const envTgToken = process.env.TELEGRAM_BOT_TOKEN?.trim() || '';
  const envTgChatId = normalizeTelegramChatId(process.env.TELEGRAM_CHAT_ID || '');
  const envTgMode = process.env.TELEGRAM_MODE?.trim() === 'fallback' ? 'fallback' : 'always';
  const envNtfy = process.env.NTFY_TOPIC?.trim() || '';
  const envGithubToken = process.env.GITHUB_TOKEN?.trim() || '';
  const envGithubOwner = process.env.GITHUB_OWNER?.trim() || '';
  const envGithubRepo = process.env.GITHUB_REPO?.trim() || 'ao-signal-studio';
  const envGithubBranch = process.env.GITHUB_BRANCH?.trim() || 'main';

  try {
    if (fs.existsSync(STATE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as Partial<PersistedServerState>;
      const vapidKeys =
        envPublic && envPrivate
          ? { publicKey: envPublic, privateKey: envPrivate }
          : parsed.vapidKeys?.publicKey && parsed.vapidKeys?.privateKey
          ? parsed.vapidKeys
          : webpush.generateVAPIDKeys();

      return {
        vapidKeys,
        enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : true,
        symbols:
          Array.isArray(parsed.symbols) &&
          parsed.symbols.some((s): s is TradingSymbol => typeof s === 'string' && s in YAHOO_SYMBOL_MAP)
            ? parsed.symbols.filter((s): s is TradingSymbol => typeof s === 'string' && s in YAHOO_SYMBOL_MAP)
            : ALL_SYMBOLS,
        ntfyTopic:
          typeof parsed.ntfyTopic === 'string' && parsed.ntfyTopic
            ? parsed.ntfyTopic
            : envNtfy,
        telegramBotToken:
          typeof parsed.telegramBotToken === 'string' && parsed.telegramBotToken
            ? parsed.telegramBotToken
            : envTgToken,
        telegramChatId:
          typeof parsed.telegramChatId === 'string' && parsed.telegramChatId
            ? normalizeTelegramChatId(parsed.telegramChatId)
            : envTgChatId,
        telegramMode:
          parsed.telegramMode === 'fallback' || parsed.telegramMode === 'always'
            ? parsed.telegramMode
            : envTgMode,
        direction:
          parsed.direction === 'buy_only' || parsed.direction === 'sell_only'
            ? parsed.direction
            : 'both',
        subscriptions: Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [],
        events: Array.isArray(parsed.events) ? parsed.events.slice(0, 30) : [],
        githubToken:
          typeof parsed.githubToken === 'string' && parsed.githubToken
            ? parsed.githubToken
            : envGithubToken,
        githubOwner:
          typeof parsed.githubOwner === 'string' && parsed.githubOwner
            ? parsed.githubOwner
            : envGithubOwner,
        githubRepo:
          typeof parsed.githubRepo === 'string' && parsed.githubRepo
            ? parsed.githubRepo
            : envGithubRepo,
        githubBranch:
          typeof parsed.githubBranch === 'string' && parsed.githubBranch
            ? parsed.githubBranch
            : envGithubBranch,
        githubPrivate: typeof parsed.githubPrivate === 'boolean' ? parsed.githubPrivate : true,
        githubAutoSyncCode:
          typeof parsed.githubAutoSyncCode === 'boolean' ? parsed.githubAutoSyncCode : true,
        githubSyncSignals:
          typeof parsed.githubSyncSignals === 'boolean' ? parsed.githubSyncSignals : true,
        githubLastSyncedHash:
          typeof parsed.githubLastSyncedHash === 'string' ? parsed.githubLastSyncedHash : '',
        githubLastSyncAt:
          typeof parsed.githubLastSyncAt === 'string' ? parsed.githubLastSyncAt : null,
        githubLastCommitUrl:
          typeof parsed.githubLastCommitUrl === 'string' ? parsed.githubLastCommitUrl : null,
        githubLastError:
          typeof parsed.githubLastError === 'string' ? parsed.githubLastError : null,
        alertedBarKeys: Array.isArray(parsed.alertedBarKeys)
          ? parsed.alertedBarKeys.filter((k): k is string => typeof k === 'string').slice(0, 60)
          : [],
        alertedStochBarKeys: Array.isArray(parsed.alertedStochBarKeys)
          ? parsed.alertedStochBarKeys.filter((k): k is string => typeof k === 'string').slice(0, 60)
          : [],
        stochConfig:
          parsed.stochConfig && typeof parsed.stochConfig === 'object'
            ? {
                kPeriod: Math.max(1, Math.floor(Number(parsed.stochConfig.kPeriod) || 15)),
                dPeriod: Math.max(1, Math.floor(Number(parsed.stochConfig.dPeriod) || 3)),
                slowing: Math.max(1, Math.floor(Number(parsed.stochConfig.slowing) || 3)),
                upperLevel: Math.min(99, Math.max(51, Number(parsed.stochConfig.upperLevel) || 80)),
                lowerLevel: Math.max(1, Math.min(49, Number(parsed.stochConfig.lowerLevel) || 20)),
              }
            : { ...DEFAULT_STOCH_CONFIG },
        lastLiveDirectionBySymbol:
          parsed.lastLiveDirectionBySymbol && typeof parsed.lastLiveDirectionBySymbol === 'object'
            ? parsed.lastLiveDirectionBySymbol
            : {},
      };
    }
  } catch {
    // Fall back to fresh default state
  }

  const vapidKeys =
    envPublic && envPrivate
      ? { publicKey: envPublic, privateKey: envPrivate }
      : webpush.generateVAPIDKeys();

  const initial: PersistedServerState = {
    vapidKeys,
    enabled: true,
    symbols: ALL_SYMBOLS,
    ntfyTopic: envNtfy,
    telegramBotToken: envTgToken,
    telegramChatId: envTgChatId,
    telegramMode: envTgMode,
    direction: 'both',
    subscriptions: [],
    events: [],
    githubToken: envGithubToken,
    githubOwner: envGithubOwner,
    githubRepo: envGithubRepo,
    githubBranch: envGithubBranch,
    githubPrivate: true,
    githubAutoSyncCode: true,
    githubSyncSignals: true,
    githubLastSyncedHash: '',
    githubLastSyncAt: null,
    githubLastCommitUrl: null,
    githubLastError: null,
    alertedBarKeys: [],
    alertedStochBarKeys: [],
    stochConfig: { ...DEFAULT_STOCH_CONFIG },
    lastLiveDirectionBySymbol: {},
  };
  savePersistedState(initial);
  return initial;
}

function savePersistedState(state: PersistedServerState): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch {
    // Ignore read-only filesystem errors
  }
}

const persisted = loadPersistedState();

webpush.setVapidDetails(
  'mailto:alerts@aosignal.local',
  persisted.vapidKeys.publicKey,
  persisted.vapidKeys.privateKey
);

const monitorRuntime = {
  lastCheckedAt: null as string | null,
  lastCheckedMs: 0,
  isRunningCycle: false,
  lastBarBySymbol: {} as Partial<Record<TradingSymbol, string>>,
  lastClosedBarBucketMsBySymbol: {} as Partial<Record<TradingSymbol, number>>,
  dispatchedLiveSignalKeys: new Set<string>(),
  dispatchedStochSignalKeys: new Set<string>(),
};

function markLiveSignalDispatched(key: string) {
  monitorRuntime.dispatchedLiveSignalKeys.add(key);
  if (monitorRuntime.dispatchedLiveSignalKeys.size > 300) {
    const first = monitorRuntime.dispatchedLiveSignalKeys.values().next().value;
    if (first) monitorRuntime.dispatchedLiveSignalKeys.delete(first);
  }
}

function normalizeM5BarKey(sym: TradingSymbol, barTimestampIso: string): string {
  const ms = Date.parse(barTimestampIso);
  if (Number.isFinite(ms)) {
    const bucketMs = Math.floor(ms / 300000) * 300000;
    return `${sym}-${new Date(bucketMs).toISOString()}`;
  }
  return `${sym}-${barTimestampIso}`;
}

function hasClosedBarBeenAlerted(
  sym: TradingSymbol,
  barTimestampIso: string,
  _signal?: 'BUY' | 'SELL'
): boolean {
  const bucketKey = normalizeM5BarKey(sym, barTimestampIso);
  return (
    monitorRuntime.dispatchedLiveSignalKeys.has(bucketKey) ||
    persisted.alertedBarKeys.includes(bucketKey) ||
    persisted.alertedBarKeys.includes(`${bucketKey}-BUY`) ||
    persisted.alertedBarKeys.includes(`${bucketKey}-SELL`)
  );
}

function recordClosedBarAlerted(
  sym: TradingSymbol,
  barTimestampIso: string,
  signal: 'BUY' | 'SELL'
): void {
  const bucketKey = normalizeM5BarKey(sym, barTimestampIso);
  markLiveSignalDispatched(bucketKey);
  if (!persisted.alertedBarKeys.includes(bucketKey)) {
    persisted.alertedBarKeys = [bucketKey, ...persisted.alertedBarKeys].slice(0, 60);
  }
  persisted.lastLiveDirectionBySymbol[sym] = signal;
  syncPersistence();
}

function hasClosedStochBarBeenAlerted(sym: TradingSymbol, barTimestampIso: string): boolean {
  const bucketKey = `STOCH-${normalizeM5BarKey(sym, barTimestampIso)}`;
  return (
    monitorRuntime.dispatchedStochSignalKeys.has(bucketKey) ||
    persisted.alertedStochBarKeys.includes(bucketKey)
  );
}

function recordClosedStochBarAlerted(sym: TradingSymbol, barTimestampIso: string): void {
  const bucketKey = `STOCH-${normalizeM5BarKey(sym, barTimestampIso)}`;
  monitorRuntime.dispatchedStochSignalKeys.add(bucketKey);
  if (monitorRuntime.dispatchedStochSignalKeys.size > 300) {
    const first = monitorRuntime.dispatchedStochSignalKeys.values().next().value;
    if (first) monitorRuntime.dispatchedStochSignalKeys.delete(first);
  }
  if (!persisted.alertedStochBarKeys.includes(bucketKey)) {
    persisted.alertedStochBarKeys = [bucketKey, ...persisted.alertedStochBarKeys].slice(0, 60);
  }
  syncPersistence();
}

function syncPersistence() {
  savePersistedState(persisted);
}

const CRC_TABLE = (() => {
  const tbl = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    tbl[i] = c >>> 0;
  }
  return tbl;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function collectDeployableFiles(rootDir: string): string[] {
  const skipDirs = new Set(['node_modules', '.git', '.data', 'dist', '.vite']);
  const skipFilePrefixes = ['.env'];
  const skipExactFiles = new Set(['.env', '.env.local']);
  const results: string[] = [];

  const walk = (dir: string, relBase: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        if (relPath === 'public/assets/aistudio') continue;
        walk(path.join(dir, entry.name), relPath);
      } else if (entry.isFile()) {
        if (skipExactFiles.has(entry.name)) continue;
        if (skipFilePrefixes.some((p) => entry.name.startsWith(p) && entry.name !== '.env.example')) {
          continue;
        }
        if (entry.name.endsWith('.zip')) continue;
        results.push(relPath);
      }
    }
  };

  walk(rootDir, '');
  return results.sort();
}

function buildZipBuffer(rootDir: string, relPaths: string[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const relPath of relPaths) {
    const fullPath = path.join(rootDir, relPath);
    const raw = fs.readFileSync(fullPath);
    const compressed = zlib.deflateRawSync(raw);
    const crc = crc32(raw);
    const nameBuf = Buffer.from(`ao-signal-studio/${relPath}`, 'utf-8');

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0x5421, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(raw.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x5421, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(raw.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + compressed.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(relPaths.length, 8);
  eocd.writeUInt16LE(relPaths.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

const githubRuntime = {
  isSyncing: false,
  pendingResync: false,
  debounceTimer: null as NodeJS.Timeout | null,
};

function sanitizeGithubRepoName(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/^https?:\/\/github\.com\/[^/]+\//i, '')
    .replace(/\.git$/i, '')
    .replace(/[^A-Za-z0-9._-]/g, '-');
  return cleaned || 'ao-signal-studio';
}

function buildSignalsSnapshotJson(): Buffer {
  const payload = {
    app: 'Stoch (M5)',
    monitoredSymbols: persisted.symbols,
    direction: persisted.direction,
    totalCapturedSignals: persisted.events.length,
    latestSignalAt: persisted.events[0]?.timestamp || null,
    events: persisted.events.map((ev) => ({
      id: ev.id,
      timestamp: ev.timestamp,
      symbol: ev.symbol,
      signal: ev.signal,
      aoPrev: ev.aoPrev,
      aoCurr: ev.aoCurr,
      price: ev.price,
      deliveredToTelegram: ev.deliveredToTelegram,
      deliveredToNtfy: ev.deliveredToNtfy,
      deliveredWebPushCount: ev.deliveredWebPushCount,
    })),
  };
  return Buffer.from(JSON.stringify(payload, null, 2) + '\n', 'utf-8');
}

function computeWorkspaceSnapshot(): {
  entries: Array<{ path: string; buffer: Buffer }>;
  hash: string;
} {
  const relFiles = collectDeployableFiles(__dirname);
  const hasher = crypto.createHash('sha256');
  const entries: Array<{ path: string; buffer: Buffer }> = [];

  for (const relPath of relFiles) {
    try {
      const buf = fs.readFileSync(path.join(__dirname, relPath));
      entries.push({ path: relPath, buffer: buf });
      hasher.update(relPath);
      hasher.update('\0');
      hasher.update(buf);
      hasher.update('\0');
    } catch {
      // Skip file if deleted mid-scan
    }
  }

  if (persisted.githubSyncSignals) {
    const signalsBuf = buildSignalsSnapshotJson();
    entries.push({ path: 'data/signals-log.json', buffer: signalsBuf });
    hasher.update('data/signals-log.json');
    hasher.update('\0');
    hasher.update(signalsBuf);
    hasher.update('\0');
  }

  return {
    entries,
    hash: hasher.digest('hex'),
  };
}

async function githubApiRequest<T = any>(
  token: string,
  method: string,
  endpointPath: string,
  body?: unknown
): Promise<{ status: number; ok: boolean; data: T; errorMessage?: string }> {
  const url = endpointPath.startsWith('https://')
    ? endpointPath
    : `https://api.github.com${endpointPath}`;

  const res = await fetch(url, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'AO-Signal-Studio',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });

  const text = await res.text();
  let parsed: any = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { message: text };
  }

  return {
    status: res.status,
    ok: res.ok,
    data: parsed as T,
    errorMessage: !res.ok ? parsed?.message || `GitHub HTTP ${res.status}` : undefined,
  };
}

async function fetchGithubAuthenticatedUser(token: string): Promise<{
  ok: boolean;
  login?: string;
  name?: string;
  error?: string;
}> {
  const clean = token.trim();
  if (!clean) return { ok: false, error: 'กรุณากรอก GitHub Personal Access Token' };
  try {
    const res = await githubApiRequest<{ login?: string; name?: string }>(
      clean,
      'GET',
      '/user'
    );
    if (!res.ok || !res.data?.login) {
      return {
        ok: false,
        error:
          res.status === 401
            ? 'GitHub Token ไม่ถูกต้องหรือหมดอายุ กรุณาสร้าง Token ที่มีสิทธิ์ repo ใหม่'
            : res.errorMessage || 'ตรวจสอบบัญชี GitHub ไม่สำเร็จ',
      };
    }
    return { ok: true, login: res.data.login, name: res.data.name };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'เชื่อมต่อ GitHub.com ไม่สำเร็จ' };
  }
}

async function ensureGithubRepoAndBranch(params: {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  isPrivate: boolean;
  authenticatedLogin: string;
}): Promise<{ parentCommitSha: string }> {
  const { token, owner, repo, branch, isPrivate, authenticatedLogin } = params;
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  let repoRes = await githubApiRequest<{ default_branch?: string }>(token, 'GET', repoPath);

  if (repoRes.status === 404) {
    if (owner.toLowerCase() !== authenticatedLogin.toLowerCase()) {
      throw new Error(
        `ไม่พบ Repository "${owner}/${repo}" หรือ Token ไม่มีสิทธิ์สร้างภายใต้ชื่อ ${owner}`
      );
    }
    const createRes = await githubApiRequest<{ default_branch?: string }>(
      token,
      'POST',
      '/user/repos',
      {
        name: repo,
        private: isPrivate,
        auto_init: true,
        description:
          'AO Signal Studio — Real-Time Awesome Oscillator M5 Monitor & Alert System',
      }
    );
    if (!createRes.ok) {
      throw new Error(createRes.errorMessage || `สร้าง Repository "${repo}" บน GitHub ไม่สำเร็จ`);
    }
    repoRes = createRes;
    await new Promise((r) => setTimeout(r, 900));
  } else if (!repoRes.ok) {
    throw new Error(repoRes.errorMessage || 'ไม่สามารถเข้าถึง Repository บน GitHub ได้');
  }

  const refPath = `${repoPath}/git/ref/heads/${encodeURIComponent(branch)}`;
  const refRes = await githubApiRequest<{ object?: { sha?: string } }>(token, 'GET', refPath);
  if (refRes.ok && refRes.data?.object?.sha) {
    return { parentCommitSha: refRes.data.object.sha };
  }

  // Try seeding empty repo or branching off default_branch
  const defaultBranch = repoRes.data?.default_branch;
  if (defaultBranch && defaultBranch !== branch) {
    const defRefRes = await githubApiRequest<{ object?: { sha?: string } }>(
      token,
      'GET',
      `${repoPath}/git/ref/heads/${encodeURIComponent(defaultBranch)}`
    );
    if (defRefRes.ok && defRefRes.data?.object?.sha) {
      const createBranchRes = await githubApiRequest<{ object?: { sha?: string } }>(
        token,
        'POST',
        `${repoPath}/git/refs`,
        {
          ref: `refs/heads/${branch}`,
          sha: defRefRes.data.object.sha,
        }
      );
      if (createBranchRes.ok && createBranchRes.data?.object?.sha) {
        return { parentCommitSha: createBranchRes.data.object.sha };
      }
    }
  }

  // Repo is completely empty (404/409 on git/refs) -> bootstrap README via Contents API
  const initContent = Buffer.from(
    '# AO Signal Studio\n\nInitializing real-time workspace sync...\n',
    'utf-8'
  ).toString('base64');
  const seedRes = await githubApiRequest<{ commit?: { sha?: string } }>(
    token,
    'PUT',
    `${repoPath}/contents/README.md`,
    {
      message: 'chore: initialize repository',
      content: initContent,
      branch,
    }
  );
  if (!seedRes.ok || !seedRes.data?.commit?.sha) {
    throw new Error(
      seedRes.errorMessage || `ไม่สามารถสร้าง Branch "${branch}" ใน Repository ได้`
    );
  }
  return { parentCommitSha: seedRes.data.commit.sha };
}

async function syncWorkspaceToGithub(options?: {
  force?: boolean;
  reason?: string;
}): Promise<{
  ok: boolean;
  committed: boolean;
  syncedFilesCount: number;
  commitUrl?: string;
  error?: string;
}> {
  const token = persisted.githubToken.trim();
  const repo = sanitizeGithubRepoName(persisted.githubRepo);
  const branch = persisted.githubBranch.trim() || 'main';
  if (!token || !repo) {
    return { ok: false, committed: false, syncedFilesCount: 0, error: 'ยังไม่ได้ตั้งค่า GitHub' };
  }

  if (githubRuntime.isSyncing) {
    githubRuntime.pendingResync = true;
    return {
      ok: true,
      committed: false,
      syncedFilesCount: 0,
    };
  }

  const snapshot = computeWorkspaceSnapshot();
  if (!options?.force && snapshot.hash === persisted.githubLastSyncedHash) {
    return {
      ok: true,
      committed: false,
      syncedFilesCount: snapshot.entries.length,
      commitUrl: persisted.githubLastCommitUrl || undefined,
    };
  }

  githubRuntime.isSyncing = true;
  try {
    const userRes = await fetchGithubAuthenticatedUser(token);
    if (!userRes.ok || !userRes.login) {
      throw new Error(userRes.error || 'ตรวจสอบ GitHub Token ไม่สำเร็จ');
    }

    const owner = persisted.githubOwner.trim() || userRes.login;
    if (persisted.githubOwner !== owner) {
      persisted.githubOwner = owner;
    }

    const { parentCommitSha } = await ensureGithubRepoAndBranch({
      token,
      owner,
      repo,
      branch,
      isPrivate: persisted.githubPrivate,
      authenticatedLogin: userRes.login,
    });

    const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const treeItems: Array<{
      path: string;
      mode: '100644';
      type: 'blob';
      sha: string;
    }> = [];

    // Upload file blobs in small parallel batches to stay fast without hitting secondary limits
    const BATCH_SIZE = 8;
    for (let i = 0; i < snapshot.entries.length; i += BATCH_SIZE) {
      const batch = snapshot.entries.slice(i, i + BATCH_SIZE);
      const uploaded = await Promise.all(
        batch.map(async (item) => {
          const blobRes = await githubApiRequest<{ sha?: string }>(
            token,
            'POST',
            `${repoPath}/git/blobs`,
            {
              content: item.buffer.toString('base64'),
              encoding: 'base64',
            }
          );
          if (!blobRes.ok || !blobRes.data?.sha) {
            throw new Error(
              `อัปโหลดไฟล์ ${item.path} ไม่สำเร็จ: ${blobRes.errorMessage || 'Blob error'}`
            );
          }
          return {
            path: item.path,
            mode: '100644' as const,
            type: 'blob' as const,
            sha: blobRes.data.sha,
          };
        })
      );
      treeItems.push(...uploaded);
    }

    const treeRes = await githubApiRequest<{ sha?: string }>(
      token,
      'POST',
      `${repoPath}/git/trees`,
      { tree: treeItems }
    );
    if (!treeRes.ok || !treeRes.data?.sha) {
      throw new Error(treeRes.errorMessage || 'สร้าง Git Tree บน GitHub ไม่สำเร็จ');
    }

    const timestampBkk = new Date().toLocaleString('th-TH', {
      timeZone: 'Asia/Bangkok',
      hour12: false,
    });
    const reasonTag = options?.reason || 'realtime-sync';
    const commitMsg = `sync(${reasonTag}): update ${snapshot.entries.length} files [${timestampBkk}]`;

    const commitRes = await githubApiRequest<{ sha?: string; html_url?: string }>(
      token,
      'POST',
      `${repoPath}/git/commits`,
      {
        message: commitMsg,
        tree: treeRes.data.sha,
        parents: [parentCommitSha],
      }
    );
    if (!commitRes.ok || !commitRes.data?.sha) {
      throw new Error(commitRes.errorMessage || 'สร้าง Commit บน GitHub ไม่สำเร็จ');
    }

    const patchRefRes = await githubApiRequest(
      token,
      'PATCH',
      `${repoPath}/git/refs/heads/${encodeURIComponent(branch)}`,
      {
        sha: commitRes.data.sha,
        force: false,
      }
    );
    if (!patchRefRes.ok) {
      throw new Error(patchRefRes.errorMessage || 'อัปเดต Branch บน GitHub ไม่สำเร็จ');
    }

    const commitUrl =
      commitRes.data.html_url || `https://github.com/${owner}/${repo}/commit/${commitRes.data.sha}`;

    persisted.githubLastSyncedHash = snapshot.hash;
    persisted.githubLastSyncAt = new Date().toISOString();
    persisted.githubLastCommitUrl = commitUrl;
    persisted.githubLastError = null;
    syncPersistence();

    return {
      ok: true,
      committed: true,
      syncedFilesCount: snapshot.entries.length,
      commitUrl,
    };
  } catch (err: any) {
    const errMsg = err?.message || 'ซิงค์ขึ้น GitHub ไม่สำเร็จ';
    persisted.githubLastError = errMsg;
    syncPersistence();
    return {
      ok: false,
      committed: false,
      syncedFilesCount: 0,
      error: errMsg,
    };
  } finally {
    githubRuntime.isSyncing = false;
    if (githubRuntime.pendingResync) {
      githubRuntime.pendingResync = false;
      scheduleGithubAutoSync('pending-change', 1200);
    }
  }
}

function scheduleGithubAutoSync(reason: string, delayMs = 2500) {
  if (!persisted.githubToken || !persisted.githubRepo) return;
  if (reason === 'signal-event' && !persisted.githubSyncSignals) return;
  if (reason !== 'signal-event' && !persisted.githubAutoSyncCode) return;

  if (githubRuntime.debounceTimer) {
    clearTimeout(githubRuntime.debounceTimer);
  }
  githubRuntime.debounceTimer = setTimeout(() => {
    githubRuntime.debounceTimer = null;
    void syncWorkspaceToGithub({ force: false, reason });
  }, delayMs);
}

function startGithubWorkspaceWatchers() {
  const watchTargets = [
    'src',
    'public',
    'server.ts',
    'package.json',
    'index.html',
    'Dockerfile',
    'render.yaml',
    'README.md',
  ];

  for (const target of watchTargets) {
    const fullPath = path.join(__dirname, target);
    if (!fs.existsSync(fullPath)) continue;
    try {
      fs.watch(fullPath, { recursive: fs.statSync(fullPath).isDirectory() }, (_event, fname) => {
        const name = String(fname || '');
        if (name.includes('.data') || name.includes('node_modules') || name.endsWith('.zip')) {
          return;
        }
        scheduleGithubAutoSync('file-watch', 2500);
      });
    } catch {
      // Fallback polling interval covers filesystems where recursive watch isn't supported
    }
  }

  setInterval(() => {
    if (persisted.githubToken && persisted.githubRepo && persisted.githubAutoSyncCode) {
      void syncWorkspaceToGithub({ force: false, reason: 'auto-poll' });
    }
  }, 15000);
}

function buildGithubStatusResponse() {
  const owner = persisted.githubOwner.trim();
  const repo = sanitizeGithubRepoName(persisted.githubRepo);
  const snapshot = computeWorkspaceSnapshot();
  return {
    hasToken: Boolean(persisted.githubToken),
    connected: Boolean(persisted.githubToken && owner && repo),
    owner,
    repo,
    branch: persisted.githubBranch || 'main',
    privateRepo: persisted.githubPrivate,
    autoSyncCode: persisted.githubAutoSyncCode,
    syncSignals: persisted.githubSyncSignals,
    lastSyncAt: persisted.githubLastSyncAt,
    lastCommitUrl: persisted.githubLastCommitUrl,
    lastError: persisted.githubLastError,
    isSyncing: githubRuntime.isSyncing,
    fileCount: snapshot.entries.length,
    workspaceChanged: Boolean(
      persisted.githubToken && snapshot.hash !== persisted.githubLastSyncedHash
    ),
    repoUrl: owner && repo ? `https://github.com/${owner}/${repo}` : null,
  };
}

function roundTo(val: number, digits: number): number {
  const f = Math.pow(10, digits);
  return Math.round(val * f) / f;
}

function formatTimeLabel(date: Date): string {
  return date.toLocaleTimeString('th-TH', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Bangkok',
  });
}

function computeAwesomeOscillator(
  rawBars: Array<Omit<M5Candle, 'ao' | 'aoRising' | 'signal'>>
): M5Candle[] {
  const out: M5Candle[] = [];
  for (let i = 0; i < rawBars.length; i++) {
    const bar = rawBars[i];
    let ao = 0;
    // Standard MT5 Awesome Oscillator: SMA(Median, 5) - SMA(Median, 34), PLOT_DRAW_BEGIN = 33
    if (i >= 33) {
      let sum5 = 0;
      for (let k = i - 4; k <= i; k++) sum5 += rawBars[k].median;
      let sum34 = 0;
      for (let k = i - 33; k <= i; k++) sum34 += rawBars[k].median;
      ao = sum5 / 5 - sum34 / 34;
    }

    const prev = out[i - 1];
    const aoRising = i > 33 && prev ? ao >= prev.ao : true;
    let signal: 'BUY' | 'SELL' | null = null;
    if (i >= 34 && prev) {
      if (prev.ao <= 0 && ao > 0) signal = 'BUY';
      else if (prev.ao >= 0 && ao < 0) signal = 'SELL';
    }

    out.push({ ...bar, ao, aoRising, signal });
  }
  return out;
}

function computeStochMainSeries(
  bars: M5Candle[],
  cfg: StochMonitorConfig
): Array<{ k: number; signal: 'BUY' | 'SELL' | null; triggerType: 'ABOVE_80' | 'BELOW_20' | null }> {
  const kPeriod = Math.max(1, Math.floor(cfg.kPeriod));
  const slowing = Math.max(1, Math.floor(cfg.slowing));
  const numerators: number[] = new Array(bars.length).fill(0);
  const denominators: number[] = new Array(bars.length).fill(0);
  const kValues: number[] = new Array(bars.length).fill(50);

  for (let i = 0; i < bars.length; i++) {
    const startIdx = Math.max(0, i - kPeriod + 1);
    let lowest = Infinity;
    let highest = -Infinity;
    for (let j = startIdx; j <= i; j++) {
      if (bars[j].low < lowest) lowest = bars[j].low;
      if (bars[j].high > highest) highest = bars[j].high;
    }
    numerators[i] = bars[i].close - lowest;
    denominators[i] = highest - lowest;
  }

  for (let i = 0; i < bars.length; i++) {
    const slowStart = Math.max(0, i - slowing + 1);
    let sumNum = 0;
    let sumDen = 0;
    for (let j = slowStart; j <= i; j++) {
      sumNum += numerators[j];
      sumDen += denominators[j];
    }
    const rawK = sumDen > 1e-9 ? (sumNum / sumDen) * 100 : 50;
    kValues[i] = Math.min(100, Math.max(0, rawK));
  }

  const warmup = kPeriod + slowing - 1;
  return kValues.map((k, i) => {
    const prevK = i > 0 ? kValues[i - 1] : k;
    let signal: 'BUY' | 'SELL' | null = null;
    let triggerType: 'ABOVE_80' | 'BELOW_20' | null = null;
    if (i >= warmup) {
      if (prevK <= cfg.upperLevel && k > cfg.upperLevel) {
        signal = 'SELL';
        triggerType = 'ABOVE_80';
      } else if (prevK >= cfg.lowerLevel && k < cfg.lowerLevel) {
        signal = 'BUY';
        triggerType = 'BELOW_20';
      }
    }
    return { k, signal, triggerType };
  });
}

interface RawM5Bar {
  tSec: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

const CFD_TICKERS = ['PEPPERSTONE:NAS100', 'VANTAGE:NAS100', 'ICMARKETS:USTEC'] as const;

const cfdStreamState = {
  tickerIndex: 0,
  barsMap: new Map<number, RawM5Bar>(),
  barsM1Map: new Map<number, RawM5Bar>(),
  bid: 0,
  ask: 0,
  connected: false,
  lastTickAtMs: 0,
  lastError: null as string | null,
  ws: null as WebSocket | null,
  reconnectTimer: null as NodeJS.Timeout | null,
};

const xmMt5Bridge = {
  symbolName: 'US100Cash#',
  broker: 'XM Global MT5',
  bid: 0,
  ask: 0,
  updatedAtMs: 0,
  bars: [] as Array<Omit<M5Candle, 'ao' | 'aoRising' | 'signal'>>,
  barsM1: [] as Array<Omit<M5Candle, 'ao' | 'aoRising' | 'signal'>>,
};

function tvFrame(method: string, params: unknown[]): string {
  const payload = JSON.stringify({ m: method, p: params });
  return `~m~${payload.length}~m~${payload}`;
}

function connectRealtimeCfdStream() {
  if (cfdStreamState.reconnectTimer) {
    clearTimeout(cfdStreamState.reconnectTimer);
    cfdStreamState.reconnectTimer = null;
  }
  if (cfdStreamState.ws) {
    try {
      cfdStreamState.ws.close();
    } catch {
      // Ignore close error
    }
    cfdStreamState.ws = null;
  }

  const ticker = CFD_TICKERS[cfdStreamState.tickerIndex % CFD_TICKERS.length];
  const sessionId = `cs_${Math.random().toString(36).slice(2, 10)}`;
  const quoteSessionId = `qs_${Math.random().toString(36).slice(2, 10)}`;

  try {
    const WsCtor = WebSocket as unknown as new (
      url: string,
      opts?: { headers?: Record<string, string> }
    ) => WebSocket;
    const ws = new WsCtor(
      'wss://data.tradingview.com/socket.io/websocket?from=chart%2F',
      { headers: { Origin: 'https://www.tradingview.com' } }
    );
    cfdStreamState.ws = ws;

    ws.onopen = () => {
      cfdStreamState.connected = true;
      cfdStreamState.lastError = null;
      ws.send(tvFrame('set_auth_token', ['unauthorized_user_token']));
      ws.send(tvFrame('chart_create_session', [sessionId, '']));
      ws.send(
        tvFrame('resolve_symbol', [
          sessionId,
          'sds_sym_1',
          '=' + JSON.stringify({ symbol: ticker, adjustment: 'splits' }),
        ])
      );
      ws.send(tvFrame('create_series', [sessionId, 'sds_1', 's1', 'sds_sym_1', '5', 260]));
      ws.send(tvFrame('create_series', [sessionId, 'sds_2', 's2', 'sds_sym_1', '1', 260]));
      ws.send(tvFrame('quote_create_session', [quoteSessionId]));
      ws.send(tvFrame('quote_add_symbols', [quoteSessionId, ticker]));
    };

    const ingestSeriesRows = (
      targetMap: Map<number, RawM5Bar>,
      rows: Array<{ v?: number[] }>
    ) => {
      if (rows.length === 0) return false;
      for (const row of rows) {
        const v = row?.v;
        if (!Array.isArray(v) || v.length < 5) continue;
        const tSec = Math.floor(Number(v[0]));
        const open = roundTo(Number(v[1]), 2);
        const high = roundTo(Number(v[2]), 2);
        const low = roundTo(Number(v[3]), 2);
        const close = roundTo(Number(v[4]), 2);
        if (
          !Number.isFinite(tSec) ||
          !Number.isFinite(open) ||
          !Number.isFinite(high) ||
          !Number.isFinite(low) ||
          !Number.isFinite(close)
        ) {
          continue;
        }
        targetMap.set(tSec, { tSec, open, high, low, close });
      }
      if (targetMap.size > 320) {
        const sortedKeys = Array.from(targetMap.keys()).sort((a, b) => a - b);
        const toDelete = sortedKeys.length - 300;
        for (let i = 0; i < toDelete; i++) {
          targetMap.delete(sortedKeys[i]);
        }
      }
      return true;
    };

    ws.onmessage = (evt: MessageEvent) => {
      const raw = typeof evt.data === 'string' ? evt.data : String(evt.data || '');
      const parts = raw.split(/~m~\d+~m~/).filter(Boolean);
      for (const part of parts) {
        if (part.startsWith('~h~')) {
          try {
            ws.send(`~m~${part.length}~m~${part}`);
          } catch {
            // Ignore send error on closed socket
          }
          continue;
        }
        try {
          const msg = JSON.parse(part) as { m?: string; p?: any[] };
          if (msg.m === 'symbol_error') {
            cfdStreamState.lastError = `Symbol error: ${ticker}`;
            cfdStreamState.tickerIndex = (cfdStreamState.tickerIndex + 1) % CFD_TICKERS.length;
            ws.close();
            return;
          }
          if (msg.m === 'qsd') {
            const v = msg.p?.[1]?.v;
            if (v && typeof v === 'object') {
              const bidVal = Number(v.bid);
              const askVal = Number(v.ask);
              const lpVal = Number(v.lp);
              if (Number.isFinite(bidVal) && bidVal > 0) {
                cfdStreamState.bid = roundTo(bidVal, 2);
              }
              if (Number.isFinite(askVal) && askVal > 0) {
                cfdStreamState.ask = roundTo(askVal, 2);
              }
              const tickPrice =
                Number.isFinite(lpVal) && lpVal > 0
                  ? roundTo(lpVal, 2)
                  : Number.isFinite(bidVal) && bidVal > 0
                  ? roundTo(bidVal, 2)
                  : 0;
              if (tickPrice > 0) {
                cfdStreamState.lastTickAtMs = Date.now();
                if (cfdStreamState.barsMap.size > 0) {
                  const currentBucketSec = Math.floor(Date.now() / 300000) * 300;
                  const existing = cfdStreamState.barsMap.get(currentBucketSec);
                  if (existing) {
                    existing.close = tickPrice;
                    if (tickPrice > existing.high) existing.high = tickPrice;
                    if (tickPrice < existing.low) existing.low = tickPrice;
                  }
                }
                if (cfdStreamState.barsM1Map.size > 0) {
                  const currentM1BucketSec = Math.floor(Date.now() / 60000) * 60;
                  const existingM1 = cfdStreamState.barsM1Map.get(currentM1BucketSec);
                  if (existingM1) {
                    existingM1.close = tickPrice;
                    if (tickPrice > existingM1.high) existingM1.high = tickPrice;
                    if (tickPrice < existingM1.low) existingM1.low = tickPrice;
                  }
                }
              }
            }
          }
          if (msg.m === 'timescale_update' || msg.m === 'du') {
            const m5Rows: Array<{ v?: number[] }> = msg.p?.[1]?.sds_1?.s || [];
            const m1Rows: Array<{ v?: number[] }> = msg.p?.[1]?.sds_2?.s || [];
            const gotM5 = ingestSeriesRows(cfdStreamState.barsMap, m5Rows);
            const gotM1 = ingestSeriesRows(cfdStreamState.barsM1Map, m1Rows);
            if (gotM5 || gotM1) {
              cfdStreamState.lastTickAtMs = Date.now();
            }
          }
        } catch {
          // Ignore non-JSON control frames
        }
      }
    };

    ws.onerror = () => {
      cfdStreamState.connected = false;
    };

    ws.onclose = () => {
      cfdStreamState.connected = false;
      if (cfdStreamState.ws === ws) {
        cfdStreamState.ws = null;
        if (!cfdStreamState.reconnectTimer) {
          cfdStreamState.reconnectTimer = setTimeout(() => {
            connectRealtimeCfdStream();
          }, 2500);
        }
      }
    };
  } catch (err: any) {
    cfdStreamState.connected = false;
    cfdStreamState.lastError = err?.message || 'WebSocket init error';
    cfdStreamState.reconnectTimer = setTimeout(() => {
      connectRealtimeCfdStream();
    }, 3000);
  }
}

connectRealtimeCfdStream();

// Watchdog: reconnect CFD stream if silent for >90s
setInterval(() => {
  if (
    cfdStreamState.connected &&
    cfdStreamState.lastTickAtMs > 0 &&
    Date.now() - cfdStreamState.lastTickAtMs > 90000
  ) {
    connectRealtimeCfdStream();
  }
}, 30000);

function buildCfdMarketFeed(
  symbol: TradingSymbol,
  timeframe: 'M5' | 'M1' = 'M5'
): MarketFeedResult | null {
  const sourceMap = timeframe === 'M1' ? cfdStreamState.barsM1Map : cfdStreamState.barsMap;
  if (sourceMap.size < 36) return null;
  const sorted = Array.from(sourceMap.values())
    .sort((a, b) => a.tSec - b.tSec)
    .slice(-260);

  const warmupSlice: Array<Omit<M5Candle, 'ao' | 'aoRising' | 'signal'>> = sorted.map((b, idx) => {
    const dt = new Date(b.tSec * 1000);
    return {
      index: idx,
      timeLabel: formatTimeLabel(dt),
      timestampIso: dt.toISOString(),
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      median: (b.high + b.low) / 2,
    };
  });

  const bars = computeAwesomeOscillator(warmupSlice)
    .slice(-180)
    .map((b, idx) => ({ ...b, index: idx }));

  const latestBar = bars[bars.length - 1];
  const latestBarTs = new Date(latestBar.timestampIso).getTime();
  const ageMinutes = (Date.now() - latestBarTs) / 60000;
  const isStreamFresh = Date.now() - cfdStreamState.lastTickAtMs <= 20000;
  const marketState = isStreamFresh || ageMinutes <= 8 ? 'LIVE' : 'MARKET CLOSED';
  const activeTicker = CFD_TICKERS[cfdStreamState.tickerIndex % CFD_TICKERS.length];

  return {
    symbol,
    source: `MT5 Forex CFD (${activeTicker})`,
    marketState,
    fetchedAt: new Date().toISOString(),
    lastTickAt: cfdStreamState.lastTickAtMs
      ? new Date(cfdStreamState.lastTickAtMs).toISOString()
      : null,
    bid: cfdStreamState.bid > 0 ? cfdStreamState.bid : latestBar.close,
    ask: cfdStreamState.ask > 0 ? cfdStreamState.ask : roundTo(latestBar.close + 1.1, 2),
    bars,
  };
}

async function fetchYahooM5(
  symbol: TradingSymbol,
  timeframe: 'M5' | 'M1' = 'M5'
): Promise<MarketFeedResult> {
  const mapping = YAHOO_SYMBOL_MAP[symbol];
  const intervalParam = timeframe === 'M1' ? '1m' : '5m';
  const rangeParam = timeframe === 'M1' ? '1d' : '5d';
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    mapping.ticker
  )}?interval=${intervalParam}&range=${rangeParam}`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    throw new Error(`Market feed HTTP ${res.status}`);
  }

  const json = (await res.json()) as any;
  const result = json?.chart?.result?.[0];
  const meta = result?.meta || {};
  const timestamps: number[] = result?.timestamp || [];
  const quote = result?.indicators?.quote?.[0] || {};
  const opens: Array<number | null> = quote.open || [];
  const highs: Array<number | null> = quote.high || [];
  const lows: Array<number | null> = quote.low || [];
  const closes: Array<number | null> = quote.close || [];

  const cleaned: Array<Omit<M5Candle, 'ao' | 'aoRising' | 'signal'>> = [];
  for (let i = 0; i < timestamps.length; i++) {
    const o = opens[i];
    const h = highs[i];
    const l = lows[i];
    const c = closes[i];
    if (o == null || h == null || l == null || c == null) continue;
    const dt = new Date(timestamps[i] * 1000);
    const open = roundTo(o, mapping.digits);
    const high = roundTo(h, mapping.digits);
    const low = roundTo(l, mapping.digits);
    const close = roundTo(c, mapping.digits);
    cleaned.push({
      index: cleaned.length,
      timeLabel: formatTimeLabel(dt),
      timestampIso: dt.toISOString(),
      open,
      high,
      low,
      close,
      median: (high + low) / 2,
    });
  }

  // Merge latest regularMarketPrice tick onto the forming candle for sub-2s real-time responsiveness
  const liveQuotePrice = Number(meta?.regularMarketPrice);
  if (cleaned.length > 0 && Number.isFinite(liveQuotePrice) && liveQuotePrice > 0) {
    const lastBar = cleaned[cleaned.length - 1];
    const liveRounded = roundTo(liveQuotePrice, mapping.digits);
    lastBar.close = liveRounded;
    if (liveRounded > lastBar.high) lastBar.high = liveRounded;
    if (liveRounded < lastBar.low) lastBar.low = liveRounded;
    lastBar.median = (lastBar.high + lastBar.low) / 2;
    const liveMarketTimeSec = Number(meta?.regularMarketTime);
    if (Number.isFinite(liveMarketTimeSec) && liveMarketTimeSec > 0) {
      const liveDt = new Date(liveMarketTimeSec * 1000);
      if (liveDt.getTime() >= new Date(lastBar.timestampIso).getTime()) {
        lastBar.timestampIso = liveDt.toISOString();
        lastBar.timeLabel = formatTimeLabel(liveDt);
      }
    }
  }

  const warmupSlice = cleaned.slice(-260).map((b, idx) => ({ ...b, index: idx }));
  if (warmupSlice.length < 36) {
    throw new Error('ข้อมูล M5 ไม่เพียงพอสำหรับคำนวณ AO');
  }

  const bars = computeAwesomeOscillator(warmupSlice)
    .slice(-180)
    .map((b, idx) => ({ ...b, index: idx }));

  const latestBarTs = new Date(bars[bars.length - 1].timestampIso).getTime();
  const ageMinutes = (Date.now() - latestBarTs) / 60000;
  const marketState = ageMinutes <= 20 ? 'LIVE' : 'MARKET CLOSED';

  return {
    symbol,
    source: `Fallback (${mapping.ticker})`,
    marketState,
    fetchedAt: new Date().toISOString(),
    bars,
  };
}

async function getLiveM5Feed(symbol: TradingSymbol): Promise<MarketFeedResult> {
  // Priority 1: Direct XM MT5 Bridge data pushed from user's MT5 terminal (within 15s)
  if (xmMt5Bridge.bars.length >= 36 && Date.now() - xmMt5Bridge.updatedAtMs <= 15000) {
    const bars = computeAwesomeOscillator(xmMt5Bridge.bars.slice(-260))
      .slice(-180)
      .map((b, idx) => ({ ...b, index: idx }));
    return {
      symbol,
      source: `XM MT5 Live (${xmMt5Bridge.symbolName})`,
      marketState: 'LIVE',
      fetchedAt: new Date().toISOString(),
      lastTickAt: new Date(xmMt5Bridge.updatedAtMs).toISOString(),
      bid: xmMt5Bridge.bid,
      ask: xmMt5Bridge.ask,
      bars,
    };
  }

  // Priority 2: Wait briefly up to 1.8s on cold start for real-time CFD stream handshake
  if (cfdStreamState.barsMap.size < 36) {
    const deadline = Date.now() + 1800;
    while (cfdStreamState.barsMap.size < 36 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  const cfdFeed = buildCfdMarketFeed(symbol, 'M5');
  if (cfdFeed) {
    return cfdFeed;
  }

  // Priority 3: Fallback to Yahoo feed (1.5s cache)
  const cached = feedCache.get(symbol);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const data = await fetchYahooM5(symbol, 'M5');

  feedCache.set(symbol, {
    expiresAt: Date.now() + 1500,
    data,
  });
  return data;
}

async function getLiveM1Feed(symbol: TradingSymbol): Promise<MarketFeedResult> {
  // Priority 1: Direct XM MT5 Bridge M1 bars pushed from user's MT5 terminal (within 15s)
  if (xmMt5Bridge.barsM1.length >= 36 && Date.now() - xmMt5Bridge.updatedAtMs <= 15000) {
    const bars = computeAwesomeOscillator(xmMt5Bridge.barsM1.slice(-260))
      .slice(-180)
      .map((b, idx) => ({ ...b, index: idx }));
    return {
      symbol,
      source: `XM MT5 Live (${xmMt5Bridge.symbolName})`,
      marketState: 'LIVE',
      fetchedAt: new Date().toISOString(),
      lastTickAt: new Date(xmMt5Bridge.updatedAtMs).toISOString(),
      bid: xmMt5Bridge.bid,
      ask: xmMt5Bridge.ask,
      bars,
    };
  }

  // Priority 2: Wait briefly up to 1.8s on cold start for real-time CFD M1 stream handshake
  if (cfdStreamState.barsM1Map.size < 36) {
    const deadline = Date.now() + 1800;
    while (cfdStreamState.barsM1Map.size < 36 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  const cfdFeed = buildCfdMarketFeed(symbol, 'M1');
  if (cfdFeed) {
    return cfdFeed;
  }

  // Priority 3: Fallback to Yahoo 1m feed (1.5s cache)
  const cached = feedCacheM1.get(symbol);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const data = await fetchYahooM5(symbol, 'M1');

  feedCacheM1.set(symbol, {
    expiresAt: Date.now() + 1500,
    data,
  });
  return data;
}

async function sendNtfyPush(topicOrUrl: string, title: string, body: string): Promise<boolean> {
  const trimmed = topicOrUrl.trim();
  if (!trimmed) return false;
  const endpoint =
    trimmed.startsWith('http://') || trimmed.startsWith('https://')
      ? trimmed
      : `https://ntfy.sh/${encodeURIComponent(trimmed)}`;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Title: title,
        Priority: 'high',
        Tags: 'chart_with_upwards_trend',
      },
      body,
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function formatSignedAo(val: number): string {
  const fixed = val.toFixed(3);
  return val > 0 ? `+${fixed}` : fixed;
}

function escapeTelegramHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatTelegramSignalMessage(params: {
  symbol: string;
  timeframe: string;
  signal: 'BUY' | 'SELL';
  aoPrev: number;
  aoCurr: number;
  mode: 'live' | 'sim';
  timestampIso?: string;
}): string {
  const badge = params.signal === 'BUY' ? '🟢 BUY' : '🔴 SELL';
  const condition =
    params.signal === 'BUY' ? 'AO ตัดเส้น 0 ขึ้น 🟢⬆️' : 'AO ตัดเส้น 0 ลง 🔴⬇️';
  const modeLabel = params.mode === 'live' ? 'กราฟจริง' : 'แบบจำลอง';
  const timeDate = params.timestampIso ? new Date(params.timestampIso) : new Date();
  const timeText = timeDate.toLocaleTimeString('th-TH', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Bangkok',
  });

  return [
    `<b>${badge}  ·  ${escapeTelegramHtml(params.symbol)} (${escapeTelegramHtml(params.timeframe)})</b>`,
    '──────────────',
    `เงื่อนไข: ${condition}`,
    `ค่า AO: ${formatSignedAo(params.aoPrev)} → ${formatSignedAo(params.aoCurr)}`,
    `โหมด: ${modeLabel}`,
    `เวลา: ${timeText} น.`,
  ].join('\n');
}

function formatTelegramStochMessage(params: {
  symbol: string;
  timeframe: string;
  triggerType: 'ABOVE_80' | 'BELOW_20';
  kPrev: number;
  kCurr: number;
  price: number;
  stochConfig: StochMonitorConfig;
  mode: 'live' | 'sim';
  timestampIso?: string;
}): string {
  const isAbove = params.triggerType === 'ABOVE_80';
  const badge = isAbove
    ? `🔴 ปิดสูงกว่า ${params.stochConfig.upperLevel}`
    : `🟢 ปิดต่ำกว่า ${params.stochConfig.lowerLevel}`;
  const condition = isAbove
    ? `Stoch(${params.stochConfig.kPeriod},${params.stochConfig.dPeriod},${params.stochConfig.slowing}) ปิดสูงกว่า ${params.stochConfig.upperLevel.toFixed(2)} 🔴⬆️`
    : `Stoch(${params.stochConfig.kPeriod},${params.stochConfig.dPeriod},${params.stochConfig.slowing}) ปิดต่ำกว่า ${params.stochConfig.lowerLevel.toFixed(2)} 🟢⬇️`;
  const modeLabel = params.mode === 'live' ? 'กราฟจริง' : 'แบบจำลอง';
  const timeDate = params.timestampIso ? new Date(params.timestampIso) : new Date();
  const timeText = timeDate.toLocaleTimeString('th-TH', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Bangkok',
  });

  return [
    `<b>${badge}  ·  ${escapeTelegramHtml(params.symbol)} (${escapeTelegramHtml(params.timeframe)})</b>`,
    '──────────────',
    `เงื่อนไข: ${condition}`,
    `ค่าเส้นฟ้า %K: ${params.kPrev.toFixed(2)} → ${params.kCurr.toFixed(2)}`,
    `ราคาปิด: ${params.price.toFixed(2)}`,
    `โหมด: ${modeLabel}`,
    `เวลา: ${timeText} น.`,
  ].join('\n');
}

function sanitizeTelegramToken(botToken: string): string {
  return botToken.trim().replace(/[^0-9A-Za-z:_-]/g, '');
}

async function fetchTelegramBotInfo(botToken: string): Promise<{
  ok: boolean;
  username?: string;
  botUrl?: string;
  error?: string;
}> {
  const cleanToken = sanitizeTelegramToken(botToken);
  if (!cleanToken) return { ok: false, error: 'กรุณากรอก Bot Token' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${cleanToken}/getMe`, {
      signal: AbortSignal.timeout(6000),
    });
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: { username?: string };
      description?: string;
    };
    if (!res.ok || !json.ok || !json.result?.username) {
      return {
        ok: false,
        error:
          res.status === 401
            ? 'Bot Token ไม่ถูกต้อง กรุณาตรวจสอบ Token จาก @BotFather'
            : json.description || `Telegram HTTP ${res.status}`,
      };
    }
    return {
      ok: true,
      username: json.result.username,
      botUrl: `https://t.me/${json.result.username}`,
    };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'เชื่อมต่อ Telegram API ไม่สำเร็จ' };
  }
}

async function sendTelegramPush(
  botToken: string,
  chatId: string,
  text: string,
  parseMode?: 'HTML'
): Promise<{ ok: boolean; error?: string; botUrl?: string; botUsername?: string }> {
  const token = sanitizeTelegramToken(botToken);
  const chat = normalizeTelegramChatId(chatId);
  if (!token || !chat) {
    return { ok: false, error: 'กรุณากรอก Bot Token และ Chat ID ของ Telegram' };
  }

  // Reject obvious bot username mistyped as personal Chat ID
  if (!/^-?\d+$/.test(chat) && !chat.startsWith('@')) {
    const info = await fetchTelegramBotInfo(token);
    return {
      ok: false,
      botUrl: info.botUrl,
      botUsername: info.username,
      error: `Chat ID "${chat}" ไม่ใช่ตัวเลขบัญชีผู้ใช้ (Chat ID ต้องเป็นตัวเลข เช่น 123456789) — กรุณาเปิดแชทบอทใน Telegram กด Start แล้วกดปุ่ม "ดึง Chat ID อัตโนมัติ"`,
    };
  }

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chat,
          text,
          ...(parseMode ? { parse_mode: parseMode } : {}),
        }),
        signal: AbortSignal.timeout(6000),
      }
    );
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as { description?: string };
      const rawDesc = errBody.description || `Telegram HTTP ${res.status}`;
      const info = await fetchTelegramBotInfo(token);

      if (rawDesc.toLowerCase().includes('chat not found')) {
        return {
          ok: false,
          botUrl: info.botUrl,
          botUsername: info.username,
          error: `ไม่พบแชท (${chat}) — ต้องเข้าไปกดปุ่ม Start ในแชทบอทก่อน และตรวจสอบว่าเป็น Chat ID ตัวเลขที่ถูกต้อง`,
        };
      }
      if (rawDesc.toLowerCase().includes('blocked')) {
        return {
          ok: false,
          botUrl: info.botUrl,
          botUsername: info.username,
          error: 'บอทถูกบล็อกในแชทนี้ กรุณาปลดบล็อกและกด Start ในแชทบอทอีกครั้ง',
        };
      }
      if (res.status === 401) {
        return {
          ok: false,
          error: 'Bot Token ไม่ถูกต้อง กรุณาคัดลอก Token จาก @BotFather ใหม่อีกครั้ง',
        };
      }
      return {
        ok: false,
        botUrl: info.botUrl,
        botUsername: info.username,
        error: rawDesc,
      };
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'เชื่อมต่อ Telegram API ไม่สำเร็จ' };
  }
}

async function broadcastWebPush(payload: {
  title: string;
  body: string;
  tag: string;
  url: string;
}): Promise<number> {
  if (persisted.subscriptions.length === 0) return 0;

  let delivered = 0;
  const deadEndpoints = new Set<string>();
  const jsonPayload = JSON.stringify(payload);

  await Promise.all(
    persisted.subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(sub as webpushTypes.PushSubscription, jsonPayload);
        delivered++;
      } catch (err: any) {
        const status = err?.statusCode;
        if (status === 404 || status === 410) {
          deadEndpoints.add(sub.endpoint);
        }
      }
    })
  );

  if (deadEndpoints.size > 0) {
    persisted.subscriptions = persisted.subscriptions.filter(
      (s) => !deadEndpoints.has(s.endpoint)
    );
    syncPersistence();
  }

  return delivered;
}

async function runBackgroundMonitorCycle() {
  if (!persisted.enabled || monitorRuntime.isRunningCycle) return;
  monitorRuntime.isRunningCycle = true;
  monitorRuntime.lastCheckedMs = Date.now();
  monitorRuntime.lastCheckedAt = new Date().toISOString();

  try {
    for (const sym of persisted.symbols) {
      try {
        const feed = await getLiveM5Feed(sym);
        const bars = feed.bars;
        if (bars.length < 4) continue;

        // Confirmed closed M5 bar [1] vs previous closed bar [2] (AO[2] <= 0 -> AO[1] > 0 or AO[2] >= 0 -> AO[1] < 0)
        const closedBar = bars[bars.length - 2];
        const prevClosedBar = bars[bars.length - 3];
        if (!closedBar || !prevClosedBar) continue;

        const closedBarOpenMs = Date.parse(closedBar.timestampIso);
        if (!Number.isFinite(closedBarOpenMs)) continue;
        const closedBucketMs = Math.floor(closedBarOpenMs / 300000) * 300000;

        // First observation after server startup: record baseline silently so past candles never fire retroactively
        const prevBaselineMs = monitorRuntime.lastClosedBarBucketMsBySymbol[sym];
        if (prevBaselineMs === undefined) {
          monitorRuntime.lastClosedBarBucketMsBySymbol[sym] = closedBucketMs;
          continue;
        }

        // Only process when a brand-new M5 candle closes moving forward in time
        if (closedBucketMs <= prevBaselineMs) {
          continue;
        }
        monitorRuntime.lastClosedBarBucketMsBySymbol[sym] = closedBucketMs;

        // Must be freshly closed (within 90 seconds of the exact candle close boundary)
        const closedBarCloseMs = closedBucketMs + 300000;
        const secondsSinceClose = (Date.now() - closedBarCloseMs) / 1000;
        if (secondsSinceClose < -5 || secondsSinceClose > 90) {
          continue;
        }

        // Stoch(15,3,3) single cyan %K line threshold alert (>80 or <20 on candle close, once per threshold cross)
        const stochSeries = computeStochMainSeries(bars, persisted.stochConfig);
        const closedStoch = stochSeries[stochSeries.length - 2];
        const prevClosedStoch = stochSeries[stochSeries.length - 3];
        if (
          closedStoch &&
          prevClosedStoch &&
          closedStoch.signal &&
          closedStoch.triggerType &&
          !hasClosedStochBarBeenAlerted(sym, closedBar.timestampIso)
        ) {
          recordClosedStochBarAlerted(sym, closedBar.timestampIso);
          const sSignal = closedStoch.signal;
          const sTrigger = closedStoch.triggerType;
          const isAbove = sTrigger === 'ABOVE_80';
          const thresholdLabel = isAbove
            ? `ปิดสูงกว่า ${persisted.stochConfig.upperLevel}`
            : `ปิดต่ำกว่า ${persisted.stochConfig.lowerLevel}`;
          const title = `Stoch(${persisted.stochConfig.kPeriod},${persisted.stochConfig.dPeriod},${persisted.stochConfig.slowing}) M5 ${thresholdLabel}: ${sym}`;
          const body = `${sym} M5 %K ${prevClosedStoch.k.toFixed(2)} → ${closedStoch.k.toFixed(
            2
          )} | ราคา ${closedBar.close}`;

          const [deliveredWebPushCount, deliveredToNtfy] = await Promise.all([
            broadcastWebPush({
              title,
              body,
              tag: `stoch-${sym}-${sTrigger}-${Date.now()}`,
              url: '/',
            }),
            persisted.ntfyTopic
              ? sendNtfyPush(persisted.ntfyTopic, title, body)
              : Promise.resolve(false),
          ]);

          const shouldSendTelegram =
            Boolean(persisted.telegramBotToken && persisted.telegramChatId) &&
            (persisted.telegramMode === 'always' || deliveredWebPushCount === 0);

          const tgRes = shouldSendTelegram
            ? await sendTelegramPush(
                persisted.telegramBotToken,
                persisted.telegramChatId,
                formatTelegramStochMessage({
                  symbol: sym,
                  timeframe: 'M5',
                  triggerType: sTrigger,
                  kPrev: prevClosedStoch.k,
                  kCurr: closedStoch.k,
                  price: closedBar.close,
                  stochConfig: persisted.stochConfig,
                  mode: 'live',
                  timestampIso: closedBar.timestampIso,
                }),
                'HTML'
              )
            : { ok: false };

          persisted.events.unshift({
            id: `stoch-${sym}-${closedBar.timestampIso}-${sTrigger}-${Date.now()}`,
            timestamp: new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }),
            symbol: sym,
            signal: sSignal,
            aoPrev: prevClosedStoch.k,
            aoCurr: closedStoch.k,
            price: closedBar.close,
            deliveredToNtfy,
            deliveredToTelegram: tgRes.ok,
            deliveredWebPushCount,
          });
          persisted.events = persisted.events.slice(0, 30);
          syncPersistence();
          scheduleGithubAutoSync('stoch-signal-event', 1000);
        }
      } catch {
        // Keep polling remaining symbols
      }
    }
  } finally {
    monitorRuntime.isRunningCycle = false;
  }
}

setInterval(() => {
  void runBackgroundMonitorCycle();
}, 2000);

setTimeout(() => {
  void runBackgroundMonitorCycle();
}, 1500);

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', async (_req, res) => {
    if (persisted.enabled && Date.now() - monitorRuntime.lastCheckedMs > 2000) {
      void runBackgroundMonitorCycle();
    }
    res.json({
      ok: true,
      monitorEnabled: persisted.enabled,
      symbols: persisted.symbols,
      subscribersCount: persisted.subscriptions.length,
      lastCheckedAt: monitorRuntime.lastCheckedAt,
      cfdStreamConnected: cfdStreamState.connected,
      xmBridgeConnected:
        xmMt5Bridge.bars.length >= 36 && Date.now() - xmMt5Bridge.updatedAtMs <= 15000,
    });
  });

  app.get('/api/mt5/status', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    const xmConnected =
      xmMt5Bridge.bars.length >= 36 && Date.now() - xmMt5Bridge.updatedAtMs <= 15000;
    res.json({
      xmBridgeConnected: xmConnected,
      xmSymbol: xmMt5Bridge.symbolName,
      xmBroker: xmMt5Bridge.broker,
      xmBid: xmMt5Bridge.bid,
      xmAsk: xmMt5Bridge.ask,
      xmUpdatedAt: xmMt5Bridge.updatedAtMs
        ? new Date(xmMt5Bridge.updatedAtMs).toISOString()
        : null,
      cfdStreamConnected: cfdStreamState.connected,
      cfdTicker: CFD_TICKERS[cfdStreamState.tickerIndex % CFD_TICKERS.length],
      cfdBarsCount: cfdStreamState.barsMap.size,
      cfdLastTickAt: cfdStreamState.lastTickAtMs
        ? new Date(cfdStreamState.lastTickAtMs).toISOString()
        : null,
    });
  });

  app.post('/api/mt5/tick', (req, res) => {
    const body = req.body || {};
    const rawBars = Array.isArray(body.bars) ? body.bars : [];
    if (rawBars.length < 36) {
      res.status(400).json({ error: 'ต้องการแท่งเทียน M5 อย่างน้อย 36 แท่ง' });
      return;
    }

    const parseBridgeBars = (rawList: any[]) => {
      const parsed: Array<Omit<M5Candle, 'ao' | 'aoRising' | 'signal'>> = [];
      for (const item of rawList.slice(-260)) {
        const tVal = Number(item?.t ?? item?.time ?? 0);
        const o = Number(item?.o ?? item?.open);
        const h = Number(item?.h ?? item?.high);
        const l = Number(item?.l ?? item?.low);
        const c = Number(item?.c ?? item?.close);
        if (
          !Number.isFinite(tVal) ||
          tVal <= 0 ||
          !Number.isFinite(o) ||
          !Number.isFinite(h) ||
          !Number.isFinite(l) ||
          !Number.isFinite(c)
        ) {
          continue;
        }
        const ms = tVal > 1e11 ? tVal : tVal * 1000;
        const dt = new Date(ms);
        parsed.push({
          index: parsed.length,
          timeLabel: formatTimeLabel(dt),
          timestampIso: dt.toISOString(),
          open: roundTo(o, 2),
          high: roundTo(h, 2),
          low: roundTo(l, 2),
          close: roundTo(c, 2),
          median: (roundTo(h, 2) + roundTo(l, 2)) / 2,
        });
      }
      parsed.sort((a, b) => Date.parse(a.timestampIso) - Date.parse(b.timestampIso));
      return parsed.map((b, idx) => ({ ...b, index: idx }));
    };

    const cleaned = parseBridgeBars(rawBars);
    if (cleaned.length < 36) {
      res.status(400).json({ error: 'ข้อมูลแท่งเทียนจาก MT5 ไม่สมบูรณ์' });
      return;
    }

    xmMt5Bridge.bars = cleaned;
    const rawM1Bars = Array.isArray(body.barsM1) ? body.barsM1 : [];
    const cleanedM1 = parseBridgeBars(rawM1Bars);
    if (cleanedM1.length >= 36) {
      xmMt5Bridge.barsM1 = cleanedM1;
      feedCacheM1.delete('US100');
    }
    xmMt5Bridge.symbolName = String(body.symbol || 'US100Cash#').slice(0, 32);
    xmMt5Bridge.broker = String(body.broker || 'XM Global MT5').slice(0, 48);
    xmMt5Bridge.bid = Number(body.bid) || cleaned[cleaned.length - 1].close;
    xmMt5Bridge.ask = Number(body.ask) || xmMt5Bridge.bid;
    xmMt5Bridge.updatedAtMs = Date.now();
    feedCache.delete('US100');

    res.json({
      ok: true,
      barsCount: xmMt5Bridge.bars.length,
      barsM1Count: xmMt5Bridge.barsM1.length,
      receivedAt: new Date(xmMt5Bridge.updatedAtMs).toISOString(),
    });
  });

  app.get('/api/mt5/bridge-ea.mq5', (req, res) => {
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    const host = String(req.headers['x-forwarded-host'] || req.get('host') || 'localhost:3000').split(',')[0].trim();
    const serverBase = `${proto}://${host}`;
    const tickUrl = `${serverBase}/api/mt5/tick`;
    const mq5Source = `//+------------------------------------------------------------------+
//|                                       XM_MT5_LiveBridge_EA.mq5   |
//|         Real-Time XM MT5 M5 Candlestick Bridge (Every 2 Seconds) |
//+------------------------------------------------------------------+
#property copyright "AO Signal Studio"
#property version   "1.00"
#property strict

input string InpBridgeUrl     = "${tickUrl}"; // URL รับข้อมูลกราฟจริง (เพิ่ม ${serverBase} ใน MT5 Allow WebRequest)
input int    InpPushIntervalS = 2;     // ความถี่ในการส่งกราฟ M5 (วินาที)
input int    InpBarsToSend    = 200;   // จำนวนแท่งเทียน M5 ล่าสุดที่ส่ง

uint lastSentTickMs = 0;

void PushLiveM5ToServer()
{
   MqlRates rates[];
   ArraySetAsSeries(rates, false);
   int copied = CopyRates(_Symbol, PERIOD_M5, 0, InpBarsToSend, rates);
   if(copied < 36)
      return;

   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   string broker = AccountInfoString(ACCOUNT_COMPANY);
   // Convert XM MT5 server time (e.g. GMT+2/+3) into true UTC Unix epoch seconds
   long serverOffsetSec = (long)MathRound((double)(TimeCurrent() - TimeGMT()) / 900.0) * 900;

   string barsJson = "[";
   for(int i = 0; i < copied; i++)
   {
      if(i > 0) barsJson += ",";
      long utcSec = (long)rates[i].time - serverOffsetSec;
      barsJson += StringFormat(
         "{\\"t\\":%I64d,\\"o\\":%.2f,\\"h\\":%.2f,\\"l\\":%.2f,\\"c\\":%.2f}",
         utcSec, rates[i].open, rates[i].high, rates[i].low, rates[i].close
      );
   }
   barsJson += "]";

   string payload = StringFormat(
      "{\\"symbol\\":\\"%s\\",\\"broker\\":\\"%s\\",\\"bid\\":%.2f,\\"ask\\":%.2f,\\"bars\\":%s}",
      _Symbol, broker, bid, ask, barsJson
   );

   char postData[];
   int len = StringToCharArray(payload, postData, 0, WHOLE_ARRAY, CP_UTF8);
   if(len > 0) ArrayResize(postData, len - 1);

   string headers = "Content-Type: application/json\\r\\n";
   char result[];
   string resHeaders = "";
   ResetLastError();
   int code = WebRequest("POST", InpBridgeUrl, headers, 3000, postData, result, resHeaders);
   if(code == -1)
   {
      PrintFormat("XM Bridge WebRequest Error=%d. Add %s to Tools->Options->Expert Advisors->Allow WebRequest", GetLastError(), InpBridgeUrl);
   }
   lastSentTickMs = GetTickCount();
}

int OnInit()
{
   EventSetTimer(MathMax(1, InpPushIntervalS));
   PushLiveM5ToServer();
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason)
{
   EventKillTimer();
}

void OnTimer()
{
   PushLiveM5ToServer();
}

void OnTick()
{
   if(GetTickCount() - lastSentTickMs >= 1000)
      PushLiveM5ToServer();
}
//+------------------------------------------------------------------+
`;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="XM_MT5_LiveBridge_EA.mq5"');
    res.send(mq5Source);
  });

  app.get('/api/market/m5', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    const rawSymbol = String(req.query.symbol || 'US100').toUpperCase();
    if (!(rawSymbol in YAHOO_SYMBOL_MAP)) {
      res.status(400).json({ error: 'ไม่รองรับสินทรัพย์นี้' });
      return;
    }
    try {
      const sym = rawSymbol as TradingSymbol;
      const data = await getLiveM5Feed(sym);
      res.json({
        ...data,
        xmBridgeConnected:
          xmMt5Bridge.bars.length >= 36 && Date.now() - xmMt5Bridge.updatedAtMs <= 15000,
        cfdStreamConnected: cfdStreamState.connected,
        alertedBarKeys: persisted.alertedBarKeys,
        lastLiveDirection: persisted.lastLiveDirectionBySymbol[sym] || null,
      });
    } catch (err: any) {
      res.status(502).json({
        error: err?.message || 'ไม่สามารถดึงข้อมูลกราฟจริงได้ในขณะนี้',
      });
    }
  });

  app.get('/api/market/m1', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    const rawSymbol = String(req.query.symbol || 'US100').toUpperCase();
    if (!(rawSymbol in YAHOO_SYMBOL_MAP)) {
      res.status(400).json({ error: 'ไม่รองรับสินทรัพย์นี้' });
      return;
    }
    try {
      const sym = rawSymbol as TradingSymbol;
      const data = await getLiveM1Feed(sym);
      res.json({
        ...data,
        xmBridgeConnected:
          xmMt5Bridge.barsM1.length >= 36 && Date.now() - xmMt5Bridge.updatedAtMs <= 15000,
        cfdStreamConnected: cfdStreamState.connected,
      });
    } catch (err: any) {
      res.status(502).json({
        error: err?.message || 'ไม่สามารถดึงข้อมูลกราฟ M1 ได้ในขณะนี้',
      });
    }
  });

  app.get('/api/push/vapid-public-key', (_req, res) => {
    res.json({ publicKey: persisted.vapidKeys.publicKey });
  });

  app.post('/api/push/subscribe', (req, res) => {
    const sub = req.body?.subscription as StoredPushSubscription | undefined;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
      res.status(400).json({ error: 'ข้อมูล Push Subscription ไม่ถูกต้อง' });
      return;
    }

    const existsIdx = persisted.subscriptions.findIndex(
      (s) => s.endpoint === sub.endpoint
    );
    if (existsIdx >= 0) {
      persisted.subscriptions[existsIdx] = sub;
    } else {
      persisted.subscriptions.push(sub);
    }
    syncPersistence();
    res.json({ ok: true, subscribersCount: persisted.subscriptions.length });
  });

  app.post('/api/push/unsubscribe', (req, res) => {
    const endpoint = String(req.body?.endpoint || '');
    if (endpoint) {
      persisted.subscriptions = persisted.subscriptions.filter(
        (s) => s.endpoint !== endpoint
      );
      syncPersistence();
    }
    res.json({ ok: true, subscribersCount: persisted.subscriptions.length });
  });

  app.post('/api/push/test', async (req, res) => {
    const targetEndpoint = req.body?.endpoint ? String(req.body.endpoint) : null;
    const targets = targetEndpoint
      ? persisted.subscriptions.filter((s) => s.endpoint === targetEndpoint)
      : persisted.subscriptions;

    if (targets.length === 0) {
      res.status(400).json({ error: 'ยังไม่มีอุปกรณ์ที่เปิดรับการแจ้งเตือน' });
      return;
    }

    let okCount = 0;
    const payload = JSON.stringify({
      title: 'Stoch M5 ทดสอบระบบสำเร็จ',
      body: 'เซิร์ฟเวอร์เชื่อมต่อมือถือเครื่องนี้แล้ว พร้อมส่งสัญญาณอัตโนมัติ',
      tag: `stoch-test-${Date.now()}`,
      url: '/',
    });

    await Promise.all(
      targets.map(async (sub) => {
        try {
          await webpush.sendNotification(sub as webpushTypes.PushSubscription, payload);
          okCount++;
        } catch {
          // Ignore individual failures
        }
      })
    );

    if (okCount === 0) {
      res.status(502).json({ error: 'ส่งแจ้งเตือนทดสอบไม่สำเร็จ กรุณากดเชื่อมต่อใหม่อีกครั้ง' });
      return;
    }

    res.json({ ok: true, delivered: okCount });
  });

  app.get('/api/monitor/status', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.json({
      enabled: persisted.enabled,
      symbols: persisted.symbols,
      ntfyTopic: persisted.ntfyTopic,
      telegramHasToken: Boolean(persisted.telegramBotToken),
      telegramConfigured: Boolean(
        persisted.telegramBotToken &&
          persisted.telegramChatId &&
          (/^-?\d+$/.test(persisted.telegramChatId) || persisted.telegramChatId.startsWith('@'))
      ),
      telegramChatId: persisted.telegramChatId,
      telegramMode: persisted.telegramMode,
      direction: persisted.direction,
      subscribersCount: persisted.subscriptions.length,
      lastCheckedAt: monitorRuntime.lastCheckedAt,
      events: persisted.events,
      alertedBarKeys: persisted.alertedBarKeys,
      alertedStochBarKeys: persisted.alertedStochBarKeys,
      stochConfig: persisted.stochConfig,
      lastLiveDirectionBySymbol: persisted.lastLiveDirectionBySymbol,
    });
  });

  app.post('/api/monitor/reset', (_req, res) => {
    persisted.events = [];
    persisted.alertedBarKeys = [];
    persisted.alertedStochBarKeys = [];
    persisted.lastLiveDirectionBySymbol = {};
    persisted.subscriptions = [];
    persisted.ntfyTopic = '';
    persisted.symbols = [...ALL_SYMBOLS];
    persisted.direction = 'both';
    persisted.enabled = true;
    persisted.telegramMode = 'always';
    monitorRuntime.lastBarBySymbol = {};
    monitorRuntime.lastClosedBarBucketMsBySymbol = {};
    monitorRuntime.dispatchedLiveSignalKeys.clear();
    monitorRuntime.dispatchedStochSignalKeys.clear();
    syncPersistence();
    res.json({
      ok: true,
      symbols: persisted.symbols,
      events: persisted.events,
      alertedBarKeys: persisted.alertedBarKeys,
      alertedStochBarKeys: persisted.alertedStochBarKeys,
      telegramChatId: persisted.telegramChatId,
      telegramMode: persisted.telegramMode,
    });
  });

  app.post('/api/monitor/config', (req, res) => {
    const body = req.body || {};
    if (typeof body.enabled === 'boolean') {
      persisted.enabled = body.enabled;
    }
    if (Array.isArray(body.symbols)) {
      const valid = body.symbols
        .map((s: unknown) => String(s).toUpperCase())
        .filter((s: string): s is TradingSymbol => s in YAHOO_SYMBOL_MAP);
      if (valid.length > 0) {
        persisted.symbols = valid;
      }
    }
    if (typeof body.ntfyTopic === 'string') {
      persisted.ntfyTopic = body.ntfyTopic.trim();
    }
    if (body.clearTelegram === true) {
      persisted.telegramBotToken = '';
      persisted.telegramChatId = '';
    } else {
      if (typeof body.telegramBotToken === 'string' && body.telegramBotToken.trim() !== '') {
        persisted.telegramBotToken = body.telegramBotToken.trim();
      }
      if (typeof body.telegramChatId === 'string') {
        persisted.telegramChatId = normalizeTelegramChatId(body.telegramChatId);
      }
    }
    if (body.telegramMode === 'fallback' || body.telegramMode === 'always') {
      persisted.telegramMode = body.telegramMode;
    }
    if (
      body.direction === 'both' ||
      body.direction === 'buy_only' ||
      body.direction === 'sell_only'
    ) {
      persisted.direction = body.direction;
    }
    if (body.stochConfig && typeof body.stochConfig === 'object') {
      persisted.stochConfig = {
        kPeriod: Math.max(1, Math.min(100, Math.floor(Number(body.stochConfig.kPeriod) || 15))),
        dPeriod: Math.max(1, Math.min(50, Math.floor(Number(body.stochConfig.dPeriod) || 3))),
        slowing: Math.max(1, Math.min(50, Math.floor(Number(body.stochConfig.slowing) || 3))),
        upperLevel: Math.min(99, Math.max(51, Number(body.stochConfig.upperLevel) || 80)),
        lowerLevel: Math.max(1, Math.min(49, Number(body.stochConfig.lowerLevel) || 20)),
      };
    }

    syncPersistence();

    if (persisted.enabled) {
      void runBackgroundMonitorCycle();
    }

    res.json({
      enabled: persisted.enabled,
      symbols: persisted.symbols,
      ntfyTopic: persisted.ntfyTopic,
      telegramHasToken: Boolean(persisted.telegramBotToken),
      telegramConfigured: Boolean(
        persisted.telegramBotToken &&
          persisted.telegramChatId &&
          (/^-?\d+$/.test(persisted.telegramChatId) || persisted.telegramChatId.startsWith('@'))
      ),
      telegramChatId: persisted.telegramChatId,
      telegramMode: persisted.telegramMode,
      direction: persisted.direction,
      stochConfig: persisted.stochConfig,
      subscribersCount: persisted.subscriptions.length,
      lastCheckedAt: monitorRuntime.lastCheckedAt,
      events: persisted.events,
    });
  });

  app.post('/api/monitor/telegram-detect', async (req, res) => {
    const token = sanitizeTelegramToken(
      String(req.body?.telegramBotToken || persisted.telegramBotToken || '')
    );
    if (!token) {
      res.status(400).json({ error: 'กรุณากรอก Bot Token ก่อนดึง Chat ID' });
      return;
    }

    const botInfo = await fetchTelegramBotInfo(token);
    if (!botInfo.ok) {
      res.status(400).json({ error: botInfo.error || 'Bot Token ไม่ถูกต้อง' });
      return;
    }

    persisted.telegramBotToken = token;
    syncPersistence();

    try {
      const updRes = await fetch(
        `https://api.telegram.org/bot${token}/getUpdates?limit=20`,
        { signal: AbortSignal.timeout(6000) }
      );
      type TgChat = { id?: number; username?: string; first_name?: string; title?: string };
      const updJson = (await updRes.json().catch(() => ({}))) as {
        ok?: boolean;
        result?: Array<{
          message?: { chat?: TgChat };
          my_chat_member?: { chat?: TgChat };
          channel_post?: { chat?: TgChat };
        }>;
      };

      const chats: Array<{ id: string; label: string }> = [];
      for (const item of updJson.result || []) {
        const chat =
          item.message?.chat || item.my_chat_member?.chat || item.channel_post?.chat;
        if (chat?.id !== undefined) {
          const idStr = String(chat.id);
          const label =
            chat.title ||
            chat.first_name ||
            (chat.username ? `@${chat.username}` : idStr);
          if (!chats.some((c) => c.id === idStr)) {
            chats.push({ id: idStr, label });
          }
        }
      }

      if (chats.length === 0) {
        res.json({
          ok: false,
          needsStart: true,
          botUsername: botInfo.username,
          botUrl: botInfo.botUrl,
          message: `ยังไม่พบข้อความในบอท @${botInfo.username} — กรุณากดเปิดแชทบอทแล้วกดปุ่ม Start จากนั้นกดดึง Chat ID อีกครั้ง`,
        });
        return;
      }

      const latest = chats[chats.length - 1];
      persisted.telegramChatId = latest.id;
      syncPersistence();

      res.json({
        ok: true,
        botUsername: botInfo.username,
        botUrl: botInfo.botUrl,
        detectedChatId: latest.id,
        detectedChatLabel: latest.label,
      });
    } catch (err: any) {
      res.status(502).json({
        error: err?.message || 'ดึงข้อมูล Chat ID จาก Telegram ไม่สำเร็จ',
      });
    }
  });

  app.post('/api/monitor/test-push', async (req, res) => {
    const topic = String(req.body?.ntfyTopic || persisted.ntfyTopic || '').trim();
    if (!topic) {
      res.status(400).json({ error: 'กรุณากรอกชื่อ Topic ของ ntfy ก่อนทดสอบ' });
      return;
    }
    const ok = await sendNtfyPush(
      topic,
      'Stoch M5 Test Alert',
      'เชื่อมต่อการแจ้งเตือนอัตโนมัติเข้ามือถือ Android สำเร็จ'
    );
    if (!ok) {
      res.status(502).json({ error: 'ส่งสัญญาณทดสอบไปยัง ntfy ไม่สำเร็จ' });
      return;
    }
    res.json({ ok: true });
  });

  app.post('/api/monitor/test-telegram', async (req, res) => {
    const token = sanitizeTelegramToken(
      String(req.body?.telegramBotToken || persisted.telegramBotToken || '')
    );
    const chatId = normalizeTelegramChatId(
      String(req.body?.telegramChatId || persisted.telegramChatId || '')
    );

    if (!token || !chatId) {
      res.status(400).json({ error: 'กรุณากรอก Bot Token และ Chat ID ของ Telegram' });
      return;
    }

    persisted.telegramBotToken = token;
    persisted.telegramChatId = chatId;
    syncPersistence();

    const tgRes = await sendTelegramPush(
      token,
      chatId,
      [
        '✅ ทดสอบระบบแจ้งเตือน AO (M5)',
        '──────────────',
        'สถานะ: เชื่อมต่อ Telegram สำเร็จ',
        'สินทรัพย์: US100 (US 100 Index Cash)',
      ].join('\n')
    );
    if (!tgRes.ok) {
      res.status(502).json({
        error: tgRes.error || 'ส่งข้อความเข้า Telegram ไม่สำเร็จ',
        botUrl: tgRes.botUrl,
        botUsername: tgRes.botUsername,
      });
      return;
    }
    res.json({ ok: true });
  });

  app.post('/api/monitor/notify-signal', async (req, res) => {
    const body = req.body || {};
    const indicator = body.indicator === 'STOCH' ? 'STOCH' : 'AO';
    const symbol = String(body.symbol || 'US100').toUpperCase();
    const timeframe = String(body.timeframe || 'M5');
    const signal = body.signal === 'SELL' ? 'SELL' : 'BUY';
    const aoPrev = Number(body.aoPrev ?? 0);
    const aoCurr = Number(body.aoCurr ?? 0);
    const price = Number(body.price ?? 0);
    const mode = body.mode === 'live' ? 'live' : 'sim';
    const timestampIso = String(body.timestampIso || new Date().toISOString());

    const hasTelegram = Boolean(persisted.telegramBotToken && persisted.telegramChatId);
    const hasWebPush = persisted.subscriptions.length > 0;
    const hasNtfy = Boolean(persisted.ntfyTopic);

    if (!hasTelegram && !hasWebPush && !hasNtfy) {
      res.json({ ok: false, skipped: true, reason: 'not_configured' });
      return;
    }

    // Live M5 alerts are dispatched exclusively by runBackgroundMonitorCycle() once per closed candle
    if (mode === 'live') {
      res.json({ ok: true, deduplicated: true, managedByServer: true });
      return;
    }

    const modeBadge = mode === 'sim' ? '[จำลอง] ' : '';
    const stochTrigger: 'ABOVE_80' | 'BELOW_20' =
      body.triggerType === 'ABOVE_80' || signal === 'SELL' ? 'ABOVE_80' : 'BELOW_20';
    const title =
      indicator === 'STOCH'
        ? `${modeBadge}Stoch(${persisted.stochConfig.kPeriod},${persisted.stochConfig.dPeriod},${persisted.stochConfig.slowing}) ${timeframe} ${
            stochTrigger === 'ABOVE_80'
              ? `ปิดสูงกว่า ${persisted.stochConfig.upperLevel}`
              : `ปิดต่ำกว่า ${persisted.stochConfig.lowerLevel}`
          }: ${symbol}`
        : `${modeBadge}AO ${timeframe} ${signal}: ${symbol}`;
    const pushBody =
      indicator === 'STOCH'
        ? `${symbol} ${timeframe} | %K ${aoPrev.toFixed(2)} → ${aoCurr.toFixed(2)} | ราคา ${price}`
        : `${symbol} ${timeframe} ${signal} | AO ${aoPrev.toFixed(3)} → ${aoCurr.toFixed(3)} | ราคา ${price}`;

    const [deliveredWebPushCount, deliveredToNtfy] = await Promise.all([
      hasWebPush
        ? broadcastWebPush({
            title,
            body: pushBody,
            tag: `${indicator.toLowerCase()}-${mode}-${symbol}-${Date.now()}`,
            url: '/',
          })
        : Promise.resolve(0),
      hasNtfy ? sendNtfyPush(persisted.ntfyTopic, title, pushBody) : Promise.resolve(false),
    ]);

    let deliveredToTelegram = false;
    let tgError: string | undefined;

    if (hasTelegram) {
      const text =
        indicator === 'STOCH'
          ? formatTelegramStochMessage({
              symbol,
              timeframe,
              triggerType: stochTrigger,
              kPrev: aoPrev,
              kCurr: aoCurr,
              price,
              stochConfig: persisted.stochConfig,
              mode,
              timestampIso,
            })
          : formatTelegramSignalMessage({
              symbol,
              timeframe,
              signal,
              aoPrev,
              aoCurr,
              mode,
              timestampIso,
            });

      const tgRes = await sendTelegramPush(
        persisted.telegramBotToken,
        persisted.telegramChatId,
        text,
        'HTML'
      );
      deliveredToTelegram = tgRes.ok;
      tgError = tgRes.error;
    }

    if (!deliveredToTelegram && deliveredWebPushCount === 0 && !deliveredToNtfy) {
      res.status(502).json({
        ok: false,
        error: tgError || 'ส่งสัญญาณแจ้งเตือนไม่สำเร็จ',
      });
      return;
    }

    persisted.events.unshift({
      id: `${mode}-${symbol}-${Date.now()}`,
      timestamp: new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }),
      symbol: (symbol in YAHOO_SYMBOL_MAP ? symbol : 'US100') as TradingSymbol,
      signal,
      aoPrev,
      aoCurr,
      price,
      deliveredToNtfy,
      deliveredToTelegram,
      deliveredWebPushCount,
    });
    persisted.events = persisted.events.slice(0, 30);
    syncPersistence();
    scheduleGithubAutoSync('signal-event', 1000);

    res.json({
      ok: true,
      deliveredToTelegram,
      deliveredWebPushCount,
      deliveredToNtfy,
    });
  });

  app.get('/api/github/status', (_req, res) => {
    res.json(buildGithubStatusResponse());
  });

  app.post('/api/github/config', async (req, res) => {
    const body = req.body || {};

    if (body.clearGithub === true) {
      persisted.githubToken = '';
      persisted.githubOwner = '';
      persisted.githubLastSyncedHash = '';
      persisted.githubLastSyncAt = null;
      persisted.githubLastCommitUrl = null;
      persisted.githubLastError = null;
      syncPersistence();
      res.json({ ok: true, status: buildGithubStatusResponse() });
      return;
    }

    const incomingToken =
      typeof body.githubToken === 'string' && body.githubToken.trim()
        ? body.githubToken.trim()
        : persisted.githubToken;

    if (!incomingToken) {
      res.status(400).json({ error: 'กรุณากรอก GitHub Personal Access Token' });
      return;
    }

    const userRes = await fetchGithubAuthenticatedUser(incomingToken);
    if (!userRes.ok || !userRes.login) {
      res.status(400).json({ error: userRes.error || 'GitHub Token ไม่ถูกต้อง' });
      return;
    }

    persisted.githubToken = incomingToken;
    persisted.githubOwner =
      typeof body.githubOwner === 'string' && body.githubOwner.trim()
        ? body.githubOwner.trim()
        : userRes.login;
    persisted.githubRepo = sanitizeGithubRepoName(
      typeof body.githubRepo === 'string' && body.githubRepo.trim()
        ? body.githubRepo
        : persisted.githubRepo || 'ao-signal-studio'
    );
    persisted.githubBranch =
      typeof body.githubBranch === 'string' && body.githubBranch.trim()
        ? body.githubBranch.trim()
        : persisted.githubBranch || 'main';
    if (typeof body.githubPrivate === 'boolean') {
      persisted.githubPrivate = body.githubPrivate;
    }
    if (typeof body.githubAutoSyncCode === 'boolean') {
      persisted.githubAutoSyncCode = body.githubAutoSyncCode;
    }
    if (typeof body.githubSyncSignals === 'boolean') {
      persisted.githubSyncSignals = body.githubSyncSignals;
    }
    persisted.githubLastError = null;
    syncPersistence();

    const shouldSyncImmediately = body.syncImmediately !== false;
    let syncResult: Awaited<ReturnType<typeof syncWorkspaceToGithub>> | null = null;
    if (shouldSyncImmediately) {
      syncResult = await syncWorkspaceToGithub({
        force: body.forceSync !== false,
        reason: 'connect',
      });
      if (!syncResult.ok) {
        res.status(502).json({
          ok: false,
          error: syncResult.error || 'อัปโหลดขึ้น GitHub ไม่สำเร็จ',
          status: buildGithubStatusResponse(),
        });
        return;
      }
    } else if (persisted.githubAutoSyncCode) {
      scheduleGithubAutoSync('restore-check', 1200);
    }

    res.json({
      ok: true,
      syncResult,
      status: buildGithubStatusResponse(),
    });
  });

  app.post('/api/github/sync-now', async (_req, res) => {
    if (!persisted.githubToken || !persisted.githubRepo) {
      res.status(400).json({ error: 'กรุณาเชื่อมต่อ GitHub.com ก่อนซิงค์' });
      return;
    }

    const result = await syncWorkspaceToGithub({ force: true, reason: 'manual' });
    if (!result.ok) {
      res.status(502).json({
        ok: false,
        error: result.error || 'ซิงค์ขึ้น GitHub ไม่สำเร็จ',
        status: buildGithubStatusResponse(),
      });
      return;
    }

    res.json({
      ok: true,
      committed: result.committed,
      syncedFilesCount: result.syncedFilesCount,
      commitUrl: result.commitUrl,
      status: buildGithubStatusResponse(),
    });
  });

  app.get('/api/export/manifest', (_req, res) => {
    try {
      const files = collectDeployableFiles(__dirname);
      res.json({ ok: true, count: files.length, files });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'อ่านรายการไฟล์ไม่สำเร็จ' });
    }
  });

  app.get('/api/export/source.zip', (_req, res) => {
    try {
      const files = collectDeployableFiles(__dirname);
      const zipBuffer = buildZipBuffer(__dirname, files);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="ao-signal-studio-server.zip"'
      );
      res.setHeader('Content-Length', String(zipBuffer.length));
      res.send(zipBuffer);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'สร้างไฟล์ดาวน์โหลดไม่สำเร็จ' });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const port = Number(process.env.PORT || 3000);
  app.listen(port, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${port}`);
    startGithubWorkspaceWatchers();
  });
}

void startServer();
