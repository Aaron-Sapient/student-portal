import { DateTime } from 'luxon';
import { getSupabaseClient } from '@/lib/supabase';

// Instructor availability blocks — dates (and optional time windows) when Aaron or Ryan
// can't take student bookings.
//
// SOURCE OF TRUTH: Supabase `instructor_blocks`, owned outright by this app. Until
// 2026-08-09 the Master Sheet's `InstructorBlocks` tab was authoritative and a 10-minute
// NAS cron mirrored it here; that mirror is retired and the tab is frozen. Schema and the
// reasoning behind the shape live in supabase/instructor_blocks.sql.
//
// SHAPE: one row per BLOCK, stored as an inclusive date RANGE (block_date → end_date), so
// a row corresponds 1:1 with something an admin actually created and `id` is a safe delete
// key. The predicates below were always range-native — they were written against the
// Sheets range shape and never needed changing.

const ZONE = 'America/Los_Angeles';

// Postgres `time` reads back as 'HH:MM:SS'; trim to 'HH:mm'. NULL becomes '' rather than
// staying null because every consumer gates on `b.startTime && b.endTime` to distinguish
// a partial-time block from a full-day one — '' and null are both falsy, but keeping one
// consistent empty value means a `.split(':')` downstream can never see a null.
function hhmm(t) {
  return t ? String(t).slice(0, 5) : '';
}

function rowToBlock(row) {
  return {
    id: row.id,
    instructor: row.instructor || '',
    startDate: row.block_date,
    endDate: row.end_date || row.block_date,
    reason: row.reason || '',
    createdAt: row.created_at || '',
    startTime: hhmm(row.start_time),
    endTime: hhmm(row.end_time),
  };
}

// Reads every block. THROWS on failure — callers decide what a read failure means.
// Ordered explicitly: Postgres guarantees no row order without ORDER BY, and the admin
// list would otherwise reshuffle between page loads.
export async function listBlocks() {
  const sb = getSupabaseClient();
  const { data, error } = await sb
    .from('instructor_blocks')
    .select('id, instructor, block_date, end_date, start_time, end_time, reason, created_at')
    .order('block_date', { ascending: true })
    .order('instructor', { ascending: true })
    .order('start_time', { ascending: true, nullsFirst: true });
  if (error) throw new Error(`instructor_blocks query failed: ${error.message}`);
  return (data || []).map(rowToBlock);
}

// Booking-path read. FAILS OPEN (returns []) so a Supabase problem can never take booking
// offline — a deliberate call: blocked hours are a small slice of the week, so the cost of
// a missed block is one "sorry, we need to reschedule" email, while the cost of failing
// closed is hours of dark booking that nobody notices until a student complains.
//
// But it fails LOUDLY. The previous `.catch(() => [])` at each call site discarded the
// error entirely, which meant an outage left no trace anywhere — establishing that this
// had never actually happened required going and reading seven weeks of NAS cron logs.
export async function listBlocksForBooking() {
  try {
    return await listBlocks();
  } catch (err) {
    console.error(
      `[blocks] READ FAILED — booking is proceeding with NO instructor blocks applied, ` +
        `so blocked times are currently bookable: ${err?.message || err}`
    );
    return [];
  }
}

export async function addBlock({ instructor, startDate, endDate, reason, startTime, endTime }) {
  const sb = getSupabaseClient();
  // A time window needs both ends; otherwise it's a full-day block. Coerce '' → null:
  // the admin UI sends '' for a full-day block, and '' is not valid input for a Postgres
  // `time` column (it errors rather than reading as "no value").
  const hasWindow = Boolean(startTime && endTime);
  const { data, error } = await sb
    .from('instructor_blocks')
    .insert({
      instructor,
      block_date: startDate,
      end_date: endDate || startDate,
      start_time: hasWindow ? startTime : null,
      end_time: hasWindow ? endTime : null,
      reason: (reason || '').trim() || null,
    })
    .select('id')
    .single();
  if (error) throw new Error(`instructor_blocks insert failed: ${error.message}`);
  return data.id;
}

// Returns true if a row was actually removed. False means the id didn't match anything —
// usually a stale admin tab deleting a block someone already removed. The caller turns
// that into a 404 rather than reporting a success that deleted nothing.
export async function deleteBlock(id) {
  const sb = getSupabaseClient();
  const { data, error } = await sb.from('instructor_blocks').delete().eq('id', id).select('id');
  if (error) throw new Error(`instructor_blocks delete failed: ${error.message}`);
  return (data || []).length > 0;
}

// A date counts as fully blocked only by a full-day block (no time window). A
// partial-time block doesn't make the whole day unavailable — its window is merged
// into busy windows via blockedWindowsForDate so individual slots get filtered.
export function isDateBlocked(blocks, instructorSlug, dateStr) {
  const target = DateTime.fromISO(dateStr, { zone: ZONE }).startOf('day');
  return blocks.some(b => {
    if (b.instructor.toLowerCase() !== instructorSlug.toLowerCase()) return false;
    if (b.startTime && b.endTime) return false; // partial-time block, not full-day
    const start = DateTime.fromISO(b.startDate, { zone: ZONE }).startOf('day');
    const end = DateTime.fromISO(b.endDate || b.startDate, { zone: ZONE }).startOf('day');
    return target >= start && target <= end;
  });
}

// Returns busy windows ({ start, end } DateTimes) from partial-time blocks whose date
// range covers `dateStr`. The block's time window applies on each day in its range.
export function blockedWindowsForDate(blocks, instructorSlug, dateStr) {
  const target = DateTime.fromISO(dateStr, { zone: ZONE }).startOf('day');
  const windows = [];
  for (const b of blocks) {
    if (b.instructor.toLowerCase() !== instructorSlug.toLowerCase()) continue;
    if (!b.startTime || !b.endTime) continue;
    const start = DateTime.fromISO(b.startDate, { zone: ZONE }).startOf('day');
    const end = DateTime.fromISO(b.endDate || b.startDate, { zone: ZONE }).startOf('day');
    if (target < start || target > end) continue;
    const [sh, sm] = b.startTime.split(':').map(Number);
    const [eh, em] = b.endTime.split(':').map(Number);
    windows.push({
      start: target.set({ hour: sh, minute: sm }),
      end: target.set({ hour: eh, minute: em }),
    });
  }
  return windows;
}
