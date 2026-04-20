import { auth } from '@clerk/nextjs/server';
import { google } from 'googleapis';
import { DateTime } from 'luxon';

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID_RYAN;
const VALID_DAYS = [2, 3, 4, 5];

function getServiceAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
  });
}

// Logic 1: Use durationMinutes as the increment
function generateSlots(dateStr, durationMinutes) {
  const slots = [];
  const zone = 'America/Los_Angeles';
  const dayObj = DateTime.fromISO(dateStr, { zone });
  const weekday = dayObj.weekday;

  let startHour, endHour;
  if (weekday >= 2 && weekday <= 4) { startHour = 16; endHour = 20; }
  else if (weekday === 5) { startHour = 16; endHour = 19; }
  else { return []; }

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
    // Increment by the meeting duration (15m or 30m)
    startPointer = startPointer.plus({ minutes: durationMinutes });
  }
  return slots;
}

// Logic 2: Scoring for Recommendations
function scoreSlots(availableSlots, busyWindows) {
  return availableSlots.map(slot => {
    const slotStart = DateTime.fromISO(slot.start);
    const slotEnd = DateTime.fromISO(slot.end);
    let score = 0;

    // 2a. Top Priority: Back-to-back (Score: 100)
    const isBackToBack = busyWindows.some(busy => 
      slotStart.equals(busy.end) || slotEnd.equals(busy.start)
    );
    if (isBackToBack) score += 100;

    // 2b. Second Priority: Day Density
    score += busyWindows.length;

    return { ...slot, score };
  });
}

// ONLY ONE GET FUNCTION ALLOWED
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

  const requestedDate = DateTime.fromISO(dateStr, { zone: 'America/Los_Angeles' });
  const now = DateTime.now().setZone('America/Los_Angeles');
  const earliestAllowed = now.plus({ days: 1 });

  try {
    const authClient = getServiceAuth();
    const calendar = google.calendar({ version: 'v3', auth: authClient });

    const dayStart = requestedDate.startOf('day').toISO();
    const dayEnd = requestedDate.endOf('day').toISO();

    const eventsRes = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: dayStart,
      timeMax: dayEnd,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const busyWindows = (eventsRes.data.items || [])
      .filter(e => e.status !== 'cancelled')
      .map(e => ({
        start: DateTime.fromISO(e.start.dateTime || e.start.date),
        end: DateTime.fromISO(e.end.dateTime || e.end.date),
      }));

    const candidates = generateSlots(dateStr, duration);
    const available = candidates.filter(slot => {
      const slotStart = DateTime.fromISO(slot.start);
      const slotEnd = DateTime.fromISO(slot.end);
      if (slotStart < earliestAllowed) return false;
      return !busyWindows.some(busy => slotStart < busy.end && slotEnd > busy.start);
    });

    const scored = scoreSlots(available, busyWindows);
    const recommendations = [...scored]
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    return Response.json({ 
      slots: available, 
      recommendations: recommendations 
    });

  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}