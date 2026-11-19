import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Eye,
  EyeOff,
  Search,
  Send,
  Users,
  X,
} from 'lucide-react';
import type { TelegramConfigState } from '../types/trading';

interface DiscoveredChat {
  id: string;
  title: string;
  type: string;
  username?: string;
}

interface DiscoverResponse {
  ok: boolean;
  botUsername?: string;
  message?: string;
  currentChatCheck?: {
    ok: boolean;
    chatId: string;
    title?: string;
    type?: string;
    error?: string;
  };
  discoveredChats?: DiscoveredChat[];
}

interface TelegramSettingsModalProps {
  open: boolean;
  config: TelegramConfigState;
  defaultChatId: string;
  onClose: () => void;
  onConfigSynced: (nextConfig: TelegramConfigState, toastMessage: string) => void;
}

export function TelegramSettingsModal({
  open,
  config,
  defaultChatId,
  onClose,
  onConfigSynced,
}: TelegramSettingsModalProps) {
  const [botTokenInput, setBotTokenInput] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [draft, setDraft] = useState<TelegramConfigState>(config);

  const [isSaving, setIsSaving] = useState(false);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [discoveredChats, setDiscoveredChats] = useState<DiscoveredChat[]>([]);
  const [statusFeedback, setStatusFeedback] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  useEffect(() => {
    if (open) {
      setDraft(config);
      setBotTokenInput('');
      setShowToken(false);
      setStatusFeedback(null);
      setDiscoveredChats([]);
    }
  }, [open, config]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isSaving && !isDiscovering) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, isSaving, isDiscovering, onClose]);

  if (!open) return null;

  const trimmedChatId = draft.chatId.trim() || defaultChatId;

  const handleDiscoverAndVerify = async () => {
    setIsDiscovering(true);
    setStatusFeedback(null);
    try {
      const res = await fetch('/api/telegram/discover-chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          botToken: botTokenInput.trim() || undefined,
          chatId: trimmedChatId,
        }),
      });
      const data = (await res.json()) as DiscoverResponse;

      if (!res.ok || !data.ok) {
        setStatusFeedback({
          ok: false,
          message:
            data.message || 'ไม่สามารถตรวจสอบสิทธิ์บอทหรือดึงกลุ่มอัตโนมัติได้',
        });
        setIsDiscovering(false);
        return;
      }

      const chats = data.discoveredChats || [];
      setDiscoveredChats(chats);

      if (data.currentChatCheck?.ok) {
        setStatusFeedback({
          ok: true,
          message: `ตรวจสอบสิทธิ์สำเร็จ (@${data.botUsername || 'Bot'}) · กลุ่ม "${
            data.currentChatCheck.title || trimmedChatId
          }" พร้อมใช้งาน${
            chats.length > 0 ? ` · พบ ${chats.length} แชทที่บอทเข้าร่วม` : ''
          }`,
        });
      } else if (chats.length > 0) {
        // Automatically select the most recent joined group if current isn't found
        const firstGroup = chats.find((c) => c.id.startsWith('-')) || chats[0];
        setDraft((prev) => ({ ...prev, chatId: firstGroup.id }));
        setStatusFeedback({
          ok: true,
          message: `ดึงกลุ่มที่บอทเข้าร่วมอัตโนมัติสำเร็จ (${chats.length} แชท) และเลือก "${firstGroup.title}" (${firstGroup.id}) ให้แล้ว`,
        });
      } else {
        setStatusFeedback({
          ok: false,
          message:
            data.currentChatCheck?.error ||
            `เชื่อมต่อ @${data.botUsername} สำเร็จ แต่ยังไม่พบกลุ่มที่บอทเข้าร่วม — ลองเพิ่มบอทเข้ากลุ่มหรือพิมพ์ข้อความในกลุ่มก่อนแล้วกดตรวจสอบอีกครั้ง`,
        });
      }
    } catch {
      setStatusFeedback({
        ok: false,
        message: 'ไม่สามารถติดต่อเซิร์ฟเวอร์เพื่อตรวจสอบกลุ่ม Telegram ได้',
      });
    } finally {
      setIsDiscovering(false);
    }
  };

  const handleSave = async (withTestSend: boolean) => {
    setIsSaving(true);
    setStatusFeedback(null);
    try {
      const res = await fetch('/api/telegram/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          botToken: botTokenInput.trim() || undefined,
          chatId: trimmedChatId,
          sendCondition: draft.sendCondition,
          parseMode: draft.parseMode,
          testSend: withTestSend,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        configured?: boolean;
        maskedToken?: string;
        botUsername?: string;
        chatId?: string;
        sendCondition?: 'always' | 'fallback';
        message?: string;
      };

      if (!res.ok || !data.ok) {
        setStatusFeedback({
          ok: false,
          message: data.message || 'บันทึกการตั้งค่า Telegram ไม่สำเร็จ',
        });
        if (data.configured && data.maskedToken) {
          onConfigSynced(
            {
              ...draft,
              chatId: data.chatId || trimmedChatId,
              serverTokenConfigured: true,
              maskedToken: data.maskedToken,
              botUsername: data.botUsername,
            },
            data.message || 'อัปเดต Token แล้ว'
          );
        }
        setIsSaving(false);
        return;
      }

      const nextConfig: TelegramConfigState = {
        ...draft,
        enabled: true,
        chatId: data.chatId || trimmedChatId,
        serverTokenConfigured: Boolean(data.configured),
        maskedToken: data.maskedToken || config.maskedToken,
        botUsername: data.botUsername || config.botUsername,
        sendCondition: data.sendCondition || draft.sendCondition,
        autoSendLive: true,
        autoSendSim: true,
      };

      onConfigSynced(
        nextConfig,
        data.message || 'บันทึกการตั้งค่า Telegram Bot เรียบร้อยแล้ว'
      );
      if (withTestSend) {
        setStatusFeedback({
          ok: true,
          message: data.message || 'บันทึกและทดสอบส่งข้อความเข้ากลุ่มสำเร็จ',
        });
        setBotTokenInput('');
      } else {
        onClose();
      }
    } catch {
      setStatusFeedback({
        ok: false,
        message: 'ไม่สามารถติดต่อเซิร์ฟเวอร์เพื่อบันทึก Telegram Bot ได้',
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-3 sm:p-4 backdrop-blur-[2px] overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="telegram-settings-title"
    >
      <div className="my-auto w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2
              id="telegram-settings-title"
              className="text-lg font-bold text-slate-900"
            >
              ตั้งค่าการเชื่อมต่อ Telegram Bot
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-600">
              แจ้งเตือนระบบ AO(5,34) M5 เข้าแชทหรือกลุ่ม Telegram
              อัตโนมัติทันทีเมื่อแท่งเทียนปิดตัดเส้น 0
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving || isDiscovering}
            aria-label="ปิดหน้าต่างตั้งค่า Telegram"
            className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Connection Status Row */}
        <div className="mt-3 flex items-center gap-2 border-b border-slate-100 pb-3.5 text-sm">
          {config.serverTokenConfigured ? (
            <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-700">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden="true" />
              เชื่อมต่อแล้ว
              {config.botUsername ? (
                <span className="font-mono text-xs text-slate-500">
                  (@{config.botUsername})
                </span>
              ) : null}
            </span>
          ) : (
            <span className="text-xs font-medium text-amber-700">
              ยังไม่ได้ใส่ Bot Token · กรอก Token ด้านล่างเพื่อเชื่อมต่อ
            </span>
          )}
        </div>

        {/* Saved Token Green Box (matches screenshot) */}
        {config.serverTokenConfigured && config.maskedToken && (
          <div className="mt-3.5 rounded-xl border border-emerald-200 bg-emerald-50/90 px-3.5 py-3 text-xs leading-relaxed text-emerald-950">
            <p className="font-semibold">
              ใช้รหัสเดิมที่บันทึกไว้บนเซิร์ฟเวอร์แล้ว: Token{' '}
              <span className="font-mono">{config.maskedToken}</span> · Chat ID{' '}
              <span className="font-mono">{config.chatId}</span>
            </p>
            <p className="mt-1 text-emerald-800">
              ไม่ต้องกรอกรหัสใหม่ สามารถกดปุ่ม &ldquo;บันทึกและทดสอบส่งข้อความ&rdquo;
              ด้านล่างเพื่อทดสอบเข้าแชทได้ทันที
            </p>
          </div>
        )}

        <div className="mt-4 space-y-4">
          {/* Telegram Bot Token Input with Eye Toggle */}
          <div>
            <label
              htmlFor="tg-bot-token"
              className="block text-xs font-semibold text-slate-800"
            >
              Telegram Bot Token
            </label>
            <div className="relative mt-1.5">
              <input
                id="tg-bot-token"
                type={showToken ? 'text' : 'password'}
                value={botTokenInput}
                onChange={(e) => setBotTokenInput(e.target.value)}
                autoComplete="off"
                placeholder={
                  config.serverTokenConfigured && config.maskedToken
                    ? `ใช้ Bot Token เดิม (${config.maskedToken})`
                    : 'วาง Bot Token จาก @BotFather (เช่น 123456789:AAH...)'
                }
                className="w-full rounded-xl border border-slate-200 bg-slate-50/70 py-2.5 pl-3.5 pr-10 font-mono text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:bg-white focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShowToken((v) => !v)}
                aria-label={showToken ? 'ซ่อน Bot Token' : 'แสดง Bot Token'}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:text-slate-700"
              >
                {showToken ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>

          {/* Telegram Chat ID + Check Permissions / Auto-Discover Button */}
          <div>
            <label
              htmlFor="tg-chat-id"
              className="block text-xs font-semibold text-slate-800"
            >
              Telegram Chat ID (กลุ่มแจ้งเตือนหลักของระบบ)
            </label>
            <input
              id="tg-chat-id"
              type="text"
              value={draft.chatId}
              onChange={(e) =>
                setDraft((prev) => ({ ...prev, chatId: e.target.value }))
              }
              placeholder="-1004382980885"
              className="mt-1.5 w-full rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-2.5 font-mono text-sm text-slate-900 focus:border-slate-900 focus:bg-white focus:outline-none"
            />

            <button
              type="button"
              onClick={handleDiscoverAndVerify}
              disabled={isDiscovering || isSaving}
              className="mt-2.5 flex w-full items-center justify-center gap-2 rounded-xl border border-sky-200 bg-sky-50/80 px-4 py-2.5 text-sm font-semibold text-sky-700 transition-colors hover:bg-sky-100 disabled:opacity-50"
            >
              <Search className="h-4 w-4 text-sky-600" aria-hidden="true" />
              {isDiscovering
                ? 'กำลังตรวจสอบสิทธิ์และดึงกลุ่ม...'
                : 'ตรวจสอบสิทธิ์กลุ่ม · ดึงแชทอัตโนมัติ'}
            </button>

            {discoveredChats.length > 0 && (
              <div className="mt-2.5 space-y-1.5 rounded-xl border border-slate-200 bg-slate-50 p-2.5">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-600">
                  <Users className="h-3.5 w-3.5" aria-hidden="true" />
                  แชท/กลุ่มที่บอทเข้าร่วม (แตะเพื่อเลือกใช้):
                </div>
                <div className="max-h-32 space-y-1 overflow-y-auto">
                  {discoveredChats.map((chat) => {
                    const selected = draft.chatId.trim() === chat.id;
                    return (
                      <button
                        key={chat.id}
                        type="button"
                        onClick={() =>
                          setDraft((prev) => ({ ...prev, chatId: chat.id }))
                        }
                        className={`flex w-full items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors ${
                          selected
                            ? 'border-sky-300 bg-sky-50 text-sky-900'
                            : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100'
                        }`}
                      >
                        <span className="truncate font-medium">
                          {chat.title}
                        </span>
                        <span className="font-mono text-[11px] text-slate-500 shrink-0">
                          {chat.id}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Segmented Send Condition Selector (matches screenshot) */}
          <div>
            <p className="text-xs font-semibold text-slate-800">
              เงื่อนไขการส่งข้อความเข้า Telegram
            </p>
            <div className="mt-2 rounded-xl bg-slate-100 p-1 space-y-1">
              <button
                type="button"
                onClick={() =>
                  setDraft((prev) => ({ ...prev, sendCondition: 'fallback' }))
                }
                className={`w-full rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
                  draft.sendCondition === 'fallback'
                    ? 'bg-white text-slate-900 shadow-xs font-semibold'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                สำรองเมื่อ Android Push ไม่ทำงาน
              </button>
              <button
                type="button"
                onClick={() =>
                  setDraft((prev) => ({ ...prev, sendCondition: 'always' }))
                }
                className={`w-full rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
                  draft.sendCondition === 'always'
                    ? 'bg-white text-slate-900 shadow-xs font-semibold'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                ส่งคู่ขนานทุกสัญญาณ (Always)
              </button>
            </div>
            <p className="mt-1.5 text-xs text-slate-500">
              ส่งข้อความเข้า Telegram ทันทีทุกครั้งที่เกิดสัญญาณ BUY / SELL
            </p>
          </div>

          {/* Feedback Banner */}
          {statusFeedback && (
            <div
              className={`rounded-xl border px-3.5 py-2.5 text-xs leading-relaxed ${
                statusFeedback.ok
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                  : 'border-rose-200 bg-rose-50 text-rose-900'
              }`}
            >
              {statusFeedback.message}
            </div>
          )}

          {/* Bottom Action Buttons */}
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 pt-3.5">
            <button
              type="button"
              onClick={() => handleSave(false)}
              disabled={isSaving || isDiscovering}
              className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              บันทึก
            </button>
            <button
              type="button"
              onClick={() => handleSave(true)}
              disabled={isSaving || isDiscovering}
              className="inline-flex items-center gap-1.5 rounded-xl bg-slate-900 px-4 py-2.5 text-xs font-semibold text-white transition-colors hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <Send className="h-3.5 w-3.5" aria-hidden="true" />
              {isSaving ? 'กำลังบันทึกและส่ง...' : 'บันทึกและทดสอบส่งข้อความ'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
