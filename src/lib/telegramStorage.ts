export interface SavedTelegramConfig {
  telegramBotToken: string;
  telegramChatId: string;
  telegramMode: 'fallback' | 'always';
}

const STORAGE_KEY = 'ao_telegram_backup_v1';

export function loadSavedTelegramConfig(): SavedTelegramConfig | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedTelegramConfig>;
    const token = typeof parsed.telegramBotToken === 'string' ? parsed.telegramBotToken.trim() : '';
    const chatId = typeof parsed.telegramChatId === 'string' ? parsed.telegramChatId.trim() : '';
    if (!token || !chatId) return null;
    return {
      telegramBotToken: token,
      telegramChatId: chatId,
      telegramMode: parsed.telegramMode === 'fallback' ? 'fallback' : 'always',
    };
  } catch {
    return null;
  }
}

export function saveTelegramConfigLocally(cfg: SavedTelegramConfig): void {
  try {
    if (!cfg.telegramBotToken.trim() || !cfg.telegramChatId.trim()) return;
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        telegramBotToken: cfg.telegramBotToken.trim(),
        telegramChatId: cfg.telegramChatId.trim(),
        telegramMode: cfg.telegramMode,
      })
    );
  } catch {
    // Ignore storage quota or private mode errors
  }
}

export function clearSavedTelegramConfig(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore
  }
}
