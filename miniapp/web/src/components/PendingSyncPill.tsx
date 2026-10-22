/**
 * "N changes waiting" — the visible half of the outbox.
 *
 * The whole point of queueing an action is that the phone still works when
 * the computer is off. But a queue nobody can see is indistinguishable from
 * a queue that ate the action, and after a week of false "it's handled"
 * messages the last thing this app should do is ask for trust again.
 *
 * So: what is waiting is listed, by name, and a tap tries to send it now.
 * It appears only when there is something to say.
 */
import { useEffect, useState } from 'react';
import { onQueueChange, pendingActions, type QueuedAction } from '../offlineQueue';
import { isSyncing, onSyncChange, syncNow } from '../offlineSync';
import { toast } from './Toasts';

export function PendingSyncPill() {
  const [pending, setPending] = useState<QueuedAction[]>([]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const read = (): void => {
      setPending(pendingActions());
      setBusy(isSyncing());
    };
    read();
    const offQueue = onQueueChange(read);
    const offSync = onSyncChange(read);
    return () => {
      offQueue();
      offSync();
    };
  }, []);

  if (pending.length === 0 && !busy) return null;

  const retry = (): void => {
    if (busy) return;
    void syncNow().then((res) => {
      if (!res) return;
      if (res.sent > 0) toast(`Sent ${res.sent} queued change${res.sent === 1 ? '' : 's'}.`, { tone: 'success' });
      if (res.offline) toast('Your computer still is not answering. Everything is kept.', { tone: 'info' });
      if (res.rejected > 0 && res.lastError) toast(res.lastError, { tone: 'error', duration: 6 });
      if (res.remaining > 0 && !res.offline && res.lastError && res.rejected === 0) toast(res.lastError, { tone: 'error', duration: 6 });
    });
  };

  const label = busy
    ? 'Syncing…'
    : `${pending.length} change${pending.length === 1 ? '' : 's'} waiting for your computer`;

  return (
    <div className="pending-sync" data-open={open ? 'true' : 'false'}>
      <button
        type="button"
        className="pending-sync-bar"
        onClick={() => (open ? retry() : setOpen(true))}
        aria-expanded={open}
      >
        <span className="pending-sync-dot" aria-hidden="true" />
        <span className="pending-sync-label">{label}</span>
        <span className="pending-sync-count">{pending.length || ''}</span>
      </button>

      {open && (
        <div className="pending-sync-list" role="status">
          {pending.map((a) => (
            <div className="pending-sync-row" key={a.id}>
              <span className="pending-sync-kind" data-kind={a.kind}>
                {a.kind === 'chat' ? 'message' : a.kind === 'plan' ? 'plan' : 'change'}
              </span>
              <span className="pending-sync-what">{a.label}</span>
            </div>
          ))}
          <button type="button" className="pending-sync-send" onClick={retry} disabled={busy}>
            {busy ? 'Sending…' : 'Send now'}
          </button>
          <p className="pending-sync-note">
            These send automatically the moment your computer is reachable again.
          </p>
        </div>
      )}
    </div>
  );
}
