let sharedCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctx) return null;
  if (!sharedCtx) {
    sharedCtx = new Ctx();
  }
  if (sharedCtx.state === 'suspended') {
    sharedCtx.resume().catch(() => {});
  }
  return sharedCtx;
}

export function playAlertChime(direction: 'BUY' | 'SELL' | 'TEST' = 'TEST'): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  const now = ctx.currentTime;
  const notes =
    direction === 'BUY'
      ? [659.25, 880.0, 1046.5] // Rising E5 -> A5 -> C6
      : direction === 'SELL'
        ? [880.0, 659.25, 523.25] // Falling A5 -> E5 -> C5
        : [783.99, 1046.5]; // Clean G5 -> C6 test chime

  notes.forEach((freq, idx) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, now + idx * 0.11);

    gain.gain.setValueAtTime(0.0001, now + idx * 0.11);
    gain.gain.exponentialRampToValueAtTime(0.14, now + idx * 0.11 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.11 + 0.28);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now + idx * 0.11);
    osc.stop(now + idx * 0.11 + 0.3);
  });
}
