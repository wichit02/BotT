import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Eye,
  EyeOff,
  Search,
  Send,
  ShieldCheck,
  Trash2,
  RefreshCw,
} from 'lucide-react';
import type { Mql5Config } from '../lib/mql5Generator';
import {
  clearSavedTelegramConfig,
  loadSavedTelegramConfig,
  saveTelegramConfigLocally,
  SYSTEM_TELEGRAM_CHAT_ID,
} from '../lib/telegramStorage';

interface MonitorEventItem {
  id: string;
  timestamp: string;
  symbol: string;
  timeframe?: string;
  strategy?: 'AO' | 'CISD' | 'STOCH';
  signal: 'BUY' | 'SELL';
  price: number;
  cisdLevel?: number | null;
  stochK?: number | null;
  stochSide?: 'OVER_80' | 'UNDER_20' | null;
  t01Round?: number | null;
  deliveredWebPushCount: number;
  deliveredToTelegram?: boolean;
  telegramError?: string;
}

interface TelegramConfigProps {
  mql5Config: Mql5Config;
  onUpdateMql5Config: (next: Mql5Config) => void;
  onConfiguredChange?: (configured: boolean) => void;
}

export const TelegramConfig: React.FC<TelegramConfigProps> = ({
  mql5Config,
  onUpdateMql5Config,
  onConfiguredChange,
}) => {
  const [botToken, setBotToken] = useState(
    () => mql5Config.telegramBotToken || loadSavedTelegramConfig()?.telegramBotToken || ''
  );
  const [chatId, setChatId] = useState(SYSTEM_TELEGRAM_CHAT_ID);
  const [showToken, setShowToken] = useState(false);
  const [telegramMode, setTelegramMode] = useState<'fallback' | 'always'>('always');
  const [telegramSenderEnabled, setTelegramSenderEnabled] = useState<boolean>(true);
  const [syncToMql5, setSyncToMql5] = useState(true);
  const [cisdTimeframes, setCisdTimeframes] = useState<Array<'M15'>>([
    'M15',
  ]);
  const [stochM1Enabled, setStochM1Enabled] = useState<boolean>(true);
  const [m15StandaloneAlerts, setM15StandaloneAlerts] = useState<boolean>(false);

  const [hasSavedToken, setHasSavedToken] = useState(false);
  const [savedTokenMasked, setSavedTokenMasked] = useState('');
  const [isConfigured, setIsConfigured] = useState(false);
  const [subscribersCount, setSubscribersCount] = useState(0);
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null);
  const [events, setEvents] = useState<MonitorEventItem[]>([]);
  const [isBusy, setIsBusy] = useState(false);
  const [isCheckingNow, setIsCheckingNow] = useState(false);
  const [botLink, setBotLink] = useState<{
    username?: string;
    url: string;
  } | null>(null);
  const [statusMessage, setStatusMessage] = useState<{
    type: 'ok' | 'err' | 'warn';
    text: string;
  } | null>(null);

  const trimmedChatId = chatId.trim();
  const isLikelyInvalidChatId =
    trimmedChatId.length > 0 &&
    !/^-?\d+$/.test(trimmedChatId) &&
    !trimmedChatId.startsWith('@');

  const loadStatus = async () => {
    try {
      const res = await fetch('/api/monitor/status');
      if (!res.ok) return;
      const data = await res.json();
      setHasSavedToken(Boolean(data.telegramHasToken || data.telegramConfigured));
      setSavedTokenMasked(
        typeof data.telegramBotTokenMasked === 'string' ? data.telegramBotTokenMasked : ''
      );
      setIsConfigured(Boolean(data.telegramConfigured));
      onConfiguredChange?.(Boolean(data.telegramConfigured));
      if (typeof data.telegramChatId === 'string' && data.telegramChatId) {
        setChatId(SYSTEM_TELEGRAM_CHAT_ID);
      }
      if (data.telegramMode === 'always' || data.telegramMode === 'fallback') {
        setTelegramMode(data.telegramMode);
      }
      if (typeof data.telegramSenderEnabled === 'boolean') {
        setTelegramSenderEnabled(data.telegramSenderEnabled);
      }
      if (typeof data.subscribersCount === 'number') {
        setSubscribersCount(data.subscribersCount);
      }
      if (typeof data.lastCheckedAt === 'string') {
        setLastCheckedAt(data.lastCheckedAt);
      }
      if (Array.isArray(data.cisdTimeframes)) {
        const filtered = data.cisdTimeframes.filter((t: string): t is 'M15' => t === 'M15');
        setCisdTimeframes(filtered.length > 0 ? filtered : ['M15']);
      }
      if (typeof data.stochM1Enabled === 'boolean') {
        setStochM1Enabled(data.stochM1Enabled);
      }
      if (typeof data.m15StandaloneAlerts === 'boolean') {
        setM15StandaloneAlerts(data.m15StandaloneAlerts);
      }
      if (Array.isArray(data.events)) {
        setEvents(data.events);
      }
    } catch {
      // Ignore transient network error on mount
    }
  };

  const handleCheckNow = async () => {
    setIsCheckingNow(true);
    setStatusMessage(null);
    try {
      const res = await fetch('/api/monitor/check-now', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'ตรวจสอบสัญญาณไม่สำเร็จ');
      if (typeof data.lastCheckedAt === 'string') setLastCheckedAt(data.lastCheckedAt);
      if (Array.isArray(data.events)) setEvents(data.events);
      setStatusMessage({
        type: 'ok',
        text:
          data.newEventsCount > 0
            ? `ตรวจพบสัญญาณใหม่ ${data.newEventsCount} รายการ และส่งเข้า Telegram แล้ว`
            : 'สแกนกราฟ M15 CISD และ M1 Stoch ล่าสุดแล้ว ระบบกำลังเฝ้ารอปิดแท่งเข้าเงื่อนไขใหม่',
      });
    } catch (err: any) {
      setStatusMessage({
        type: 'err',
        text: err?.message || 'ตรวจสอบสัญญาณล่าสุดไม่สำเร็จ',
      });
    } finally {
      setIsCheckingNow(false);
    }
  };

  useEffect(() => {
    void loadStatus();
  }, []);

  const applyMql5SyncIfChecked = (tokenVal: string, chatVal: string) => {
    if (!syncToMql5) return;
    const effectiveToken = tokenVal.trim() || mql5Config.telegramBotToken;
    onUpdateMql5Config({
      ...mql5Config,
      enableTelegram: Boolean(effectiveToken && chatVal.trim()),
      telegramBotToken: effectiveToken,
      telegramChatId: chatVal.trim(),
    });
  };

  const handleAutoDetectChatId = async () => {
    if (!botToken.trim() && !hasSavedToken) {
      setStatusMessage({
        type: 'err',
        text: 'กรุณากรอก Bot Token จาก @BotFather ก่อนกดดึง Chat ID',
      });
      return;
    }

    setIsBusy(true);
    setStatusMessage(null);
    try {
      const res = await fetch('/api/monitor/telegram-detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegramBotToken: botToken.trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.botUrl) {
        setBotLink({ username: data.botUsername, url: data.botUrl });
      }
      if (!res.ok) {
        throw new Error(data.error || 'ดึง Chat ID ไม่สำเร็จ');
      }

      setHasSavedToken(true);

      if (data.needsStart) {
        setStatusMessage({
          type: 'warn',
          text:
            data.message ||
            'กรุณากดเปิดแชทบอทใน Telegram แล้วกดปุ่ม Start 1 ครั้ง จากนั้นกดปุ่มดึง Chat ID อีกครั้ง',
        });
        return;
      }

      if (data.detectedChatId) {
        const detected = String(data.detectedChatId);
        setChatId(detected);
        setIsConfigured(true);
        onConfiguredChange?.(true);
        const effectiveToken = botToken.trim() || mql5Config.telegramBotToken;
        if (effectiveToken) {
          saveTelegramConfigLocally({
            telegramBotToken: effectiveToken,
            telegramChatId: detected,
            telegramMode,
          });
        }
        applyMql5SyncIfChecked(botToken, detected);

        // Immediately send confirmation test message
        const testRes = await fetch('/api/monitor/test-telegram', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            telegramBotToken: botToken.trim(),
            telegramChatId: detected,
          }),
        });
        if (testRes.ok) {
          setStatusMessage({
            type: 'ok',
            text: `พบ Chat ID (${detected}) และส่งข้อความทดสอบเข้า Telegram สำเร็จแล้ว`,
          });
        } else {
          setStatusMessage({
            type: 'ok',
            text: `ดึง Chat ID (${detected}) สำเร็จแล้ว กรุณากดบันทึกและทดสอบ`,
          });
        }
      }
    } catch (err: any) {
      setStatusMessage({
        type: 'err',
        text: err?.message || 'ดึง Chat ID ไม่สำเร็จ',
      });
    } finally {
      setIsBusy(false);
    }
  };

  const handleSaveOnly = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!trimmedChatId || (!botToken.trim() && !hasSavedToken)) {
      setStatusMessage({
        type: 'err',
        text: 'กรุณากรอก Bot Token และ Chat ID ของ Telegram',
      });
      return;
    }

    setIsBusy(true);
    setStatusMessage(null);
    try {
      const res = await fetch('/api/monitor/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegramBotToken: botToken.trim(),
          telegramChatId: trimmedChatId,
          telegramMode,
          m15Enabled: cisdTimeframes.length > 0,
          m15StandaloneAlerts,
          cisdTimeframes,
          stochM1Enabled,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'บันทึกการตั้งค่าไม่สำเร็จ');

      setHasSavedToken(Boolean(data.telegramHasToken));
      setIsConfigured(Boolean(data.telegramConfigured));
      onConfiguredChange?.(Boolean(data.telegramConfigured));
      const effectiveToken = botToken.trim() || mql5Config.telegramBotToken;
      if (effectiveToken && trimmedChatId) {
        saveTelegramConfigLocally({
          telegramBotToken: effectiveToken,
          telegramChatId: trimmedChatId,
          telegramMode,
        });
      }
      applyMql5SyncIfChecked(botToken, trimmedChatId);
      setStatusMessage({
        type: data.telegramConfigured ? 'ok' : 'warn',
        text: data.telegramConfigured
          ? 'บันทึกเรียบร้อย เซิร์ฟเวอร์เริ่มส่งสัญญาณ CISD (M15) และ Stoch (M1) เข้าแชท Telegram อัตโนมัติแล้ว'
          : 'บันทึกแล้ว กรุณาตรวจสอบ Chat ID ตัวเลข (กด "ดึง Chat ID อัตโนมัติ" หากยังไม่ทราบเลข)',
      });
      await loadStatus();
    } catch (err: any) {
      setStatusMessage({
        type: 'err',
        text: err?.message || 'บันทึกการตั้งค่าไม่สำเร็จ',
      });
    } finally {
      setIsBusy(false);
    }
  };

  const handleSaveAndTest = async () => {
    if (!trimmedChatId || (!botToken.trim() && !hasSavedToken)) {
      setStatusMessage({
        type: 'err',
        text: 'กรุณากรอก Bot Token และ Chat ID ก่อนทดสอบ (หรือกดปุ่ม "ดึง Chat ID อัตโนมัติ")',
      });
      return;
    }

    setIsBusy(true);
    setStatusMessage(null);
    try {
      await fetch('/api/monitor/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegramBotToken: botToken.trim(),
          telegramChatId: trimmedChatId,
          telegramMode,
          m15Enabled: cisdTimeframes.length > 0,
          m15StandaloneAlerts,
          cisdTimeframes,
          stochM1Enabled,
        }),
      });

      const res = await fetch('/api/monitor/test-telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegramBotToken: botToken.trim(),
          telegramChatId: trimmedChatId,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (body.botUrl) {
        setBotLink({ username: body.botUsername, url: body.botUrl });
      }
      if (!res.ok) {
        throw new Error(body.error || 'ส่งข้อความเข้า Telegram ไม่สำเร็จ');
      }

      setHasSavedToken(true);
      setIsConfigured(true);
      onConfiguredChange?.(true);
      const effectiveToken = botToken.trim() || mql5Config.telegramBotToken;
      if (effectiveToken && trimmedChatId) {
        saveTelegramConfigLocally({
          telegramBotToken: effectiveToken,
          telegramChatId: trimmedChatId,
          telegramMode,
        });
      }
      applyMql5SyncIfChecked(botToken, trimmedChatId);
      setStatusMessage({
        type: 'ok',
        text: 'ส่งข้อความทดสอบเข้า Telegram สำเร็จ พร้อมรับสัญญาณ CISD (M15) และ Stoch (M1) อัตโนมัติแล้ว',
      });
      await loadStatus();
    } catch (err: any) {
      setStatusMessage({
        type: 'err',
        text: err?.message || 'ส่งข้อความเข้า Telegram ไม่สำเร็จ',
      });
    } finally {
      setIsBusy(false);
    }
  };

  const handleDisconnect = async () => {
    setIsBusy(true);
    setStatusMessage(null);
    try {
      const res = await fetch('/api/monitor/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clearTelegram: true }),
      });
      if (!res.ok) throw new Error('ยกเลิกการเชื่อมต่อไม่สำเร็จ');
      clearSavedTelegramConfig();
      setHasSavedToken(false);
      setIsConfigured(false);
      onConfiguredChange?.(false);
      setBotToken('');
      setChatId(SYSTEM_TELEGRAM_CHAT_ID);
      setBotLink(null);
      if (syncToMql5) {
        onUpdateMql5Config({
          ...mql5Config,
          enableTelegram: false,
          telegramBotToken: '',
          telegramChatId: SYSTEM_TELEGRAM_CHAT_ID,
        });
      }
      setStatusMessage({
        type: 'ok',
        text: 'ยกเลิกการเชื่อมต่อ Telegram แล้ว',
      });
    } catch (err: any) {
      setStatusMessage({
        type: 'err',
        text: err?.message || 'ยกเลิกไม่สำเร็จ',
      });
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <section className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-start">
      {/* Main Form */}
      <form
        onSubmit={handleSaveOnly}
        className="lg:col-span-7 rounded-xl border border-slate-200/90 bg-white p-6 space-y-5 dark:border-slate-800/90 dark:bg-[#0e1525]"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4 dark:border-slate-800">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              ตั้งค่าการเชื่อมต่อ Telegram Bot
            </h2>
            <p className="mt-1 text-[13px] text-slate-600 dark:text-slate-400">
              แจ้งเตือน ท่า T01 (Step 1 M15 CISD → Step 2 M1 Stoch ปิด &lt; 20 / &gt; 80 พร้อมรีเซ็ตรอบ 2) เข้าแชท Telegram อัตโนมัติ
            </p>
          </div>
          <span
            className={`inline-flex items-center gap-1.5 text-[13px] font-semibold ${
              isConfigured
                ? 'text-emerald-700 dark:text-emerald-400'
                : 'text-amber-700 dark:text-amber-400'
            }`}
          >
            {isConfigured ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <AlertCircle className="h-4 w-4 text-amber-500 dark:text-amber-400" />
            )}
            {isConfigured
              ? 'เชื่อมต่อแล้ว'
              : hasSavedToken
              ? 'รอ Chat ID ตัวเลข'
              : 'ยังไม่ตั้งค่า'}
          </span>
        </div>

        {hasSavedToken && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 px-3.5 py-2.5 text-xs text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-950/45 dark:text-emerald-200">
            <span className="font-semibold">ใช้รหัสเดิมที่บันทึกไว้บนเซิร์ฟเวอร์แล้ว:</span>{' '}
            <span className="font-mono">
              Token {savedTokenMasked || '••••••••'} · Chat ID {trimmedChatId || '-'}
            </span>
            <span className="block mt-0.5 text-emerald-700 dark:text-emerald-300">
              ไม่ต้องกรอกรหัสใหม่ สามารถกดปุ่ม “บันทึกและทดสอบส่งข้อความ” ด้านล่างเพื่อทดสอบเข้าแชทได้ทันที
            </span>
          </div>
        )}

        {/* Bot Token */}
        <div className="space-y-1.5">
          <label
            htmlFor="telegram-config-token"
            className="block text-[13px] font-medium text-slate-700 dark:text-slate-300"
          >
            Telegram Bot Token
          </label>
          <div className="relative">
            <input
              id="telegram-config-token"
              type={showToken ? 'text' : 'password'}
              autoComplete="off"
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              placeholder={
                hasSavedToken
                  ? `ใช้ Bot Token เดิม (${savedTokenMasked || 'บันทึกไว้แล้ว'}) — กรอกใหม่เฉพาะเมื่อต้องการเปลี่ยน`
                  : 'เช่น 123456789:ABCdefGHIjklMNOpqrsTUVwxyz'
              }
              className="h-10 w-full rounded-lg border border-slate-200 bg-white pl-3.5 pr-10 font-mono text-[13px] text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus:border-blue-400"
            />
            <button
              type="button"
              onClick={() => setShowToken((s) => !s)}
              aria-label={showToken ? 'ซ่อน Token' : 'แสดง Token'}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
            >
              {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>

        {/* Chat ID + Group Verification */}
        <div className="space-y-2">
          <label
            htmlFor="telegram-config-chat-id"
            className="block text-[13px] font-medium text-slate-700 dark:text-slate-300"
          >
            Telegram Chat ID (แชทแจ้งเตือนหลักของระบบ)
          </label>
          <div className="flex flex-col gap-2.5 sm:flex-row">
            <input
              id="telegram-config-chat-id"
              type="text"
              readOnly
              value={SYSTEM_TELEGRAM_CHAT_ID}
              className="h-10 flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3.5 font-mono text-[13px] font-semibold text-slate-900 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:border-blue-400"
            />
            <button
              type="button"
              disabled={isBusy || (!botToken.trim() && !hasSavedToken)}
              onClick={() => void handleAutoDetectChatId()}
              className="inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-4 text-[13px] font-medium text-blue-700 whitespace-nowrap transition-colors hover:bg-blue-100 disabled:opacity-50 dark:border-blue-500/30 dark:bg-blue-950/50 dark:text-blue-300 dark:hover:bg-blue-900/50"
            >
              <Search className="h-4 w-4" />
              ตรวจสอบสิทธิ์แชท
            </button>
          </div>

          {isLikelyInvalidChatId && (
            <p className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>
                “{trimmedChatId}” ไม่ใช่ Chat ID ตัวเลข — ให้เปิดแชทบอทใน Telegram กด <strong>Start</strong> แล้วกด <strong>ดึง Chat ID อัตโนมัติ</strong>
              </span>
            </p>
          )}

          {botLink && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3.5 py-2.5 text-xs text-sky-900 dark:border-sky-500/30 dark:bg-sky-950/50 dark:text-sky-200">
              <span>
                1. กดเปิดแชทบอท{' '}
                <span className="font-mono font-semibold">
                  @{botLink.username}
                </span>{' '}
                แล้วกดปุ่ม <strong>Start</strong> → 2. กลับมากด{' '}
                <strong>ดึง Chat ID อัตโนมัติ</strong>
              </span>
              <a
                href={botLink.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-700"
              >
                เปิดแชทบอท
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </div>
          )}
        </div>

        {/* Delivery Mode: Fallback vs Always */}
        <div className="space-y-2 border-t border-slate-100 pt-5 dark:border-slate-800">
          <label className="block text-[13px] font-medium text-slate-700 dark:text-slate-300">
            เงื่อนไขการส่งข้อความเข้า Telegram
          </label>
          <div className="grid grid-cols-1 gap-1.5 rounded-lg bg-slate-100 p-1 sm:grid-cols-2 dark:bg-slate-900">
            <button
              type="button"
              onClick={() => setTelegramMode('fallback')}
              className={`h-9 rounded-md px-3 text-xs font-medium whitespace-nowrap transition-colors ${
                telegramMode === 'fallback'
                  ? 'bg-white text-slate-900 shadow-xs dark:bg-slate-800 dark:text-slate-100'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
              }`}
            >
              สำรองเมื่อ Android Push ไม่ทำงาน
            </button>
            <button
              type="button"
              onClick={() => setTelegramMode('always')}
              className={`h-9 rounded-md px-3 text-xs font-medium whitespace-nowrap transition-colors ${
                telegramMode === 'always'
                  ? 'bg-white text-slate-900 shadow-xs dark:bg-slate-800 dark:text-slate-100'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
              }`}
            >
              ส่งคู่ขนานทุกสัญญาณ (Always)
            </button>
          </div>
          <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            {telegramMode === 'fallback'
              ? `สถานะปัจจุบัน: มีอุปกรณ์ Android Web Push เชื่อมต่ออยู่ ${subscribersCount} เครื่อง (ถ้าส่งเข้ามือถือไม่ได้ ระบบจะสลับส่งเข้า Telegram ทันที)`
              : 'ส่งข้อความเข้า Telegram ทันทีทุกครั้งที่เกิดสัญญาณ BUY / SELL'}
          </p>

          <label className="mt-2 flex items-start gap-2.5 rounded-lg border border-amber-200/80 bg-amber-50/70 px-3.5 py-2.5 text-xs text-amber-900 cursor-pointer dark:border-amber-500/30 dark:bg-amber-950/45 dark:text-amber-200">
            <input
              type="checkbox"
              checked={telegramSenderEnabled}
              onChange={(e) => {
                const next = e.target.checked;
                setTelegramSenderEnabled(next);
                void fetch('/api/monitor/config', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ telegramSenderEnabled: next }),
                }).catch(() => {});
              }}
              className="mt-0.5 h-3.5 w-3.5 rounded border-amber-400 text-blue-600 focus:ring-blue-600 dark:border-amber-500/50 dark:bg-slate-900"
            />
            <span className="leading-relaxed">
              <strong className="font-semibold">อนุญาตให้เซิร์ฟเวอร์นี้ส่งข้อความเข้า Telegram</strong>
              {' '}— หากเปิดใช้งานเว็บนี้ทั้งบน Render และ AI Studio (หรือลิงก์แชร์) ด้วย Bot Token เดียวกันพร้อมกัน ให้ติ๊กปิดบนฝั่งใดฝั่งหนึ่ง เพื่อป้องกันข้อความเข้าซ้ำ 2 เด้ง
            </span>
          </label>
        </div>

        {/* Signal Systems Settings */}
        <div className="space-y-3 border-t border-slate-100 pt-5 dark:border-slate-800">
          <div className="rounded-lg border border-slate-200/80 bg-slate-50/70 p-3.5 space-y-2 dark:border-slate-800 dark:bg-slate-900/70">
            <span className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
              ระบบสัญญาณที่เปิดรับการแจ้งเตือน (CISD M15 &amp; Stoch M1)
            </span>
            <div className="flex flex-wrap gap-2">
              {(['M15'] as const).map((tf) => {
                const active = cisdTimeframes.includes(tf);
                return (
                  <button
                    key={`tg-cisd-${tf}`}
                    type="button"
                    onClick={() => {
                      const next = active
                        ? cisdTimeframes.filter((t) => t !== tf)
                        : [...cisdTimeframes, tf];
                      setCisdTimeframes(next);
                      void fetch('/api/monitor/config', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          m15Enabled: next.length > 0,
                          cisdTimeframes: next,
                        }),
                      }).catch(() => {});
                    }}
                    className={`h-8 rounded-md px-3 font-mono text-xs font-semibold transition-colors ${
                      active
                        ? 'bg-slate-900 text-white dark:bg-blue-600'
                        : 'border border-slate-200 bg-white text-slate-500 hover:text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
                    }`}
                  >
                    CISD {tf}
                  </button>
                );
              })}

              <button
                type="button"
                onClick={() => {
                  const next = !stochM1Enabled;
                  setStochM1Enabled(next);
                  void fetch('/api/monitor/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ stochM1Enabled: next }),
                  }).catch(() => {});
                }}
                className={`h-8 rounded-md px-3 font-mono text-xs font-semibold transition-colors ${
                  stochM1Enabled
                    ? 'bg-slate-900 text-white dark:bg-blue-600'
                    : 'border border-slate-200 bg-white text-slate-500 hover:text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
                }`}
              >
                Stoch(15,3,3) M1 (ท่า T01)
              </button>
            </div>

            <label className="flex items-start gap-2 pt-1.5 text-xs text-slate-600 cursor-pointer dark:text-slate-400">
              <input
                type="checkbox"
                checked={m15StandaloneAlerts}
                onChange={(e) => {
                  const next = e.target.checked;
                  setM15StandaloneAlerts(next);
                  void fetch('/api/monitor/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ m15StandaloneAlerts: next }),
                  }).catch(() => {});
                }}
                className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-600 dark:border-slate-600 dark:bg-slate-900"
              />
              <span>
                แจ้งเตือนตอน M15 CISD จบแยกต่างหากด้วย (ปกติปิด — ระบบจะเตือนเมื่อครบ M15 CISD + M1 Stoch ตามท่า T01)
              </span>
            </label>
          </div>
        </div>

        {/* Optional MQL5 Sync */}
        <label className="flex items-center gap-2.5 text-[13px] text-slate-700 cursor-pointer pt-1 dark:text-slate-300">
          <input
            type="checkbox"
            checked={syncToMql5}
            onChange={(e) => setSyncToMql5(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-600 dark:border-slate-600 dark:bg-slate-900"
          />
          <span>อัปเดต Token และ Chat ID นี้เข้าโค้ด MT5 EA ในแท็บ โค้ด MQL5 ด้วย</span>
        </label>

        {statusMessage && (
          <div
            className={`flex items-start gap-2.5 rounded-lg border px-4 py-3 text-[13px] ${
              statusMessage.type === 'ok'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-950/50 dark:text-emerald-200'
                : statusMessage.type === 'warn'
                ? 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-950/50 dark:text-amber-200'
                : 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-500/30 dark:bg-rose-950/50 dark:text-rose-200'
            }`}
          >
            {statusMessage.type === 'ok' ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            )}
            <span>{statusMessage.text}</span>
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2.5 pt-4 border-t border-slate-100 dark:border-slate-800">
          <button
            type="button"
            disabled={isBusy}
            onClick={() => void handleSaveAndTest()}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-blue-600 px-4 text-[13px] font-medium text-white whitespace-nowrap transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            <Send className="h-4 w-4" />
            บันทึกและทดสอบส่งข้อความ
          </button>

          <button
            type="submit"
            disabled={isBusy}
            className="inline-flex h-10 items-center rounded-lg border border-slate-200 bg-white px-4 text-[13px] font-medium text-slate-700 whitespace-nowrap transition-colors hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            บันทึกการตั้งค่า
          </button>

          {(hasSavedToken || isConfigured) && (
            <button
              type="button"
              disabled={isBusy}
              onClick={() => void handleDisconnect()}
              className="ml-auto inline-flex h-10 items-center gap-1.5 rounded-lg border border-slate-200 px-3.5 text-[13px] font-medium text-rose-600 whitespace-nowrap transition-colors hover:bg-rose-50 disabled:opacity-50 dark:border-slate-700 dark:text-rose-400 dark:hover:bg-rose-950/50"
            >
              <Trash2 className="h-4 w-4" />
              ยกเลิกการเชื่อมต่อ
            </button>
          )}
        </div>
      </form>

      {/* Right Column: Quick Setup Guide + Recent Server Alerts */}
      <div className="lg:col-span-5 space-y-5">
        <div className="rounded-xl border border-slate-200/90 bg-white p-5 sm:p-6 space-y-3.5 dark:border-slate-800/90 dark:bg-[#0e1525]">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            <h3 className="text-[15px] font-semibold text-slate-900 dark:text-slate-100">
              วิธีเชื่อมต่อเข้ากลุ่มแจ้งเตือน (3 ขั้นตอน)
            </h3>
          </div>
          <ol className="space-y-2.5 text-[13px] leading-relaxed text-slate-600 list-decimal list-inside dark:text-slate-400">
            <li>
              ใช้ <strong>Bot Token</strong> เดิมที่บันทึกไว้บนเซิร์ฟเวอร์ หรือวาง Token จาก{' '}
              <span className="font-mono font-medium text-slate-900 dark:text-slate-100">@BotFather</span>
            </li>
            <li>
              ระบบล็อกการแจ้งเตือนทั้งหมดเข้าแชท{' '}
              <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">8217822307</span> เพียงแห่งเดียว
            </li>
            <li>
              กด <strong>ตรวจสอบสิทธิ์แชท</strong> หรือ <strong>บันทึกและทดสอบส่งข้อความ</strong> เพื่อส่งทดสอบเข้าแชททันที
            </li>
          </ol>
        </div>

        <div className="rounded-xl border border-slate-200/90 bg-white p-5 sm:p-6 space-y-3.5 dark:border-slate-800/90 dark:bg-[#0e1525]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-[15px] font-semibold text-slate-900 dark:text-slate-100">
                ประวัติการแจ้งเตือนจากเซิร์ฟเวอร์
              </h3>
              {lastCheckedAt && (
                <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                  เซิร์ฟเวอร์ตรวจกราฟล่าสุด:{' '}
                  {new Date(lastCheckedAt).toLocaleTimeString('th-TH', {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    timeZone: 'Asia/Bangkok',
                  })}{' '}
                  น.
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-slate-500 tabular-nums dark:text-slate-400">
                {events.length} รายการ
              </span>
              <button
                type="button"
                disabled={isCheckingNow}
                onClick={() => void handleCheckNow()}
                className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${isCheckingNow ? 'animate-spin' : ''}`} />
                สแกนกราฟทันที
              </button>
            </div>
          </div>

          {events.length === 0 ? (
            <p className="text-[13px] text-slate-500 dark:text-slate-400">
              ยังไม่มีสัญญาณปิดแท่งทะลุแนว CISD ใหม่ตั้งแต่เชื่อมต่อรอบล่าสุด
            </p>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {events.slice(0, 8).map((ev) => (
                <li
                  key={ev.id}
                  className="flex items-center justify-between gap-2 py-2.5 text-[13px]"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span
                        className={`font-semibold ${
                          ev.signal === 'BUY'
                            ? 'text-emerald-700 dark:text-emerald-400'
                            : 'text-rose-700 dark:text-rose-400'
                        }`}
                      >
                        {ev.strategy === 'STOCH'
                          ? `T01 ${ev.signal}${
                              ev.t01Round && ev.t01Round > 0 ? ` R${ev.t01Round}` : ''
                            }`
                          : ev.signal}
                      </span>
                      <span className="font-medium text-slate-900 dark:text-slate-100">{ev.symbol}</span>
                      <span className="font-mono text-xs text-slate-500 dark:text-slate-400">
                        {ev.strategy === 'STOCH'
                          ? `M15 CISD + M1 ${ev.signal === 'BUY' ? '<20' : '>80'}`
                          : `${ev.strategy || 'CISD'} ${ev.timeframe || 'M15'}`}
                      </span>
                      <span className="font-mono text-xs text-slate-600 tabular-nums dark:text-slate-300">
                        {ev.price}
                        {ev.strategy === 'STOCH' &&
                        typeof ev.stochK === 'number' &&
                        Number.isFinite(ev.stochK)
                          ? ` (${ev.stochK.toFixed(2)})`
                          : ''}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{ev.timestamp}</p>
                    {ev.telegramError && (
                      <p className="mt-0.5 text-[11px] text-rose-600 dark:text-rose-400">{ev.telegramError}</p>
                    )}
                  </div>
                  <div className="text-right text-xs text-slate-600 dark:text-slate-400">
                    {ev.deliveredToTelegram ? (
                      <span className="text-sky-700 font-medium dark:text-sky-400">Telegram ✓</span>
                    ) : ev.deliveredWebPushCount > 0 ? (
                      <span className="text-emerald-700 font-medium dark:text-emerald-400">Android Push ✓</span>
                    ) : (
                      <span className="text-amber-700 dark:text-amber-400">บันทึกแล้ว</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
};
