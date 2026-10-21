'use client';

import { useEffect, useState } from 'react';
import type { LogoItem } from '@/lib/partners/logos';

// Steps one tile at a time and holds on each, rather than a continuous
// marquee. The track repeats the list so the loop is seamless: once the index
// has advanced a full list length, it snaps back to the identical position
// with the transition off.
const TILE_PX = 168; // must match the tile's w-[168px]
const HOLD_MS = 1800;
const SLIDE_MS = 600;
const VISIBLE_MAX = 10; // tiles a wide viewport can show at once

function Tile({ item, mono, hidden }: { item: LogoItem; mono: boolean; hidden: boolean }) {
  const mark = item.logo ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={item.logo}
      alt=""
      width={40}
      height={40}
      loading="lazy"
      decoding="async"
      className={`h-10 w-10 object-contain ${mono ? 'brightness-0 invert opacity-80' : 'rounded-xl'}`}
    />
  ) : (
    <span className="h-10 w-10 rounded-xl bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center text-white font-bold">
      {item.name.charAt(0).toUpperCase()}
    </span>
  );
  const body = (
    <>
      {mark}
      <span className="text-sm text-gray-400 group-hover:text-white transition-colors truncate max-w-full">
        {item.name}
      </span>
    </>
  );
  const cls = 'group w-[168px] shrink-0 px-2 flex flex-col items-center gap-2';
  return item.url ? (
    <a
      href={item.url}
      target="_blank"
      rel="noopener"
      title={item.title || item.url.replace('https://', '')}
      aria-hidden={hidden || undefined}
      tabIndex={hidden ? -1 : undefined}
      className={cls}
    >
      {body}
    </a>
  ) : (
    <div title={item.title} aria-hidden={hidden || undefined} className={cls}>
      {body}
    </div>
  );
}

export function LogoCarousel({
  items,
  label,
  reverse = false,
  mono = false,
}: {
  items: LogoItem[];
  label: string;
  reverse?: boolean;
  mono?: boolean;
}) {
  const n = items.length;
  const copies = Math.ceil((n + VISIBLE_MAX) / n) + 1;
  const [index, setIndex] = useState(reverse ? n : 0);
  const [animate, setAnimate] = useState(true);
  const [paused, setPaused] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onMotion = () => setReduced(mq.matches);
    const onVisibility = () => setHidden(document.hidden);
    onMotion();
    mq.addEventListener('change', onMotion);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      mq.removeEventListener('change', onMotion);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  useEffect(() => {
    if (paused || hidden || reduced) return;
    const timer = setInterval(() => {
      setAnimate(true);
      setIndex((i) => (reverse ? i - 1 : i + 1));
    }, HOLD_MS + SLIDE_MS);
    return () => clearInterval(timer);
  }, [paused, hidden, reduced, reverse]);

  const wrap = () => {
    if (index >= n) {
      setAnimate(false);
      setIndex(index - n);
    } else if (index <= 0 && reverse) {
      setAnimate(false);
      setIndex(index + n);
    }
  };

  if (reduced) {
    return (
      <div role="list" aria-label={label} className="flex overflow-x-auto pb-2">
        {items.map((item) => (
          <div role="listitem" key={item.name}>
            <Tile item={item} mono={mono} hidden={false} />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div
      role="region"
      aria-label={label}
      className="overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_8%,black_92%,transparent)]"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <div
        className="flex w-max"
        style={{
          transform: `translateX(-${index * TILE_PX}px)`,
          transition: animate ? `transform ${SLIDE_MS}ms cubic-bezier(0.65, 0, 0.35, 1)` : 'none',
        }}
        onTransitionEnd={wrap}
      >
        {Array.from({ length: copies }, (_, c) =>
          items.map((item) => (
            <Tile key={`${c}-${item.name}`} item={item} mono={mono} hidden={c > 0} />
          ))
        )}
      </div>
    </div>
  );
}
