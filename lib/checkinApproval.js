import crypto from 'crypto';

// Signed, tamper-proof tokens for Ryan's emailed meeting-approval links.
// A grant/reject link carries no Clerk session (Ryan acts straight from his
// inbox), so the HMAC signature IS the authorization — only someone holding the
// server secret can mint a valid link. Pattern is JWT-lite: base64url(payload).
// base64url(HMAC-SHA256(payload)).
//
// Secret: a dedicated CHECKIN_APPROVAL_SECRET if set, else CLERK_SECRET_KEY
// (already present in every environment) so this needs no new env wiring.

const TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — generous; approvals land in a day or two
export const APPROVAL_ACTIONS = ['grant15', 'grant30', 'reject'];

function getSecret() {
  const secret = process.env.CHECKIN_APPROVAL_SECRET || process.env.CLERK_SECRET_KEY;
  if (!secret) throw new Error('No approval secret: set CHECKIN_APPROVAL_SECRET or CLERK_SECRET_KEY');
  return secret;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}
function sign(payloadB64) {
  return b64url(crypto.createHmac('sha256', getSecret()).update(payloadB64).digest());
}

// payload: { action, masterRow, checkinRow, studentSheetId, studentName }
export function makeApprovalToken(payload) {
  const body = { ...payload, iat: Date.now() };
  const payloadB64 = b64url(JSON.stringify(body));
  return `${payloadB64}.${sign(payloadB64)}`;
}

// Returns the verified payload, or null if missing/malformed/forged/expired.
export function verifyApprovalToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) return null;

  const expected = sign(payloadB64);
  // Constant-time compare; bail if lengths differ (timingSafeEqual throws otherwise).
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64));
  } catch {
    return null;
  }
  if (!APPROVAL_ACTIONS.includes(payload.action)) return null;
  if (!payload.iat || Date.now() - payload.iat > TOKEN_MAX_AGE_MS) return null;
  return payload;
}

// Maps a grant action to the booking-token string written to Master col AZ.
export function actionToDecision(action) {
  if (action === 'grant15') return '15min';
  if (action === 'grant30') return '30min';
  if (action === 'reject') return 'written';
  return null;
}
