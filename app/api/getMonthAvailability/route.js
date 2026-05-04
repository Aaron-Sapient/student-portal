import { auth } from '@clerk/nextjs/server';
import { google } from 'googleapis';
import { DateTime } from 'luxon';
import { getInstructor } from '@/lib/instructors';
import { listBlocks, isDateBlocked } from '@/lib/blocks';

function getServiceAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: [
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/spreadsheets.readonly',
    ],
  });
}

export async function GET(request) {
  const { sessionClaims } = await auth();
  if (!sessionClaims?.email) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  // `month` is 0-indexed to match JS Date / the booking page's calMonth state.
  const monthParam = parseInt(searchParams.get('month'));
  const yearParam = parseInt(searchParams.get('year'));
  const duration = parseInt(searchParams.get('duration') || '30');
  const instructor = getInstructor(searchParams.get('instructor'));

  if (Number.isNaN(monthParam) || Number.isNaN(yearParam)) {
    return Response.json({ error: 'Missing month or year' }, { status: 400 });
  }

  const zone = 'America/Los_Angeles';
  const monthStart = DateTime.fromObject(
    { year: yearParam, month: monthParam + 1, day: 1 },
    { zone }
  );
  const monthEnd = monthStart.endOf('month');

  const now = DateTime.now().setZone(zone);
  const earliestAllowed = now.plus({ days: 1 });

  try {
    const authClient = getServiceAuth();
    const calendar = google.calendar({ version: 'v3', auth: authClient });
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    // Mirror getAvailableSlots: an Aaron block also blocks ART since they share a calendar.
    const blockSlugs = instructor.slug === 'art' ? ['art', 'aaron'] : [instructor.slug];

    const [eventsRes, blocks] = await Promise.all([
      calendar.events.list({
        calendarId: instructor.calendarId,
        timeMin: monthStart.startOf('day').toISO(),
        timeMax: monthEnd.endOf('day').toISO(),
        singleEvents: true,
        orderBy: 'startTime',
      }),
      listBlocks(sheets).catch(() => []),
    ]);

    const busyWindows = (eventsRes.data.items || [])
      .filter(e => e.status !== 'cancelled')
      .map(e => ({
        start: DateTime.fromISO(e.start.dateTime || e.start.date),
        end: DateTime.fromISO(e.end.dateTime || e.end.date),
      }));

    const availableDates = [];
    let cursor = monthStart;
    while (cursor <= monthEnd) {
      const dateStr = cursor.toFormat('yyyy-LL-dd');
      const hours = instructor.hoursByWeekday[cursor.weekday];

      if (
        hours &&
        cursor.endOf('day') >= earliestAllowed &&
        !blockSlugs.some(slug => isDateBlocked(blocks, slug, dateStr))
      ) {
        let pointer = cursor.set({ hour: hours.start, minute: 0, second: 0, millisecond: 0 });
        const limit = cursor.set({ hour: hours.end, minute: 0, second: 0, millisecond: 0 });

        while (pointer < limit) {
          const slotEnd = pointer.plus({ minutes: duration });
          if (slotEnd > limit) break;
          if (pointer >= earliestAllowed) {
            const conflict = busyWindows.some(b => pointer < b.end && slotEnd > b.start);
            if (!conflict) {
              availableDates.push(dateStr);
              break;
            }
          }
          pointer = pointer.plus({ minutes: duration });
        }
      }

      cursor = cursor.plus({ days: 1 });
    }

    return Response.json({ availableDates });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
