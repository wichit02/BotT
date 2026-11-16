import React, { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { AoChartSimulator } from './components/AoChartSimulator';
import { Mql5Studio } from './components/Mql5Studio';
import { AndroidSetupGuide } from './components/AndroidSetupGuide';
import { GoogleSheetsSync } from './components/GoogleSheetsSync';
import { TelegramConfig } from './components/TelegramConfig';
import { ServerDeployPanel } from './components/ServerDeployPanel';
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

type ActiveSection = 'simulator' | 'mql5' | 'android' | 'telegram' | 'sheets' | 'deploy';

const NAV_ITEMS: Array<{ id: ActiveSection; label: string }> = [
  { id: 'simulator', label: 'จำลองกราฟ' },
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
      symbol: 'XAUUSD',
      timeframe: mql5Config.lockM5 ? 'M5' : 'Current',
      signal: isBuy ? 'BUY' : 'SELL',
      aoPrev: isBuy ? -0.1842 : 0.2145,
      aoCurr: isBuy ? 0.1425 : -0.163,
      price: isBuy ? 2644.8 : 2641.2,
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
      {/* Top Bar Contract: 3 zones separated by gap-8 */}
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
            className="hidden md:flex items-center gap-6 text-sm font-medium"
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

      {/* Main Workspace */}
      <main id="top" className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 lg:px-8">
        {/* Clean Minimal Title */}
        <div className="mb-7">
          <h1 className="text-xl font-bold tracking-tight text-slate-900 sm:text-2xl text-balance">
            แจ้งเตือน AO ตัดเส้น 0 ({mql5Config.lockM5 ? 'M5' : 'Chart'}) เข้ามือถือ Android
          </h1>
          <p className="mt-1 text-xs text-slate-500">
            MetaTrader 5 · BUY / SELL · เสียงแจ้งเตือน 10 วินาที · Google Sheets
          </p>
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
          />
        )}

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

        {activeSection === 'deploy' && <ServerDeployPanel />}
      </main>

      {/* Quiet Clean Footer */}
      <footer className="border-t border-slate-200/80 bg-white py-4">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 text-xs text-slate-400 sm:px-6 lg:px-8">
          <span>AO Signal Studio</span>
          <span>US100 · US30 · US500 · XAUUSD · BTCUSD (M5)</span>
        </div>
      </footer>
      <OfflineIndicator />
    </div>
  );
}
