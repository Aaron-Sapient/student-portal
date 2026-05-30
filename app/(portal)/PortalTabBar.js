'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Home,
  ClipboardCheck,
  CalendarDays,
  ListTodo,
  MessageSquare,
} from 'lucide-react';
import { usePortalData } from './PortalDataContext';
import { hasBookingAvailable, hasCheckinDue } from './portalUtils';

const TABS = [
  { href: '/home', label: 'Home', Icon: Home },
  { href: '/check-ins', label: 'Check-Ins', Icon: ClipboardCheck, alert: 'checkin' },
  { href: '/book', label: 'Book', Icon: CalendarDays, alert: 'book' },
  { href: '/deadlines', label: 'Deadlines', Icon: ListTodo },
  { href: '/message', label: 'Message', Icon: MessageSquare },
];

function isActive(pathname, href) {
  return pathname === href || pathname.startsWith(href + '/');
}

export default function PortalTabBar() {
  const pathname = usePathname() || '';
  const { data } = usePortalData();

  const alerts = {
    checkin: hasCheckinDue(data),
    book: hasBookingAvailable(data),
  };

  return (
    <>
      {/* ── Desktop: top horizontal nav ───────────────────────────────── */}
      <header className="relative z-20 hidden md:block">
        <div className="mx-auto flex w-full max-w-2xl items-center justify-between px-7 pt-7">
          <Link href="/home" className="group flex items-baseline gap-2">
            <span className="font-display text-lg font-semibold tracking-tight text-ink">
              Admissions
              <span className="text-terracotta">.Partners</span>
            </span>
          </Link>
          <nav className="flex items-center gap-1 rounded-full border border-sand bg-cream/70 p-1 shadow-card backdrop-blur">
            {TABS.map(({ href, label, Icon, alert }) => {
              const active = isActive(pathname, href);
              const showDot = !active && alert && alerts[alert];
              return (
                <Link
                  key={href}
                  href={href}
                  className={`relative flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${
                    active
                      ? 'bg-terracotta text-cream shadow-sm'
                      : 'text-ink-soft hover:text-ink'
                  }`}
                >
                  <Icon className="h-4 w-4" strokeWidth={2} />
                  {label}
                  {showDot && (
                    <span className="absolute right-1.5 top-1 h-1.5 w-1.5 rounded-full bg-terracotta ring-2 ring-cream" />
                  )}
                </Link>
              );
            })}
          </nav>
        </div>
      </header>

      {/* ── Mobile: fixed bottom tab bar ──────────────────────────────── */}
      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-sand bg-cream/90 backdrop-blur-md md:hidden">
        <div
          className="mx-auto flex max-w-md items-stretch justify-around px-2 pt-1.5"
          style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}
        >
          {TABS.map(({ href, label, Icon, alert }) => {
            const active = isActive(pathname, href);
            const showDot = !active && alert && alerts[alert];
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? 'page' : undefined}
                className="group relative flex flex-1 flex-col items-center gap-1 py-1.5"
              >
                <span
                  className={`relative flex h-9 w-12 items-center justify-center rounded-full transition-all duration-200 ${
                    active ? 'bg-clay-50 text-terracotta' : 'text-ink-faint'
                  }`}
                >
                  <Icon className="h-[22px] w-[22px]" strokeWidth={active ? 2.4 : 2} />
                  {showDot && (
                    <span className="absolute right-2 top-1 h-2 w-2 rounded-full bg-terracotta ring-2 ring-cream" />
                  )}
                </span>
                <span
                  className={`text-[11px] font-medium leading-none transition-colors ${
                    active ? 'text-terracotta' : 'text-ink-faint'
                  }`}
                >
                  {label}
                </span>
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}
