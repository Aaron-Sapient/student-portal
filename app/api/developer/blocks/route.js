import { requireDeveloper } from '@/lib/developerAuth';
import { listBlocks, addBlock, deleteBlock } from '@/lib/blocks';

// Blocks live in Supabase `instructor_blocks` and this route is their only writer — the
// Sheets mirror was retired 2026-08-09. Google APIs are deliberately absent here now.

// The `instructor` Postgres enum also accepts 'art', but blocks are only meaningful for
// the two instructors who take bookings. Before the cutover the mirror script silently
// skipped anything that wasn't aaron/ryan, so an 'art' row could never take effect; a bare
// enum check would have quietly WIDENED that (getAvailableSlots treats an art block as
// applying to Aaron too). Keeping the old behavior explicit, as a 400 rather than a skip.
const ALLOWED_INSTRUCTORS = ['aaron', 'ryan'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET() {
  const gate = await requireDeveloper();
  if (!gate.ok) return gate.response;

  try {
    const blocks = await listBlocks();
    return Response.json({ blocks });
  } catch (err) {
    console.error('blocks GET error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}

export async function POST(request) {
  const gate = await requireDeveloper();
  if (!gate.ok) return gate.response;

  try {
    const { instructor, startDate, endDate, reason, startTime, endTime } = await request.json();
    if (!instructor || !startDate) {
      return Response.json({ error: 'Missing instructor or startDate' }, { status: 400 });
    }
    if (!ALLOWED_INSTRUCTORS.includes(String(instructor).toLowerCase())) {
      return Response.json({ error: `Instructor must be one of: ${ALLOWED_INSTRUCTORS.join(', ')}` }, { status: 400 });
    }
    // Validate shape here rather than letting Postgres reject it — a driver-level date
    // error surfaces to the admin as an opaque 500.
    if (!DATE_RE.test(startDate) || (endDate && !DATE_RE.test(endDate))) {
      return Response.json({ error: 'Dates must be YYYY-MM-DD' }, { status: 400 });
    }
    if (endDate && endDate < startDate) {
      return Response.json({ error: 'End date must be on or after the start date' }, { status: 400 });
    }
    if ((startTime && !endTime) || (!startTime && endTime)) {
      return Response.json({ error: 'A time block needs both a start and end time' }, { status: 400 });
    }
    if (startTime && endTime && endTime <= startTime) {
      return Response.json({ error: 'End time must be after start time' }, { status: 400 });
    }
    const id = await addBlock({
      instructor: String(instructor).toLowerCase(),
      startDate,
      endDate,
      reason,
      startTime,
      endTime,
    });
    return Response.json({ success: true, id });
  } catch (err) {
    console.error('blocks POST error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}

export async function DELETE(request) {
  const gate = await requireDeveloper();
  if (!gate.ok) return gate.response;

  try {
    const { id } = await request.json();
    if (!id || !UUID_RE.test(String(id))) {
      return Response.json({ error: 'Invalid block id' }, { status: 400 });
    }
    const removed = await deleteBlock(id);
    if (!removed) {
      // Nothing matched: this tab is showing a block that no longer exists. Reporting
      // success would refresh the list and leave the row apparently still there.
      return Response.json({ error: 'That block no longer exists — refresh the list.' }, { status: 404 });
    }
    return Response.json({ success: true });
  } catch (err) {
    console.error('blocks DELETE error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}
