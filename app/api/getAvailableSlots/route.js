import { auth } from '@clerk/nextjs/server';
import { google } from 'googleapis';
import { DateTime } from 'luxon';

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID_RYAN;

// Booking window: Tue=2, Wed=3, Thu=4
const VALID_DAYS = [2, 3, 4, 5];
const START_HOUR = 16; // 5pm Pacific
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

function generateSlots(dateStr, durationMinutes) {
  const slots = [];
  const zone = 'America/Los_Angeles';

  // 1. Determine the weekday (Mon=1, Tue=2, Wed=3, Thu=4, Fri=5)
  const dayObj = DateTime.fromISO(dateStr, { zone });
  const weekday = dayObj.weekday;

  // 2. Set custom hours based on the day
  let startHour, endHour;
  
  if (weekday >= 2 && weekday <= 4) { // Tue-Thu
    startHour = 16; // 4pm
    endHour = 20;   // 8pm
  } else if (weekday === 5) {        // Fri
    startHour = 16; // 4pm
    endHour = 19;   // 7pm
  } else {
    return []; // Not a bookable day
  }

  // 3. Generate the slots
  let startPointer = dayObj.set({ hour: startHour, minute: 0, second: 0, millisecond: 0 });
  const endLimit = dayObj.set({ hour: endHour, minute: 0 });

  while (startPointer < endLimit) {
    const slotEnd = startPointer.plus({ minutes: durationMinutes });
    if (slotEnd <= endLimit) {
      slots.push({
        start: startPointer.toISO(),
        end: slotEnd.toISO(),
        label: startPointer.toLocaleString(DateTime.TIME_SIMPLE)
      });
    }
    startPointer = startPointer.plus({ minutes: 30 });
  }

  return slots;
}

export async function GET(request) {
  const { sessionClaims } = await auth();
  if (!sessionClaims?.email) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const dateStr = searchParams.get('date'); 
  const duration = parseInt(searchParams.get('duration') || '30'); 

  if (!dateStr) {
    return Response.json({ error: 'Missing date parameter' }, { status: 400 });
  }

  // 1. Validate Day of Week using Luxon (Tue=2, Wed=3, Thu=4)
  const requestedDate = DateTime.fromISO(dateStr, { zone: 'America/Los_Angeles' });
  if (!VALID_DAYS.includes(requestedDate.weekday)) {
    return Response.json({ slots: [], reason: 'Not a bookable day' });
  }

  // 2. Set up our "24-hour notice" wall
  const now = DateTime.now().setZone('America/Los_Angeles');
  const earliestAllowed = now.plus({ days: 1 });

  try {
    const authClient = getServiceAuth();
    const calendar = google.calendar({ version: 'v3', auth: authClient });

    // 3. Fetch Busy Events (STAYING IN THE CODE!)
    const dayStart = requestedDate.startOf('day').toISO();
const dayEnd = requestedDate.endOf('day').toISO();

    const eventsRes = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: dayStart,
      timeMax: dayEnd,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = eventsRes.data.items || [];

    // 4. Convert Google Events to Luxon objects for comparison
    const busyWindows = events
      .filter(e => e.status !== 'cancelled')
      .map(e => ({
        // We use DateTime.fromISO because Google returns ISO strings
        start: DateTime.fromISO(e.start.dateTime || e.start.date),
        end: DateTime.fromISO(e.end.dateTime || e.end.date),
      }));

    // 5. Generate potential slots (The 5pm-8pm Pacific windows)
    const candidates = generateSlots(dateStr, duration);

    // 6. FILTER: This is where we check both "24-hour notice" AND "Double-booking"
    const available = candidates.filter(slot => {
      const slotStart = DateTime.fromISO(slot.start);
      const slotEnd = DateTime.fromISO(slot.end);

      // A. Check 24-hour notice
      if (slotStart < earliestAllowed) return false;

      // B. Check against Google Calendar busy windows (Prevents Double-Booking)
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