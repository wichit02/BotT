function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export function isWebPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export async function getExistingPushSubscription(): Promise<PushSubscription | null> {
  if (!isWebPushSupported()) return null;
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

export async function subscribeDeviceToWebPush(): Promise<PushSubscription> {
  if (!isWebPushSupported()) {
    throw new Error('เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือนอัตโนมัติ (แนะนำเปิดผ่าน Chrome บน Android)');
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('กรุณากดอนุญาตการแจ้งเตือน (Allow) เพื่อรับสัญญาณเข้ามือถือ');
  }

  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;

  const keyRes = await fetch('/api/push/vapid-public-key');
  if (!keyRes.ok) {
    throw new Error('ไม่สามารถดึงกุญแจเชื่อมต่อจากเซิร์ฟเวอร์ได้');
  }
  const { publicKey } = (await keyRes.json()) as { publicKey: string };

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const appServerKey = urlBase64ToUint8Array(publicKey);
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: appServerKey.buffer as ArrayBuffer,
    });
  }

  const saveRes = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription: sub.toJSON() }),
  });

  if (!saveRes.ok) {
    throw new Error('บันทึกอุปกรณ์เข้าเซิร์ฟเวอร์ไม่สำเร็จ');
  }

  return sub;
}

export async function unsubscribeDeviceFromWebPush(): Promise<void> {
  if (!isWebPushSupported()) return;
  const reg = await navigator.serviceWorker.getRegistration('/sw.js');
  if (!reg) return;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;

  await fetch('/api/push/unsubscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  }).catch(() => {});

  await sub.unsubscribe();
}

export async function sendTestWebPush(endpoint?: string): Promise<void> {
  const res = await fetch('/api/push/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || 'ส่งแจ้งเตือนทดสอบไม่สำเร็จ');
  }
}
