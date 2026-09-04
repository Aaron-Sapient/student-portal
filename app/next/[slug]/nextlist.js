import { Globe, ListTodo, BadgeCheck, CalendarDays, FileText, MessageCircle } from 'lucide-react';

/* "What happens in that conversation": the running order of the meeting.
   ─────────────────────────────────────────────────────────────────────────
   The section used to be four paragraphs of body copy. Three of them were
   stages of one thirty-minute call and the fourth was a closing reassurance,
   and nothing on screen said which was which, so a parent skimming got a wall
   where the page had a shape to give them.

   A row decides its own form from its DATA, which is what keeps a lead file
   readable and keeps this component out of the page's way:

     { icon, lead, body }   a stage in the meeting, in the list
     "a plain sentence"     a paragraph after the list
     { body }               the same, written long-hand

   So a lead row that still carries four plain strings renders exactly the four
   paragraphs it rendered before this file existed. Nothing to migrate, and no
   lead can be broken by a page change it never asked for.

   Icons are Lucide, vendored on the 24px / 2px grid, and are IDEOGRAPHS: the
   globe is the portal the family reaches from Singapore, the checklist is the
   two or three options, the badge is the choice being made. Deliberately no
   raised tile and no connector arrow, which is the vocabulary the strip under
   the greeting uses for a sequence of consequences. This is an agenda. */

const ICONS = {
  globe: Globe,
  'list-todo': ListTodo,
  'badge-check': BadgeCheck,
  'calendar-days': CalendarDays,
  'file-text': FileText,
  'message-circle': MessageCircle,
};

export default function NextList({ lines }) {
  const rows = (lines || []).map((l) => (typeof l === 'string' ? { body: l } : l || {}));
  const staged = rows.filter((r) => r.lead);
  const after = rows.filter((r) => !r.lead);

  return (
    <>
      {staged.length > 0 && (
        <ol className="nextlist">
          {staged.map((r, i) => {
            const Icon = ICONS[r.icon] || null;
            return (
              <li key={r.lead} className="nextlist-item">
                <span className="nextlist-icon">
                  {Icon ? (
                    <Icon size={24} strokeWidth={1.75} aria-hidden="true" />
                  ) : (
                    /* No glyph named: the number keeps the column occupied so
                       the leads stay on one left edge across the whole list. */
                    <span className="font-display text-[1.05rem] font-semibold">{i + 1}</span>
                  )}
                </span>
                <span className="nextlist-lead">{r.lead}</span>
                {r.body && <span className="nextlist-body">{r.body}</span>}
              </li>
            );
          })}
        </ol>
      )}
      {after.map((r) => (
        <p key={r.body} className="nextlist-after">
          {r.body}
        </p>
      ))}
    </>
  );
}
