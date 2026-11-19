import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  CloudUpload,
  ExternalLink,
  Eye,
  EyeOff,
  GitBranch,
  KeyRound,
  Lock,
  Monitor,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Unplug,
  X,
} from 'lucide-react';
import type { GitHubConfigState } from '../types/trading';

interface ServerSyncPanelProps {
  config: GitHubConfigState;
  isUploading: boolean;
  onConfigSynced: (nextConfig: GitHubConfigState) => void;
  onManualUpload: () => Promise<{
    ok: boolean;
    message: string;
    commitUrl?: string;
    fileCount?: number;
    uploadedAt?: string;
  }>;
}

function formatThaiDateTime(iso?: string): string {
  if (!iso) return 'ยังไม่เคยอัปโหลด';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'ยังไม่เคยอัปโหลด';
  const datePart = new Intl.DateTimeFormat('th-TH', {
    timeZone: 'Asia/Bangkok',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(d);
  const timePart = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(d);
  return `${datePart} ${timePart} น.`;
}

export function ServerSyncPanel({
  config,
  isUploading,
  onConfigSynced,
  onManualUpload,
}: ServerSyncPanelProps) {
  const [tokenInput, setTokenInput] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [repoNameInput, setRepoNameInput] = useState(config.repoName);
  const [usernameInput, setUsernameInput] = useState(config.username);
  const [branchInput, setBranchInput] = useState(config.branch || 'main');
  const [isPrivate, setIsPrivate] = useState(config.isPrivate);
  const [autoUploadCode, setAutoUploadCode] = useState(config.autoUploadCode);
  const [autoLogSignals, setAutoLogSignals] = useState(config.autoLogSignals);

  const [isSaving, setIsSaving] = useState(false);
  const [isTogglingPermission, setIsTogglingPermission] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewViewport, setPreviewViewport] = useState<'mobile' | 'desktop'>('mobile');
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(
    null
  );

  useEffect(() => {
    setRepoNameInput(config.repoName);
    setUsernameInput(config.username);
    setBranchInput(config.branch || 'main');
    setIsPrivate(config.isPrivate);
    setAutoUploadCode(config.autoUploadCode);
    setAutoLogSignals(config.autoLogSignals);
  }, [config]);

  useEffect(() => {
    if (!previewOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPreviewOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [previewOpen]);

  const onlinePreviewUrl =
    typeof window !== 'undefined' ? window.location.origin : '/';

  const handleSaveConfig = async () => {
    setIsSaving(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/github/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: tokenInput.trim() || undefined,
          repoName: repoNameInput.trim(),
          username: usernameInput.trim() || undefined,
          branch: branchInput.trim() || 'main',
          isPrivate,
          autoUploadCode,
          autoLogSignals,
        }),
      });
      const data = (await res.json()) as GitHubConfigState & {
        ok?: boolean;
        message?: string;
      };
      if (!res.ok || !data.ok) {
        setFeedback({
          ok: false,
          message: data.message || 'บันทึกการเชื่อมต่อ GitHub ไม่สำเร็จ',
        });
        return;
      }
      setTokenInput('');
      onConfigSynced({
        connected: Boolean(data.connected),
        maskedToken: data.maskedToken || config.maskedToken,
        username: data.username || '',
        repoName: data.repoName || '',
        repo: data.repo || '',
        branch: data.branch || 'main',
        isPrivate: Boolean(data.isPrivate),
        autoUploadCode: Boolean(data.autoUploadCode),
        autoLogSignals: Boolean(data.autoLogSignals),
        uploadAllowed: Boolean(data.uploadAllowed),
        syncedFileCount: data.syncedFileCount,
        lastUploadAt: data.lastUploadAt,
        lastCommitUrl: data.lastCommitUrl,
      });
      setFeedback({
        ok: true,
        message: data.message || 'บันทึกการเชื่อมต่อ GitHub สำเร็จ',
      });
    } catch {
      setFeedback({
        ok: false,
        message: 'ไม่สามารถติดต่อเซิร์ฟเวอร์เพื่อบันทึกการเชื่อมต่อ GitHub ได้',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleUploadPermission = async () => {
    setIsTogglingPermission(true);
    setFeedback(null);
    const nextAllowed = !config.uploadAllowed;
    try {
      const res = await fetch('/api/github/permission', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadAllowed: nextAllowed }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        uploadAllowed?: boolean;
        message?: string;
      };
      if (!res.ok || !data.ok) {
        setFeedback({
          ok: false,
          message: data.message || 'เปลี่ยนสิทธิ์การอัปโหลดไม่สำเร็จ',
        });
        return;
      }
      onConfigSynced({
        ...config,
        uploadAllowed: Boolean(data.uploadAllowed),
      });
    } catch {
      setFeedback({
        ok: false,
        message: 'ไม่สามารถติดต่อเซิร์ฟเวอร์เพื่ออัปเดตสิทธิ์การอัปโหลดได้',
      });
    } finally {
      setIsTogglingPermission(false);
    }
  };

  const handleUploadNow = async () => {
    setFeedback(null);
    if (!config.uploadAllowed) {
      setFeedback({
        ok: false,
        message: 'กรุณากดปุ่ม "อนุญาตอัปโหลดขึ้น GitHub" ก่อนจึงจะสามารถอัปโหลดได้',
      });
      return;
    }
    const result = await onManualUpload();
    setFeedback({ ok: result.ok, message: result.message });
  };

  const handleDisconnect = async () => {
    setIsSaving(true);
    setFeedback(null);
    try {
      await fetch('/api/github/disconnect', { method: 'POST' });
      setTokenInput('');
      setRepoNameInput('');
      setUsernameInput('');
      onConfigSynced({
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
      setFeedback({ ok: true, message: 'ยกเลิกการเชื่อมต่อ GitHub เรียบร้อยแล้ว' });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-3.5">
      <p className="px-0.5 text-xs leading-relaxed text-slate-600">
        ซิงค์โค้ดขึ้น GitHub และดาวน์โหลดแพ็กเกจสำหรับนำไปรันเฝ้ากราฟ 24 ชั่วโมงบน Server
      </p>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5 shadow-xs">
        {/* Card Header */}
        <div className="flex items-start gap-3.5">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[#0f172a] text-white">
            <GitBranch className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1 space-y-1.5">
            <h2 className="text-base font-bold leading-snug text-slate-900">
              เชื่อมต่อ GitHub.com (ควบคุมด้วยปุ่มอนุญาตอัปโหลด)
            </h2>
            <p className="text-xs leading-relaxed text-slate-600">
              เชื่อม Repository ไว้ได้โดยยังไม่ส่งไฟล์อัตโนมัติ — ระบบจะอัปโหลดโค้ดและบันทึกสัญญาณ{' '}
              <span className="font-mono text-[11px] text-slate-800">
                data/signals-log.json
              </span>{' '}
              ก็ต่อเมื่อคุณกดปุ่ม <strong className="text-slate-900">อนุญาตอัปโหลด</strong>{' '}
              แล้วเท่านั้น
            </p>
          </div>
        </div>

        {/* Preview & Status */}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => setPreviewOpen(true)}
            className="inline-flex items-center gap-2 rounded-xl border border-sky-200 bg-sky-50/70 px-4 py-2 text-xs font-semibold text-sky-700 transition-colors hover:bg-sky-100 whitespace-nowrap"
          >
            <Eye className="h-4 w-4 text-sky-600" aria-hidden="true" />
            ดูตัวอย่างหน้าเว็บออนไลน์
          </button>

          {isUploading ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden="true" />
              กำลังอัปโหลด...
            </span>
          ) : config.uploadAllowed ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden="true" />
              อนุญาตอัปโหลดแล้ว
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700">
              <ShieldAlert className="h-4 w-4 text-amber-600" aria-hidden="true" />
              ยังไม่อนุญาตอัปโหลด (เชื่อมต่อได้อย่างเดียว)
            </span>
          )}
        </div>

        <hr className="my-4 border-slate-100" />

        {/* Form Fields */}
        <div className="space-y-3.5">
          <div>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <label
                htmlFor="gh-pat-input"
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-800"
              >
                <KeyRound className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />
                <span>GitHub Personal Access Token (สิทธิ์ repo)</span>
              </label>
              <a
                href="https://github.com/settings/tokens/new?scopes=repo&description=US100-M5-AO"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs font-semibold text-sky-600 hover:text-sky-800 shrink-0 whitespace-nowrap"
              >
                สร้าง Token ด่วน
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            </div>
            <div className="relative">
              <input
                id="gh-pat-input"
                type={showToken ? 'text' : 'password'}
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder={
                  config.maskedToken
                    ? '••••••••••••••••••••••••••••••••••••••••'
                    : 'ghp_xxxxxxxxxxxxxxxxxxxx'
                }
                autoComplete="off"
                className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 pr-10 font-mono text-xs text-slate-900 placeholder:text-slate-500 focus:border-slate-400 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShowToken((prev) => !prev)}
                aria-label={showToken ? 'ซ่อน Token' : 'แสดง Token'}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:text-slate-700"
              >
                {showToken ? (
                  <EyeOff className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Eye className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            </div>
          </div>

          <div>
            <label
              htmlFor="gh-repo-name"
              className="mb-1.5 block text-xs font-semibold text-slate-800"
            >
              ชื่อ Repository (สร้างใหม่ให้อัตโนมัติถ้ายังไม่มี)
            </label>
            <input
              id="gh-repo-name"
              type="text"
              value={repoNameInput}
              onChange={(e) => setRepoNameInput(e.target.value)}
              placeholder="BotT"
              className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 font-mono text-xs text-slate-900 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="gh-username"
              className="mb-1.5 block text-xs font-semibold text-slate-800"
            >
              ชื่อผู้ใช้ GitHub
            </label>
            <input
              id="gh-username"
              type="text"
              value={usernameInput}
              onChange={(e) => setUsernameInput(e.target.value)}
              placeholder="wichit02"
              className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 font-mono text-xs text-slate-900 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="gh-branch"
              className="mb-1.5 block text-xs font-semibold text-slate-800"
            >
              Branch
            </label>
            <input
              id="gh-branch"
              type="text"
              value={branchInput}
              onChange={(e) => setBranchInput(e.target.value)}
              placeholder="main"
              className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 font-mono text-xs text-slate-900 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none"
            />
          </div>
        </div>

        {/* Checkboxes Group */}
        <div className="mt-4 space-y-2.5 rounded-xl border border-slate-200 bg-slate-50/70 p-3.5">
          <label className="flex cursor-pointer items-start gap-2.5 text-xs text-slate-800">
            <input
              type="checkbox"
              checked={isPrivate}
              onChange={(e) => setIsPrivate(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-slate-300 accent-sky-600"
            />
            <span className="inline-flex items-center gap-1.5 leading-relaxed">
              <Lock className="h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden="true" />
              สร้างเป็น Private Repository
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-2.5 text-xs text-slate-800">
            <input
              type="checkbox"
              checked={autoUploadCode}
              onChange={(e) => setAutoUploadCode(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-slate-300 accent-sky-600"
            />
            <span className="leading-relaxed">
              อัปโหลดไฟล์โค้ดทั้งหมดอัตโนมัติแบบเรียลไทม์เมื่อมีการแก้ไข
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-2.5 text-xs text-slate-800">
            <input
              type="checkbox"
              checked={autoLogSignals}
              onChange={(e) => setAutoLogSignals(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-slate-300 accent-sky-600"
            />
            <span className="leading-relaxed">
              บันทึกข้อมูลสัญญาณ M5 ล่าสุด (data/signals-log.json) ขึ้น GitHub อัตโนมัติ
            </span>
          </label>
        </div>

        {/* 4 Action Buttons Stack */}
        <div className="mt-4 flex flex-col items-start gap-2.5">
          <button
            type="button"
            onClick={handleSaveConfig}
            disabled={isSaving || isUploading}
            className="inline-flex items-center gap-2 rounded-xl bg-[#0f172a] px-4 py-2.5 text-xs font-semibold text-white transition-colors hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
          >
            <GitBranch className="h-4 w-4" aria-hidden="true" />
            {isSaving ? 'กำลังบันทึก...' : 'บันทึกการเชื่อมต่อ GitHub'}
          </button>

          <button
            type="button"
            onClick={handleToggleUploadPermission}
            disabled={isTogglingPermission || isUploading}
            className={`inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-semibold transition-colors disabled:opacity-50 whitespace-nowrap ${
              config.uploadAllowed
                ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                : 'border border-emerald-600 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
            }`}
          >
            <ShieldCheck className="h-4 w-4" aria-hidden="true" />
            {config.uploadAllowed
              ? 'อนุญาตอัปโหลดแล้ว (คลิกเพื่อปิด)'
              : 'อนุญาตอัปโหลดขึ้น GitHub'}
          </button>

          <button
            type="button"
            onClick={handleUploadNow}
            disabled={isUploading || isSaving}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs font-semibold text-slate-800 transition-colors hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
          >
            <CloudUpload className="h-4 w-4 text-slate-600" aria-hidden="true" />
            {isUploading ? 'กำลังอัปโหลดขึ้น GitHub...' : 'อัปโหลดขึ้น GitHub ตอนนี้'}
          </button>

          <button
            type="button"
            onClick={handleDisconnect}
            disabled={isSaving || isUploading}
            className="inline-flex items-center gap-2 rounded-xl border border-rose-200 bg-white px-4 py-2.5 text-xs font-semibold text-rose-600 transition-colors hover:bg-rose-50 disabled:opacity-50 whitespace-nowrap"
          >
            <Unplug className="h-4 w-4" aria-hidden="true" />
            ยกเลิกเชื่อมต่อ
          </button>
        </div>

        {/* Inline Action Feedback */}
        {feedback && (
          <div
            className={`mt-3.5 rounded-xl border px-3.5 py-2.5 text-xs leading-relaxed ${
              feedback.ok
                ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                : 'border-rose-200 bg-rose-50 text-rose-900'
            }`}
          >
            {feedback.message}
          </div>
        )}

        {/* Sync Summary & External Links */}
        <div className="mt-4 space-y-2 text-xs text-slate-700">
          <div>
            จำนวนไฟล์ที่ซิงค์:{' '}
            <span className="font-mono font-bold text-slate-900 tabular-nums">
              {config.syncedFileCount ?? 0}
            </span>
          </div>
          <div>
            อัปเดตล่าสุด:{' '}
            <span className="font-mono font-semibold text-slate-900 tabular-nums">
              {formatThaiDateTime(config.lastUploadAt)}
            </span>
          </div>

          {(config.repo || config.lastCommitUrl) && (
            <div className="flex flex-wrap items-center gap-5 pt-1">
              {config.repo && (
                <a
                  href={`https://github.com/${config.repo}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 font-semibold text-sky-600 hover:text-sky-800"
                >
                  เปิดดู Repo
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                </a>
              )}
              {config.lastCommitUrl && (
                <a
                  href={config.lastCommitUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 font-semibold text-sky-600 hover:text-sky-800"
                >
                  Commit ล่าสุด
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                </a>
              )}
            </div>
          )}
        </div>

        {/* Security Note */}
        <p className="mt-4 text-xs leading-relaxed text-slate-600">
          ความปลอดภัย: ระบบตัดไฟล์ลับ (.env, .data/, Bot Token และ GitHub Token)
          ออกก่อนอัปโหลดขึ้น GitHub ทุกครั้งเพื่อไม่ให้รหัสผ่านรั่วไหล
        </p>
      </section>

      {/* Live In-App Online Preview Modal */}
      {previewOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65 p-2 sm:p-5 backdrop-blur-[2px]"
          role="dialog"
          aria-modal="true"
          aria-labelledby="online-preview-title"
          onClick={(e) => {
            if (e.target === e.currentTarget) setPreviewOpen(false);
          }}
        >
          <div className="flex h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
            {/* Modal Top Chrome */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-3.5 py-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <Eye className="h-4 w-4 shrink-0 text-sky-600" aria-hidden="true" />
                <span
                  id="online-preview-title"
                  className="text-xs font-bold text-slate-900 whitespace-nowrap"
                >
                  ตัวอย่างหน้าเว็บออนไลน์
                </span>
                <span className="hidden truncate rounded-lg border border-slate-200 bg-white px-2.5 py-1 font-mono text-[11px] text-slate-600 sm:inline-block max-w-[260px]">
                  {onlinePreviewUrl}
                </span>
              </div>

              <div className="flex items-center gap-1.5">
                <div
                  className="hidden items-center gap-0.5 rounded-lg border border-slate-200 bg-white p-0.5 sm:inline-flex"
                  role="group"
                  aria-label="ขนาดหน้าจอตัวอย่าง"
                >
                  <button
                    type="button"
                    onClick={() => setPreviewViewport('mobile')}
                    className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                      previewViewport === 'mobile'
                        ? 'bg-slate-900 text-white'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    <Smartphone className="h-3.5 w-3.5" aria-hidden="true" />
                    มือถือ
                  </button>
                  <button
                    type="button"
                    onClick={() => setPreviewViewport('desktop')}
                    className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                      previewViewport === 'desktop'
                        ? 'bg-slate-900 text-white'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    <Monitor className="h-3.5 w-3.5" aria-hidden="true" />
                    เต็มจอ
                  </button>
                </div>

                <a
                  href={`${onlinePreviewUrl}/?preview=online`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap"
                >
                  เปิดแท็บใหม่
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </a>

                <button
                  type="button"
                  onClick={() => setPreviewOpen(false)}
                  aria-label="ปิดหน้าต่างตัวอย่าง"
                  className="inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white p-1.5 text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            {/* Live Project Frame */}
            <div className="flex flex-1 items-stretch justify-center overflow-hidden bg-slate-200/70 p-0 sm:p-3">
              <div
                className={`h-full overflow-hidden bg-[#f4f7fb] transition-all ${
                  previewViewport === 'mobile'
                    ? 'w-full max-w-[430px] sm:rounded-2xl sm:border sm:border-slate-300 sm:shadow-lg'
                    : 'w-full sm:rounded-xl sm:border sm:border-slate-300 sm:shadow-md'
                }`}
              >
                <iframe
                  src="/?preview=online"
                  title="ตัวอย่างหน้าเว็บออนไลน์ US100 M5"
                  className="h-full w-full border-0 bg-[#f4f7fb]"
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
