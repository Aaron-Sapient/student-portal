'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import GlassSurface from '@/components/GlassSurface/GlassSurface';
import TabDock, { MIcon, isActive } from '@/components/portal/TabDock';

// One tab list drives both navs: a fixed left rail on desktop, the standard
// glass dock on phones. Rail lens mechanics mirror components/portal/TabDock
// (the measured-lens pattern from the student portal), travelling vertically.
const DEV_TABS = [
  { href: '/developer/reports', label: 'Reports', sym: 'description' },
  { href: '/developer/meetings', label: 'Meetings', sym: 'calendar_month' },
  { href: '/developer/compliance', label: 'Compliance', sym: 'fact_check' },
  { href: '/developer/blocks', label: 'Blocks', sym: 'event_busy' },
  { href: '/developer/scoring', label: 'Scoring', sym: 'tune' },
  { href: '/developer/students', label: 'Students', sym: 'group' },
];

function DesktopRail({ tabs }) {
  const pathname = usePathname() || '';
  const navRef = useRef(null);
  const tabRefs = useRef({});
  const [lens, setLens] = useState(null);
  const activeHref = tabs.find((t) => isActive(pathname, t.href))?.href;

  useLayoutEffect(() => {
    const nav = navRef.current;
    const el = activeHref ? tabRefs.current[activeHref] : null;
    if (!nav || !el) {
      setLens(null);
      return;
    }
    const measure = () => {
      const nr = nav.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      const pad = 4;
      setLens({
        left: er.left - nr.left + pad,
        top: er.top - nr.top + pad,
        width: Math.max(0, er.width - pad * 2),
        height: Math.max(0, er.height - pad * 2),
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(nav);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [activeHref]);

  return (
    <div className="pointer-events-none fixed left-4 top-1/2 z-30 hidden -translate-y-1/2 md:block">
      <div className="portal-dock pointer-events-auto relative w-[88px]">
        {lens && (
          <div
            className="pointer-events-none absolute left-0 top-0 z-[1]"
            style={{
              width: lens.width,
              height: lens.height,
              transform: `translate3d(${lens.left}px, ${lens.top}px, 0)`,
              transition:
                'transform 460ms cubic-bezier(0.34, 1.32, 0.5, 1), height 320ms ease',
            }}
          >
            <GlassSurface
              width="100%"
              height="100%"
              borderRadius={22}
              backgroundOpacity={0.16}
              saturation={1.9}
              brightness={64}
              opacity={0.92}
              blur={12}
              displace={0.5}
              distortionScale={-150}
              redOffset={0}
              greenOffset={9}
              blueOffset={18}
              mixBlendMode="screen"
              className="h-full w-full"
            />
          </div>
        )}

        <nav ref={navRef} className="relative z-[2] flex w-full flex-col items-stretch gap-1 p-1.5">
          {tabs.map(({ href, label, sym }) => {
            const active = isActive(pathname, href);
            return (
              <Link
                key={href}
                ref={(el) => {
                  tabRefs.current[href] = el;
                }}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={`group relative flex flex-col items-center justify-center gap-1 rounded-3xl py-3.5 transition-transform duration-200 ${
                  active ? 'text-terracotta-deep' : 'text-ink-faint active:scale-[0.94]'
                }`}
              >
                <MIcon name={sym} size={24} active={active} />
                <span
                  className={`text-[10px] font-semibold leading-none tracking-[0.02em] transition-colors duration-200 ${
                    active ? 'text-terracotta-deep' : 'text-ink-faint'
                  }`}
                >
                  {label}
                </span>
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}

export default function DevNav({ tabs = DEV_TABS }) {
  return (
    <>
      <DesktopRail tabs={tabs} />
      {/* Phone: the standard bottom glass dock. */}
      <div className="md:hidden">
        <TabDock tabs={tabs} />
      </div>
    </>
  );
}
