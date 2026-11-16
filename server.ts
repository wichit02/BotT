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
  lastLiveDirectionBySymbol: Partial<Record<TradingSymbol, 'BUY' | 'SELL'>>;
}

const YAHOO_SYMBOL_MAP: Record<TradingSymbol, { ticker: string; digits: number }> = {
  US100: { ticker: 'NQ=F', digits: 2 },
};

const ALL_SYMBOLS: TradingSymbol[] = ['US100'];
const STATE_DIR = path.resolve(__dirname, '.data');
const STATE_FILE = path.join(STATE_DIR, 'ao-server-state.json');

const feedCache = new Map<TradingSymbol, { expiresAt: number; data: MarketFeedResult }>();

function loadPersistedState(): PersistedServerState {
  const envPublic = process.env.VAPID_PUBLIC_KEY?.trim();
  const envPrivate = process.env.VAPID_PRIVATE_KEY?.trim();
  const envTgToken = process.env.TELEGRAM_BOT_TOKEN?.trim() || '';
  const envTgChatId = process.env.TELEGRAM_CHAT_ID?.trim() || '';
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
        symbols: ALL_SYMBOLS,
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
            ? parsed.telegramChatId
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
  dispatchedLiveSignalKeys: new Set<string>(),
};

function markLiveSignalDispatched(key: string) {
  monitorRuntime.dispatchedLiveSignalKeys.add(key);
  if (monitorRuntime.dispatchedLiveSignalKeys.size > 300) {
    const first = monitorRuntime.dispatchedLiveSignalKeys.values().next().value;
    if (first) monitorRuntime.dispatchedLiveSignalKeys.delete(first);
  }
}

function hasLiveBarBeenAlerted(
  sym: TradingSymbol,
  barTimestampIso: string,
  signal: 'BUY' | 'SELL'
): boolean {
  const runtimeKey = `live-${sym}-${barTimestampIso}`;
  const persistedKey = `${sym}-${barTimestampIso}`;
  if (monitorRuntime.dispatchedLiveSignalKeys.has(runtimeKey)) return true;
  if (persisted.alertedBarKeys.includes(persistedKey)) return true;
  if (persisted.lastLiveDirectionBySymbol[sym] === signal) return true;
  return false;
}

function recordLiveBarAlerted(
  sym: TradingSymbol,
  barTimestampIso: string,
  signal: 'BUY' | 'SELL'
): void {
  const runtimeKey = `live-${sym}-${barTimestampIso}`;
  const persistedKey = `${sym}-${barTimestampIso}`;
  markLiveSignalDispatched(runtimeKey);
  if (!persisted.alertedBarKeys.includes(persistedKey)) {
    persisted.alertedBarKeys = [persistedKey, ...persisted.alertedBarKeys].slice(0, 60);
  }
  persisted.lastLiveDirectionBySymbol[sym] = signal;
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
    app: 'AO Signal Studio (M5)',
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

async function fetchYahooM5(symbol: TradingSymbol): Promise<MarketFeedResult> {
  const mapping = YAHOO_SYMBOL_MAP[symbol];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    mapping.ticker
  )}?interval=5m&range=5d`;

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

  const warmupSlice = cleaned.slice(-180).map((b, idx) => ({ ...b, index: idx }));
  if (warmupSlice.length < 36) {
    throw new Error('ข้อมูล M5 ไม่เพียงพอสำหรับคำนวณ AO');
  }

  const bars = computeAwesomeOscillator(warmupSlice)
    .slice(-90)
    .map((b, idx) => ({ ...b, index: idx }));

  const latestBarTs = new Date(bars[bars.length - 1].timestampIso).getTime();
  const ageMinutes = (Date.now() - latestBarTs) / 60000;
  const marketState = ageMinutes <= 20 ? 'LIVE' : 'MARKET CLOSED';

  return {
    symbol,
    source: `Live M5 (${mapping.ticker})`,
    marketState,
    fetchedAt: new Date().toISOString(),
    bars,
  };
}

async function getLiveM5Feed(symbol: TradingSymbol): Promise<MarketFeedResult> {
  const cached = feedCache.get(symbol);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const data = await fetchYahooM5(symbol);

  feedCache.set(symbol, {
    expiresAt: Date.now() + 8000,
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
  const chat = chatId.trim();
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
        if (bars.length < 3) continue;

        // Check both the live forming M5 candle (immediate cross) and previous closed candle (fallback)
        const candidates: Array<{ targetBar: M5Candle; prevBar: M5Candle }> = [
          { targetBar: bars[bars.length - 1], prevBar: bars[bars.length - 2] },
          { targetBar: bars[bars.length - 2], prevBar: bars[bars.length - 3] },
        ];

        for (const { targetBar, prevBar } of candidates) {
          if (!targetBar || !prevBar || !targetBar.signal) continue;

          // Skip stale bars (e.g. Friday's close when market is closed on weekend)
          const barAgeMinutes =
            (Date.now() - new Date(targetBar.timestampIso).getTime()) / 60000;
          if (barAgeMinutes > 20) continue;

          if (persisted.direction === 'buy_only' && targetBar.signal !== 'BUY') continue;
          if (persisted.direction === 'sell_only' && targetBar.signal !== 'SELL') continue;

          if (hasLiveBarBeenAlerted(sym, targetBar.timestampIso, targetBar.signal)) {
            continue;
          }
          recordLiveBarAlerted(sym, targetBar.timestampIso, targetBar.signal);
          monitorRuntime.lastBarBySymbol[sym] = `${targetBar.timestampIso}:${targetBar.signal}`;

          const title = `AO M5 ${targetBar.signal}: ${sym}`;
          const body = `${sym} M5 ${targetBar.signal} | AO ${prevBar.ao.toFixed(
            5
          )} → ${targetBar.ao.toFixed(5)} | ราคา ${targetBar.close}`;

          const [deliveredWebPushCount, deliveredToNtfy] = await Promise.all([
            broadcastWebPush({
              title,
              body,
              tag: `ao-${sym}-${targetBar.timestampIso}`,
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
                formatTelegramSignalMessage({
                  symbol: sym,
                  timeframe: 'M5',
                  signal: targetBar.signal,
                  aoPrev: prevBar.ao,
                  aoCurr: targetBar.ao,
                  mode: 'live',
                  timestampIso: targetBar.timestampIso,
                }),
                'HTML'
              )
            : { ok: false };

          persisted.events.unshift({
            id: `${sym}-${targetBar.timestampIso}-${targetBar.signal}`,
            timestamp: new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }),
            symbol: sym,
            signal: targetBar.signal,
            aoPrev: prevBar.ao,
            aoCurr: targetBar.ao,
            price: targetBar.close,
            deliveredToNtfy,
            deliveredToTelegram: tgRes.ok,
            deliveredWebPushCount,
          });
          persisted.events = persisted.events.slice(0, 30);
          syncPersistence();
          scheduleGithubAutoSync('signal-event', 1000);
          break;
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
}, 10000);

setTimeout(() => {
  void runBackgroundMonitorCycle();
}, 1500);

async function startServer() {
  const app = express();
  app.use(express.json());

  app.get('/api/health', async (_req, res) => {
    if (persisted.enabled && Date.now() - monitorRuntime.lastCheckedMs > 8000) {
      void runBackgroundMonitorCycle();
    }
    res.json({
      ok: true,
      monitorEnabled: persisted.enabled,
      symbols: persisted.symbols,
      subscribersCount: persisted.subscriptions.length,
      lastCheckedAt: monitorRuntime.lastCheckedAt,
    });
  });

  app.get('/api/market/m5', async (req, res) => {
    const rawSymbol = String(req.query.symbol || 'US100').toUpperCase();
    if (!(rawSymbol in YAHOO_SYMBOL_MAP)) {
      res.status(400).json({ error: 'ไม่รองรับสินทรัพย์นี้' });
      return;
    }
    try {
      const data = await getLiveM5Feed(rawSymbol as TradingSymbol);
      res.json(data);
    } catch (err: any) {
      res.status(502).json({
        error: err?.message || 'ไม่สามารถดึงข้อมูลกราฟจริงได้ในขณะนี้',
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
      title: 'AO M5 ทดสอบระบบสำเร็จ',
      body: 'เซิร์ฟเวอร์เชื่อมต่อมือถือเครื่องนี้แล้ว พร้อมส่งสัญญาณอัตโนมัติ',
      tag: `ao-test-${Date.now()}`,
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
      lastLiveDirection: persisted.lastLiveDirectionBySymbol.US100 || null,
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
        persisted.telegramChatId = body.telegramChatId.trim();
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
      'AO M5 Test Alert',
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
    const chatId = String(
      req.body?.telegramChatId || persisted.telegramChatId || ''
    ).trim();

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
    if (!persisted.telegramBotToken || !persisted.telegramChatId) {
      res.json({ ok: false, skipped: true, reason: 'not_configured' });
      return;
    }

    const body = req.body || {};
    const symbol = String(body.symbol || 'US100').toUpperCase();
    const timeframe = String(body.timeframe || 'M5');
    const signal = body.signal === 'SELL' ? 'SELL' : 'BUY';
    const aoPrev = Number(body.aoPrev ?? 0);
    const aoCurr = Number(body.aoCurr ?? 0);
    const price = Number(body.price ?? 0);
    const mode = body.mode === 'live' ? 'live' : 'sim';
    const timestampIso = String(body.timestampIso || new Date().toISOString());

    if (mode === 'live') {
      const symTyped = (symbol in YAHOO_SYMBOL_MAP ? symbol : 'US100') as TradingSymbol;
      if (hasLiveBarBeenAlerted(symTyped, timestampIso, signal)) {
        res.json({ ok: true, deduplicated: true });
        return;
      }
      recordLiveBarAlerted(symTyped, timestampIso, signal);
    }

    const text = formatTelegramSignalMessage({
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

    if (!tgRes.ok) {
      res.status(502).json({
        ok: false,
        error: tgRes.error || 'ส่งสัญญาณเข้า Telegram ไม่สำเร็จ',
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
      deliveredToNtfy: false,
      deliveredToTelegram: true,
      deliveredWebPushCount: 0,
    });
    persisted.events = persisted.events.slice(0, 30);
    syncPersistence();
    scheduleGithubAutoSync('signal-event', 1000);

    res.json({ ok: true });
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
