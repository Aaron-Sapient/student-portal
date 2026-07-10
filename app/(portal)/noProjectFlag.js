'use client';

// Summer-2026 group-project census flag. A student who answered "not on a group
// project" (on the /project-report tab) hides the Projects nav tab for themselves.
// localStorage-only (per-device) — fine for a temporary surface. The custom event
// lets same-tab readers (the dock, Home's safety-net pointer) react the instant
// they opt out; the 'storage' event covers other tabs. Single source of truth for
// the key + event name so the writer and readers can never drift apart.

const KEY = 'portal:noProject';
const EVENT = 'portal:noProjectChange';

// response ∈ 'finalized' | 'not_finalized' | 'no_project' | null. Only an explicit
// 'no_project' hides the tab; every other answer clears the flag so it returns.
export function setNoProjectFlag(response) {
  try {
    if (response === 'no_project') localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
    window.dispatchEvent(new Event(EVENT));
  } catch {}
}

export function subscribeNoProject(cb) {
  window.addEventListener('storage', cb);
  window.addEventListener(EVENT, cb);
  return () => {
    window.removeEventListener('storage', cb);
    window.removeEventListener(EVENT, cb);
  };
}

export function readNoProject() {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function readNoProjectServer() {
  return false;
}
