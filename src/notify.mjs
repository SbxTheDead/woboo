// Desktop notifications. When a mission completes, the owner should know —
// even if the dashboard is in another tab. Uses the Web Notifications API
// in the browser, and the native notification system in Electron.

import { record } from './journal.mjs';

export function notify(title, body) {
  // In Electron, use the native Notification constructor.
  // In the browser, same API but requires permission.
  try {
    if (typeof Notification !== 'undefined') {
      if (Notification.permission === 'granted') {
        new Notification(title, { body, silent: false });
      } else if (Notification.permission === 'default') {
        Notification.requestPermission().then((perm) => {
          if (perm === 'granted') {
            new Notification(title, { body, silent: false });
          }
        });
      }
    }
  } catch {
    // Notifications are best-effort.
  }
  record('notify', title + ': ' + body, { level: 'info' });
}

export function missionDone(mission) {
  if (!mission) return;
  const task = (mission.task || 'Mission').slice(0, 80);
  const state = mission.state === 'done' ? 'Complete' : mission.state === 'failed' ? 'Failed' : 'Finished';
  notify('Woboo: ' + state, task);
}
