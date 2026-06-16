import { google } from 'googleapis'
import { flagQuotaError } from '@/lib/quotaAlert'

function getAuthClient() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets.readonly',
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/drive.readonly',
    ],
  })
}

// Google meters its per-user rate quotas (Sheets: 60 reads/min) by the
// authenticated principal — so every service-account call in the app shares
// ONE bucket. Passing quotaUser re-keys that quota per end user, giving each
// signed-in student/parent their own 60/min. Verified empirically against the
// live API (scripts/testQuotaUser.cjs): 90 reads split across two quotaUser
// values cleared with zero 429s where a shared bucket throttles at 60.
// Google caps the string at 40 chars; emails are normalized and truncated.
function quotaUserKey(id) {
  const key = String(id ?? '').trim().toLowerCase().slice(0, 40)
  return key || undefined
}

// Wrap the read methods so a 429 pings the quota alert (lib/quotaAlert.js)
// before propagating. This client is readonly-scoped, so reads are all it has.
function instrumentSheets(sheets) {
  for (const [obj, name, label] of [
    [sheets.spreadsheets, 'get', 'spreadsheets.get'],
    [sheets.spreadsheets.values, 'get', 'values.get'],
    [sheets.spreadsheets.values, 'batchGet', 'values.batchGet'],
  ]) {
    const orig = obj[name].bind(obj)
    obj[name] = async (...args) => {
      try {
        return await orig(...args)
      } catch (err) {
        if (err?.code === 429 || err?.response?.status === 429) {
          flagQuotaError(err, label)
        }
        throw err
      }
    }
  }
  return sheets
}

export function getGoogleSheetsClient(quotaUser) {
  const key = quotaUserKey(quotaUser)
  return instrumentSheets(
    google.sheets({
      version: 'v4',
      auth: getAuthClient(),
      ...(key ? { params: { quotaUser: key } } : {}),
    })
  )
}

export function getGoogleCalendarClient(quotaUser) {
  const key = quotaUserKey(quotaUser)
  return google.calendar({
    version: 'v3',
    auth: getAuthClient(),
    ...(key ? { params: { quotaUser: key } } : {}),
  })
}

export function getGoogleDriveClient(quotaUser) {
  const key = quotaUserKey(quotaUser)
  return google.drive({
    version: 'v3',
    auth: getAuthClient(),
    ...(key ? { params: { quotaUser: key } } : {}),
  })
}
