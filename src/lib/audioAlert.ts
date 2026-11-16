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

let activeAudioEl: HTMLAudioElement | null = null;
let activeAudioUrl: string | null = null;

export function stop10SecondSound(): void {
  if (activeAudioEl) {
    activeAudioEl.pause();
    activeAudioEl.currentTime = 0;
    activeAudioEl = null;
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
  const blob = build10SecondWavBlob(kind);
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  activeAudioEl = audio;
  activeAudioUrl = url;

  audio.onended = () => {
    stop10SecondSound();
    onEnded?.();
  };

  audio.play().catch(() => {
    stop10SecondSound();
    onEnded?.();
  });

  return stop10SecondSound;
}
