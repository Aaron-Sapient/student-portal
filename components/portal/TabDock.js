'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import GlassSurface from '@/components/GlassSurface/GlassSurface';

// The floating glass-lens bottom dock, extracted from the student portal's tab
// bar so every portal (student, parent, developer) can drive it with its own
// tab list. Props: tabs = [{ href, label, sym, showDot }] — `sym` is a Material
// Symbols Rounded glyph name (the subsetted font is loaded by the layout).

// A single Material Symbol. The FILL axis (0→1) cleanly swaps outline↔solid; wght
// bumps slightly when active.
export function MIcon({ name, size, active }) {
  return (
    <span
      className="material-symbols-rounded leading-none transition-colors duration-200"
      style={{
        fontSize: size,
        fontVariationSettings: `'opsz' ${size}, 'wght' ${active ? 600 : 350}, 'GRAD' 0, 'FILL' ${
          active ? 1 : 0
        }`,
      }}
    >
      {name}
    </span>
  );
}

export function isActive(pathname, href) {
  return pathname === href || pathname.startsWith(href + '/');
}

export default function TabDock({ tabs }) {
  const pathname = usePathname() || '';

  const navRef = useRef(null);
  const tabRefs = useRef({});

  // The active tab's geometry, measured from the DOM. The glass lens is absolutely
  // positioned and slid (translateX) onto these coords, so it floats *over* the bar
  // and animates to whichever tab is current.
  const [lens, setLens] = useState(null);
  // The active tab the lens last settled on. Lets us tell a real tab change
  // (animate the lens gliding over) from a first placement or a reflow (snap).
  const prevHrefRef = useRef(null);
  const activeHref = tabs.find((t) => isActive(pathname, t.href))?.href;

  useLayoutEffect(() => {
    const nav = navRef.current;
    const el = activeHref ? tabRefs.current[activeHref] : null;
    if (!nav || !el) {
      setLens(null);
      prevHrefRef.current = null;
      return;
    }
    const measure = () => {
      const nr = nav.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      // Inset a hair so the lens reads as a pill seated inside the dock.
      const pad = 4;
      // Glide only when navigating between tabs. On first placement (fresh open
      // straight into a tab) and on geometry reflow (resize, or the seniors-only
      // Colleges tab popping in and shifting everything right) we snap, so the
      // lens never streaks across the dock on load.
      const animate = prevHrefRef.current != null && prevHrefRef.current !== activeHref;
      setLens({
        left: er.left - nr.left + pad,
        top: er.top - nr.top + pad,
        width: Math.max(0, er.width - pad * 2),
        height: Math.max(0, er.height - pad * 2),
        animate,
      });
      prevHrefRef.current = activeHref;
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(nav);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
    // tabs.length: adding/removing a gated tab (e.g. Colleges) reflows every tab
    // without resizing the nav, so the ResizeObserver alone wouldn't re-measure.
  }, [activeHref, tabs.length]);

  // iOS Safari's bottom URL bar overlays the layout viewport, clipping a
  // `bottom: 0` dock. Lift the dock by however much the visual viewport is
  // obscured at the bottom so it always clears the browser chrome.
  const [bottomOffset, setBottomOffset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const obscured = window.innerHeight - vv.height - vv.offsetTop;
      // Ignore large offsets (on-screen keyboard) — only correct for browser chrome.
      setBottomOffset(obscured > 0 && obscured < 160 ? obscured : 0);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  return (
    <div
      className="pointer-events-none fixed inset-x-0 z-30"
      style={{
        bottom: bottomOffset,
        paddingBottom: 'max(0.625rem, env(safe-area-inset-bottom))',
        // Keep the dock clear of the notch when landscape puts it on a side.
        paddingLeft: 'max(1rem, env(safe-area-inset-left))',
        paddingRight: 'max(1rem, env(safe-area-inset-right))',
      }}
    >
      {/* Solid-ish frosted dock — the lens refracts this surface (and the page
          scrolling behind it). */}
      <div className="portal-dock pointer-events-auto relative mx-auto max-w-md">
        {/* The travelling glass lens, laid over the dock and slid to the active tab.
            pointer-events-none so taps fall through to the links beneath. */}
        {lens && (
          <div
            className="pointer-events-none absolute left-0 top-0 z-[1]"
            style={{
              width: lens.width,
              height: lens.height,
              transform: `translate3d(${lens.left}px, ${lens.top}px, 0)`,
              transition: lens.animate
                ? 'transform 460ms cubic-bezier(0.34, 1.32, 0.5, 1), width 320ms ease, height 320ms ease'
                : 'none',
            }}
          >
            <GlassSurface
              width="100%"
              height="100%"
              borderRadius={Math.round(lens.height / 2)}
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

        <nav ref={navRef} className="relative z-[2] flex w-full items-stretch gap-1 p-1.5">
          {tabs.map(({ href, label, sym, showDot }) => {
            const active = isActive(pathname, href);
            return (
              <Link
                key={href}
                ref={(el) => {
                  tabRefs.current[href] = el;
                }}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={`group relative flex flex-1 flex-col items-center justify-center gap-1 rounded-full py-2.5 transition-transform duration-200 ${
                  active ? 'text-terracotta-deep' : 'text-ink-faint active:scale-[0.94]'
                }`}
              >
                <span className="relative flex items-center justify-center">
                  <MIcon name={sym} size={23} active={active} />
                  {showDot && !active && (
                    <span className="absolute -right-1.5 -top-1 h-2 w-2 rounded-full bg-terracotta ring-2 ring-cream" />
                  )}
                </span>
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
