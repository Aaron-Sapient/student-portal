import { google } from 'googleapis'

function getAuthClient() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets.readonly',
      'https://www.googleapis.com/auth/calendar',
    ],
  })
}

export function getGoogleSheetsClient() {
  return google.sheets({ version: 'v4', auth: getAuthClient() })
}

export function getGoogleCalendarClient() {
  return google.calendar({ version: 'v3', auth: getAuthClient() })
}