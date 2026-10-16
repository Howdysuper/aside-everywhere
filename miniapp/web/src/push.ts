/**
 * Web Push plumbing for the installed app.
 *
 * iOS only allows notifications for apps installed to the home screen, and
 * only when the whole permission-and-subscribe chain starts inside a real
 * user gesture. That constraint sets the shape here:
 *
 *   enablePush()      called directly from the "Turn on reminders" button
 *                     handler: ask, subscribe, tell the server, in one
 *                     uninterrupted chain
 *   resubscribe()     the silent counterpart for later launches: permission
 *                     already granted, so no prompt exists to violate;
 *                     repairs a subscription the server lost (a wiped
 *                     state dir) or the browser rotated
 *
 * Nothing else. Formatting and judgement live on the server (nextpush.ts);
 * the service worker owns display; this file only makes the phone
 * reachable and keeps it that way.
 */
import { api } from './api';

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

function applicationServerKey(base64: string): BufferSource {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

/** Ask, subscribe, and register with the server. Must run in a user gesture. */
export async function enablePush(): Promise<'granted' | 'denied' | 'unsupported' | 'failed'> {
  if (!pushSupported()) return 'unsupported';
  try {
    // The permission prompt is the gesture-sensitive step on iOS; it goes
    // first so a refusal costs nothing and leaves no half-state behind.
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return 'denied';
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const { publicKey } = await api.pushKey();
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(publicKey),
      });
    }
    await api.pushSubscribe(sub.toJSON());
    return 'granted';
  } catch {
    return 'failed';
  }
}

/**
 * Re-arm push on a later launch without any prompt. Fire-and-forget by
 * design: a failure here means the server was briefly unreachable, and the
 * next launch tries again anyway.
 */
export async function resubscribe(): Promise<void> {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  try {
    let sub = await currentSubscription();
    if (!sub) {
      const reg = await navigator.serviceWorker.ready;
      const { publicKey } = await api.pushKey();
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(publicKey),
      });
    }
    await api.pushSubscribe(sub.toJSON());
  } catch {
    // Silent by design (see the header). The banner flow exists for when
    // this needs eyes.
  }
}
