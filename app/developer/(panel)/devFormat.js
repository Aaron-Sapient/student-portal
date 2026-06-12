import { DateTime } from 'luxon';

export function formatPacific(iso) {
  if (!iso) return '—';
  const dt = DateTime.fromISO(iso).setZone('America/Los_Angeles');
  if (!dt.isValid) return '—';
  return dt.toFormat('ccc LLL d, h:mma');
}

export function formatDateOnly(iso) {
  if (!iso) return '—';
  const dt = DateTime.fromISO(iso).setZone('America/Los_Angeles');
  if (!dt.isValid) return '—';
  return dt.toFormat('LLL d, yyyy');
}

// Build a value compatible with <input type="datetime-local"> from an ISO string.
export function toLocalInputValue(iso) {
  if (!iso) return '';
  const dt = DateTime.fromISO(iso).setZone('America/Los_Angeles');
  return dt.isValid ? dt.toFormat("yyyy-LL-dd'T'HH:mm") : '';
}
