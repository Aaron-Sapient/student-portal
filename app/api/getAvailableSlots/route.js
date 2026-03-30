import { auth } from '@clerk/nextjs/server';
import { google } from 'googleapis';

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID_RYAN;

// Booking window: Tue=2, Wed=3, Thu=4
const VALID_DAYS = [2, 3, 4];
const START_HOUR = 17; // 5pm Pacific
const END_HOUR = 20;   // 8pm Pacific

function getServiceAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
  });
}

// Generate all on-the-hour and half-hour slots between 5pm–8pm for a given date
// durationMinutes: 15 or 30
// Returns array of { start: Date, end: Date, label: string }
function generateSlots(dateStr, durationMinutes) {
  const slots = [];

  // dateStr is "YYYY-MM-DD", interpreted in Pacific Time
  // We'll work in UTC but anchor to Pacific
  // Pacific is UTC-8 (PST) or UTC-7 (PDT) — use a fixed offset approach
  // Safest: build the time as a Pacific local time string and let Date parse it
  const pacificBase = new Date(`${dateStr}T${String(START_HOUR).padStart(2, '0')}:00:00`);

  // Generate slots at 0 and 30 minutes past each hour
  for (let hour = START_HOUR; hour < END_HOUR; hour++) {
    for (const minute of [0, 30]) {
      const start = new Date(`${dateStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`);
      const end = new Date(start.getTime() + durationMinutes * 60 * 1000);

      // Don't add slot if it runs past 8pm
      if (end.getHours() > END_HOUR || (end.getHours() === END_HOUR && end.getMinutes() > 0)) continue;

      const label = start.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone: 'America/Los_Angeles',
      });

      slots.push({ start: start.toISOString(), end: end.toISOString(), label });
    }
  }

  return slots;
}

export async function GET(request) {
  const { sessionClaims } = await auth();
  if (!sessionClaims?.email) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const dateStr = searchParams.get('date'); // "YYYY-MM-DD"
  const duration = parseInt(searchParams.get('duration') || '30'); // 15 or 30

  if (!dateStr) {
    return Response.json({ error: 'Missing date parameter' }, { status: 400 });
  }

  // Validate it's a bookable day (Tue–Thu)
  // Parse date as local to avoid timezone shifting the day
  const [year, month, day] = dateStr.split('-').map(Number);
  const localDate = new Date(year, month - 1, day);
  const dayOfWeek = localDate.getDay();

  if (!VALID_DAYS.includes(dayOfWeek)) {
    return Response.json({ slots: [], reason: 'Not a bookable day' });
  }

  // Enforce 24-hour advance notice
  const now = new Date();
  const earliest = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  try {
    const authClient = getServiceAuth();
    const calendar = google.calendar({ version: 'v3', auth: authClient });

    // Fetch all events on Ryan's calendar for this day
    // Use Pacific midnight to Pacific midnight
    const dayStart = new Date(`${dateStr}T00:00:00`);
    const dayEnd = new Date(`${dateStr}T23:59:59`);

    const eventsRes = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: dayStart.toISOString(),
      timeMax: dayEnd.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = eventsRes.data.items || [];

    // Build list of busy windows from existing events
    const busyWindows = events
      .filter(e => e.status !== 'cancelled')
      .map(e => ({
        start: new Date(e.start.dateTime || e.start.date),
        end: new Date(e.end.dateTime || e.end.date),
      }));

    // Generate candidate slots and filter out conflicts
    const candidates = generateSlots(dateStr, duration);

    const available = candidates.filter(slot => {
      const slotStart = new Date(slot.start);
      const slotEnd = new Date(slot.end);

      // Must be at least 24 hours from now
      if (slotStart < earliest) return false;

      // Must not overlap with any existing event
      const hasConflict = busyWindows.some(busy =>
        slotStart < busy.end && slotEnd > busy.start
      );

      return !hasConflict;
    });

    return Response.json({ slots: available });

  } catch (err) {
    console.error('getAvailableSlots error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}