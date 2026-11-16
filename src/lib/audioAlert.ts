export type AlertToneKind = 'general' | 'buy' | 'sell';

const SAMPLE_RATE = 22050;
const DURATION_SECONDS = 10;

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * Generates a 10-second 16-bit PCM WAV buffer with clear, pleasant trading chimes.
 */
export function build10SecondWavBlob(kind: AlertToneKind = 'general'): Blob {
  const numSamples = SAMPLE_RATE * DURATION_SECONDS;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  // RIFF / WAVE header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, numSamples * 2, true);

  // Pattern: 10 cycles of 1.0s each (total 10.0 seconds)
  const notes =
    kind === 'buy'
      ? [659.25, 830.61, 987.77] // E5 -> G#5 -> B5 (ascending)
      : kind === 'sell'
      ? [880.0, 698.46, 587.33] // A5 -> F5 -> D5 (descending)
      : [783.99, 1046.5, 783.99]; // G5 -> C6 -> G5 (crisp chime)

  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    const cycleT = t % 1.0; // 1 second per repeat, 10 repeats = 10s
    let sample = 0;

    // 3 quick chimes in the first 0.54s of every 1-second cycle
    if (cycleT < 0.54) {
      const noteIdx = Math.min(2, Math.floor(cycleT / 0.18));
      const localT = cycleT - noteIdx * 0.18;
      const freq = notes[noteIdx];

      // Smooth attack/decay envelope per note
      const attack = Math.min(1, localT / 0.015);
      const decay = Math.exp(-localT * 10);
      const env = attack * decay;

      sample =
        (0.65 * Math.sin(2 * Math.PI * freq * t) +
          0.25 * Math.sin(2 * Math.PI * freq * 2 * t)) *
        env *
        0.55;
    }

    // Gentle fade-out on the last 0.15s
    if (t > DURATION_SECONDS - 0.15) {
      sample *= Math.max(0, (DURATION_SECONDS - t) / 0.15);
    }

    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(44 + i * 2, Math.round(clamped * 32767), true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

export function download10SecondWav(kind: AlertToneKind = 'general'): void {
  const blob = build10SecondWavBlob(kind);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download =
    kind === 'buy'
      ? 'ao_buy_alert_10s.wav'
      : kind === 'sell'
      ? 'ao_sell_alert_10s.wav'
      : 'ao_alert_10s.wav';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

let sharedAudioEl: HTMLAudioElement | null = null;
let activeAudioUrl: string | null = null;
let activeOnEnded: (() => void) | undefined;

function getSharedAudioEl(): HTMLAudioElement | null {
  if (typeof Audio === 'undefined') return null;
  if (!sharedAudioEl) {
    sharedAudioEl = new Audio();
  }
  return sharedAudioEl;
}

export function unlockAlertAudio(): void {
  const el = getSharedAudioEl();
  if (!el) return;
  try {
    // 10ms silent PCM WAV to unlock media playback on user gesture
    const buf = new ArrayBuffer(44 + 440);
    const v = new DataView(buf);
    writeString(v, 0, 'RIFF');
    v.setUint32(4, 36 + 440, true);
    writeString(v, 8, 'WAVE');
    writeString(v, 12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, SAMPLE_RATE, true);
    v.setUint32(28, SAMPLE_RATE * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    writeString(v, 36, 'data');
    v.setUint32(40, 440, true);
    const url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
    el.src = url;
    void el.play()
      .then(() => {
        el.pause();
        URL.revokeObjectURL(url);
      })
      .catch(() => {
        URL.revokeObjectURL(url);
      });
  } catch {
    // Ignore audio unlock errors
  }
}

export function stop10SecondSound(): void {
  activeOnEnded = undefined;
  if (sharedAudioEl) {
    sharedAudioEl.onended = null;
    sharedAudioEl.pause();
    sharedAudioEl.currentTime = 0;
  }
  if (activeAudioUrl) {
    URL.revokeObjectURL(activeAudioUrl);
    activeAudioUrl = null;
  }
}

export function play10SecondSound(
  kind: AlertToneKind = 'general',
  onEnded?: () => void
): () => void {
  stop10SecondSound();
  const audio = getSharedAudioEl();
  if (!audio) {
    onEnded?.();
    return stop10SecondSound;
  }

  const blob = build10SecondWavBlob(kind);
  const url = URL.createObjectURL(blob);
  activeAudioUrl = url;
  activeOnEnded = onEnded;
  audio.src = url;

  audio.onended = () => {
    const cb = activeOnEnded;
    stop10SecondSound();
    cb?.();
  };

  audio.play().catch(() => {
    const cb = activeOnEnded;
    stop10SecondSound();
    cb?.();
  });

  return stop10SecondSound;
}
