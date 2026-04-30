import { auth } from '@clerk/nextjs/server';
import { google } from 'googleapis';
import { DateTime } from 'luxon';
import { getInstructor } from '@/lib/instructors';

function getServiceAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
  });
}

function generateSlots(dateStr, durationMinutes, instructor) {
  const slots = [];
  const zone = 'America/Los_Angeles';
  const dayObj = DateTime.fromISO(dateStr, { zone });
  const hours = instructor.hoursByWeekday[dayObj.weekday];
  if (!hours) return [];

  let startPointer = dayObj.set({ hour: hours.start, minute: 0, second: 0, millisecond: 0 });
  const endLimit = dayObj.set({ hour: hours.end, minute: 0, second: 0, millisecond: 0 });

  while (startPointer < endLimit) {
    const slotEnd = startPointer.plus({ minutes: durationMinutes });
    if (slotEnd <= endLimit) {
      slots.push({
        start: startPointer.toISO(),
        end: slotEnd.toISO(),
        label: startPointer.toLocaleString(DateTime.TIME_SIMPLE),
      });
    }
    startPointer = startPointer.plus({ minutes: durationMinutes });
  }
  return slots;
}

function scoreSlots(availableSlots, busyWindows) {
  return availableSlots.map(slot => {
    const slotStart = DateTime.fromISO(slot.start);
    const slotEnd = DateTime.fromISO(slot.end);
    let score = 0;

    const isBackToBack = busyWindows.some(busy =>
      slotStart.equals(busy.end) || slotEnd.equals(busy.start)
    );
    if (isBackToBack) score += 100;

    score += busyWindows.length;

    return { ...slot, score };
  });
}

export async function GET(request) {
  const { sessionClaims } = await auth();
  if (!sessionClaims?.email) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const dateStr = searchParams.get('date');
  const duration = parseInt(searchParams.get('duration') || '30');
  const instructor = getInstructor(searchParams.get('instructor'));

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
      calendarId: instructor.calendarId,
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

    const candidates = generateSlots(dateStr, duration, instructor);
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
      recommendations,
    });

  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
