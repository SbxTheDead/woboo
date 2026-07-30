// The nervous system. Everything Wobo does becomes an event here, and the
// dashboard is just a subscriber. Late subscribers get the recent past replayed
// so a browser opened mid-mission still shows a full picture.

const subscribers = new Set();
const recent = [];
const RECENT_MAX = 300;

export function publish(event) {
  const stamped = { at: Date.now(), ...event };
  recent.push(stamped);
  if (recent.length > RECENT_MAX) recent.shift();
  for (const fn of subscribers) {
    try {
      fn(stamped);
    } catch {
      // A broken subscriber (a closed SSE socket) must never stop the mission.
    }
  }
  return stamped;
}

export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function replay() {
  return recent.slice();
}
