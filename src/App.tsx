import React, { useEffect, useState } from 'react';
import { ArrowLeft, Download } from 'lucide-react';
import { AoChartSimulator } from './components/AoChartSimulator';
import { Mql5Studio } from './components/Mql5Studio';
import { AndroidSetupGuide } from './components/AndroidSetupGuide';
import { GoogleSheetsSync } from './components/GoogleSheetsSync';
import { TelegramConfig } from './components/TelegramConfig';
import { ServerDeployPanel } from './components/ServerDeployPanel';
import { StochChartPage } from './components/StochChartPage';
import {
  DEFAULT_MQL5_CONFIG,
  Mql5Config,
  generateMql5Code,
  getMql5Filename,
} from './lib/mql5Generator';
import type { SignalLogRecord } from './lib/sheetsApi';
import {
  OfflineIndicator,
  PWAInstallButton,
} from './components/PWAInstallButton';
import { loadSavedTelegramConfig } from './lib/telegramStorage';
import { loadSavedGithubConfig } from './lib/githubStorage';

type ActiveSection = 'simulator' | 'stoch' | 'mql5' | 'android' | 'telegram' | 'sheets' | 'deploy';

const NAV_ITEMS: Array<{ id: ActiveSection; label: string }> = [
  { id: 'simulator', label: 'จำลองกราฟ' },
  { id: 'stoch', label: 'Stoch M5' },
  { id: 'mql5', label: 'โค้ด MQL5' },
  { id: 'android', label: 'ตั้งค่ามือถือ' },
  { id: 'telegram', label: 'Telegram' },
  { id: 'sheets', label: 'Google Sheets' },
  { id: 'deploy', label: 'นำขึ้น Server' },
];

export default function App() {
  const [activeSection, setActiveSection] = useState<ActiveSection>('simulator');
  const [mql5Config, setMql5Config] = useState<Mql5Config>(DEFAULT_MQL5_CONFIG);
  const [signals, setSignals] = useState<SignalLogRecord[]>([]);
  const [telegramSyncedReady, setTelegramSyncedReady] = useState<boolean | null>(null);
  const [devPreviewWeb, setDevPreviewWeb] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    const params = new URLSearchParams(window.location.search);
    return params.get('view') === 'web';
  });

  const forceStudio =
    typeof window !== 'undefined' &&
    ['1', 'true'].includes(
      new URLSearchParams(window.location.search).get('studio') || ''
    );
  const isWebMode = (import.meta.env.PROD && !forceStudio) || devPreviewWeb;

  useEffect(() => {
    let cancelled = false;
    const syncSavedTelegram = async () => {
      const saved = loadSavedTelegramConfig();
      if (saved && !cancelled) {
        setMql5Config((prev) => ({
          ...prev,
          enableTelegram: true,
          telegramBotToken: prev.telegramBotToken || saved.telegramBotToken,
          telegramChatId: prev.telegramChatId || saved.telegramChatId,
        }));
      }
      try {
        const res = await fetch('/api/monitor/status');
        if (!res.ok) return;
        const status = await res.json();
        if (status.telegramConfigured) {
          if (!cancelled) setTelegramSyncedReady(true);
          return;
        }
        if (saved) {
          const restoreRes = await fetch('/api/monitor/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(saved),
          });
          if (restoreRes.ok) {
            const restored = await restoreRes.json();
            if (!cancelled) setTelegramSyncedReady(Boolean(restored.telegramConfigured));
            return;
          }
        }
        if (!cancelled) setTelegramSyncedReady(false);
      } catch {
        // Ignore transient startup network errors
      }
    };
    void syncSavedTelegram();

    const syncSavedGithub = async () => {
      const savedGithub = loadSavedGithubConfig();
      if (!savedGithub) return;
      try {
        const res = await fetch('/api/github/status');
        if (!res.ok) return;
        const status = await res.json();
        if (status.connected) return;
        await fetch('/api/github/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...savedGithub,
            syncImmediately: false,
          }),
        });
      } catch {
        // Ignore transient startup network errors
      }
    };
    void syncSavedGithub();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleSignalDetected = (record: SignalLogRecord) => {
    setSignals((prev) => [record, ...prev].slice(0, 50));
  };

  const handleMarkSignalsSynced = (ids: string[]) => {
    const idSet = new Set(ids);
    setSignals((prev) =>
      prev.map((item) =>
        idSet.has(item.id) ? { ...item, syncedToSheet: true } : item
      )
    );
  };

  const handleAddManualTestSignal = () => {
    const isBuy = signals.length % 2 === 0;
    const nowStr = new Date().toLocaleString('th-TH', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

    handleSignalDetected({
      id: `sample-${Date.now()}`,
      timestamp: nowStr,
      symbol: 'US100',
      timeframe: mql5Config.lockM5 ? 'M5' : 'Current',
      signal: isBuy ? 'BUY' : 'SELL',
      aoPrev: isBuy ? -18.42 : 21.45,
      aoCurr: isBuy ? 14.25 : -16.3,
      price: isBuy ? 20950.0 : 20935.5,
      pushStatus: 'Android Push Sent',
      note: isBuy ? 'AO ตัด 0 ขึ้น' : 'AO ตัด 0 ลง',
      syncedToSheet: false,
    });
  };

  const handleQuickDownload = () => {
    const code = generateMql5Code(mql5Config);
    const filename = getMql5Filename(mql5Config);
    const blob = new Blob([code], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const unsyncedCount = signals.filter((s) => !s.syncedToSheet).length;

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      {/* Studio Top Bar: hidden on deployed online web view to match clean live UI */}
      {!isWebMode && (
        <header className="border-b border-slate-200/80 bg-white">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-8 px-4 py-4 sm:px-6 lg:px-8">
            {/* Zone 1: Brand wordmark only */}
            <a
              href="#top"
              onClick={(e) => {
                e.preventDefault();
                setActiveSection('simulator');
              }}
              className="text-base font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
            >
              AO Signal Studio
            </a>

            {/* Zone 2: concise single-line nav links */}
            <nav
              aria-label="เมนูหลัก"
              className="hidden md:flex items-center gap-4 lg:gap-5 text-sm font-medium"
            >
              {NAV_ITEMS.map((item) => {
                const isActive = activeSection === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setActiveSection(item.id)}
                    className={`py-1 whitespace-nowrap shrink-0 border-b-2 transition-colors focus-visible:outline-2 focus-visible:outline-blue-600 ${
                      isActive
                        ? 'border-blue-600 text-slate-900'
                        : 'border-transparent text-slate-500 hover:text-slate-900 hover:border-slate-300'
                    }`}
                  >
                    {item.label}
                    {item.id === 'sheets' && unsyncedCount > 0
                      ? ` (${unsyncedCount})`
                      : ''}
                  </button>
                );
              })}
            </nav>

            {/* Zone 3: 1 primary action + optional PWA install */}
            <div className="flex items-center gap-2 shrink-0">
              <PWAInstallButton />
              <button
                type="button"
                onClick={handleQuickDownload}
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-blue-600 px-4 text-xs font-medium text-white whitespace-nowrap shrink-0 transition-colors hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-blue-600"
              >
                <Download className="h-3.5 w-3.5" />
                ดาวน์โหลด .mq5
              </button>
            </div>
          </div>

          {/* Mobile Nav Switcher */}
          <div className="flex md:hidden items-center gap-2 overflow-x-auto border-t border-slate-100 px-4 py-2">
            {NAV_ITEMS.map((item) => {
              const isActive = activeSection === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveSection(item.id)}
                  className={`h-9 rounded-md px-3 text-xs font-medium whitespace-nowrap shrink-0 transition-colors ${
                    isActive
                      ? 'bg-slate-900 text-white'
                      : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
        </header>
      )}

      {/* Main Workspace */}
      <main
        id="top"
        className={`mx-auto w-full max-w-6xl flex-1 px-4 sm:px-6 lg:px-8 ${
          isWebMode ? 'py-5' : 'py-8'
        }`}
      >
        {/* Dev preview exit pill (only visible when previewing web mode inside Dev Studio) */}
        {devPreviewWeb && !import.meta.env.PROD && (
          <div className="mb-3 flex items-center justify-between rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
            <span>กำลังดูตัวอย่างหน้าตาเว็บจริง (เมื่อนำขึ้น GitHub / Server ออนไลน์)</span>
            <button
              type="button"
              onClick={() => {
                setDevPreviewWeb(false);
                setActiveSection('deploy');
              }}
              className="inline-flex items-center gap-1 font-semibold text-blue-700 hover:underline"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              กลับหน้า Studio
            </button>
          </div>
        )}

        {/* Back button when opening sub-views from deployed web UI */}
        {isWebMode && activeSection !== 'simulator' && activeSection !== 'stoch' && (
          <div className="mb-4">
            <button
              type="button"
              onClick={() => setActiveSection('simulator')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              กลับหน้ากราฟ
            </button>
          </div>
        )}

        {/* Clean Minimal Title + Web-Mode Chart Switcher */}
        <div
          className={`flex flex-wrap items-end justify-between gap-3 ${
            isWebMode ? 'mb-4' : 'mb-7'
          }`}
        >
          <div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900 sm:text-2xl text-balance">
              {activeSection === 'stoch'
                ? 'กราฟ M5 Stochastic (15,3,3)'
                : isWebMode
                ? 'แจ้งเตือน AO'
                : `แจ้งเตือน AO ตัดเส้น 0 (${mql5Config.lockM5 ? 'M5' : 'Chart'}) เข้ามือถือ Android`}
            </h1>
            <p className="mt-1 text-xs text-slate-500">
              {activeSection === 'stoch'
                ? 'MetaTrader 5 · US100 M5 · Stoch(15,3,3) เส้นสีฟ้าเส้นเดียว · แจ้งเตือนปิด > 80 / < 20'
                : isWebMode
                ? 'MetaTrader 5 · BUY / SELL'
                : 'MetaTrader 5 · BUY / SELL · เสียงแจ้งเตือน 10 วินาที · Google Sheets'}
            </p>
          </div>

          {isWebMode && (activeSection === 'simulator' || activeSection === 'stoch') && (
            <div className="flex items-center gap-1 rounded-lg bg-slate-200/70 p-1">
              <button
                type="button"
                onClick={() => setActiveSection('simulator')}
                className={`h-8 rounded-md px-3 text-xs font-medium whitespace-nowrap transition-colors ${
                  activeSection === 'simulator'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                AO M5
              </button>
              <button
                type="button"
                onClick={() => setActiveSection('stoch')}
                className={`h-8 rounded-md px-3 text-xs font-medium whitespace-nowrap transition-colors ${
                  activeSection === 'stoch'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Stoch (15,3,3) M5
              </button>
            </div>
          )}
        </div>

        {/* Active Workspace View */}
        {activeSection === 'simulator' && (
          <AoChartSimulator
            alertDirection={mql5Config.alertDirection}
            lockM5={mql5Config.lockM5}
            customPrefix={mql5Config.customPrefix}
            onSignalDetected={handleSignalDetected}
            recentSignals={signals}
            onGoToSheets={() => setActiveSection('sheets')}
            onGoToTelegram={() => setActiveSection('telegram')}
            telegramSyncedReady={telegramSyncedReady}
            isWebMode={isWebMode}
          />
        )}

        {activeSection === 'stoch' && <StochChartPage isWebMode={isWebMode} />}

        {activeSection === 'mql5' && (
          <Mql5Studio config={mql5Config} onChangeConfig={setMql5Config} />
        )}

        {activeSection === 'android' && <AndroidSetupGuide />}

        {activeSection === 'telegram' && (
          <TelegramConfig
            mql5Config={mql5Config}
            onUpdateMql5Config={setMql5Config}
            onConfiguredChange={setTelegramSyncedReady}
          />
        )}

        {activeSection === 'sheets' && (
          <GoogleSheetsSync
            pendingSignals={signals}
            onMarkSignalsSynced={handleMarkSignalsSynced}
            onAddManualTestSignal={handleAddManualTestSignal}
          />
        )}

        {activeSection === 'deploy' && (
          <ServerDeployPanel
            onPreviewWebMode={() => {
              setDevPreviewWeb(true);
              setActiveSection('simulator');
            }}
          />
        )}
      </main>

      {/* Quiet Clean Footer (shown in Studio mode only) */}
      {!isWebMode && (
        <footer className="border-t border-slate-200/80 bg-white py-4">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-4 text-xs text-slate-400 sm:px-6 lg:px-8">
            <span>AO Signal Studio</span>
            <span>US100 · M5 (US 100 Index Cash)</span>
          </div>
        </footer>
      )}
      <OfflineIndicator />
    </div>
  );
}
