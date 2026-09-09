'use client';

import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { FilmGrid } from '../_browse/FilmGrid';
import { GOLD_STEPS } from './plots';
import type { CountryFilms } from '../_browse/types';

/**
 * The map, once it can be clicked and moved around.
 *
 * Everything expensive happened on the server: this receives finished path
 * strings and two counts each. What it adds is the thing a choropleth is
 * otherwise bad at -- a shade tells you Poland is thin and then refuses to say
 * which four films you have seen from it, which is the only follow-up question
 * anyone actually has -- plus enough zoom to read the parts of the world that
 * are four pixels wide at this size.
 *
 * Three rules keep the linework even, because the previous version drew each
 * country's own outline and the result was a mess of double-struck borders:
 *
 * - Fills carry a hairline of their own colour and nothing else. That covers
 *   the antialiasing seam where two neighbours meet without drawing a line.
 * - Every border is one stroke from one mesh path, laid over the fills. A
 *   coastline and an inland border are then the same weight, which they were
 *   not when each shape stroked itself.
 * - Hover and selection are a single overlay path drawn last, so an outline is
 *   never half-painted over by whichever neighbour rendered after it.
 *
 * Selection is local state and the films arrive by fetch, so the page around it
 * never re-renders. A country with no data on either side is not a control: it
 * is still drawn, still hoverable, and simply has nothing behind it.
 */

export interface Shape {
  id: string;
  name: string;
  d: string;
  watched: number;
  pool: number;
  /** Alpha-2 codes that folded into this outline. Empty means nothing to open. */
  codes: string[];
}

const films = (count: number): string => `${count} ${count === 1 ? 'film' : 'films'}`;

const MIN_SCALE = 1;
const MAX_SCALE = 12;
/** Filled steps above "none". GOLD_STEPS[0] is the empty surface. */
const STEPS = GOLD_STEPS.length - 1;
/** Past this much movement a press is a drag, and its click is not a choice. */
const DRAG_SLOP = 3;

interface View {
  k: number;
  x: number;
  y: number;
}

const HOME: View = { k: 1, x: 0, y: 0 };

/**
 * Keeps the frame full of map.
 *
 * translate-then-scale means x and y are in the viewBox's own units, so the
 * drawn world spans [x, x + kW] and the window onto it is [0, W]. Panning is
 * only allowed while that window stays inside it, which is why nothing can be
 * dragged off into empty space and why panning does nothing at all at 1x.
 */
const clamp = (view: View, width: number, height: number): View => {
  const k = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.k));
  return {
    k,
    x: Math.min(0, Math.max(width * (1 - k), view.x)),
    y: Math.min(0, Math.max(height * (1 - k), view.y)),
  };
};

/** Scales about a point, which is the whole trick: that point does not move. */
const scaleAbout = (view: View, k: number, focusX: number, focusY: number): View => ({
  k,
  x: focusX - (focusX - view.x) * (k / view.k),
  y: focusY - (focusY - view.y) * (k / view.k),
});

export function WorldMapClient({
  shapes,
  borders,
  coastline,
  width,
  height,
  max,
  drawn,
  unmatched,
}: {
  shapes: Shape[];
  borders: string;
  coastline: string;
  width: number;
  height: number;
  max: number;
  drawn: number;
  unmatched: string[];
}) {
  const [selected, setSelected] = useState<Shape | null>(null);
  const [hovered, setHovered] = useState<Shape | null>(null);
  const [view, setView] = useState<View>(HOME);
  const [panning, setPanning] = useState(false);
  const [data, setData] = useState<CountryFilms | null>(null);
  const [side, setSide] = useState<'watched' | 'pool'>('watched');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const panel = useRef<HTMLDivElement>(null);
  const frame = useRef<SVGSVGElement>(null);
  /** Live pointers on the map: one is a pan, two are a pinch. */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ view: View; x: number; y: number; distance: number } | null>(null);
  const dragged = useRef(false);

  useEffect(() => {
    if (!selected) return;

    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setData(null);
    // Open on the side that has something on it. Clicking a country you have
    // never watched anything from should show what the pool holds, not an
    // empty grid you then have to click past.
    setSide(selected.watched > 0 ? 'watched' : 'pool');

    fetch(
      `/api/country?codes=${selected.codes.join(',')}&name=${encodeURIComponent(selected.name)}`,
      { signal: controller.signal },
    )
      .then((response) => (response.ok ? (response.json() as Promise<CountryFilms>) : null))
      .then((result) => {
        if (result) setData(result);
        else setError('Could not read that country.');
        setLoading(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setError('Could not read that country.');
          setLoading(false);
        }
      });

    panel.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return () => controller.abort();
  }, [selected]);

  // A pointer released anywhere ends the gesture, including outside the map.
  // Without this a drag that finishes off the edge leaves the map stuck to the
  // cursor, which reads as the page being broken rather than as a missed event.
  useEffect(() => {
    const stop = (): void => {
      pointers.current.clear();
      gesture.current = null;
      setPanning(false);
    };
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, []);

  // Wheel is a native listener because React's is passive, and a passive
  // listener cannot preventDefault -- the page would scroll under the zoom.
  //
  // Plain wheel is left alone so the map never swallows a scroll on the way
  // past it. Ctrl/Cmd is the browser's own zoom gesture, and a trackpad pinch
  // arrives as exactly that, so pinching on a laptop zooms the map for free.
  useEffect(() => {
    const node = frame.current;
    if (!node) return;

    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const box = node.getBoundingClientRect();
      if (box.width === 0) return;
      const focusX = ((event.clientX - box.left) / box.width) * width;
      const focusY = ((event.clientY - box.top) / box.height) * height;
      setView((current) =>
        clamp(
          scaleAbout(
            current,
            Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.k * Math.exp(-event.deltaY * 0.0025))),
            focusX,
            focusY,
          ),
          width,
          height,
        ),
      );
    };

    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [width, height]);

  /** Client pixels to the map's own units. One ratio: the svg keeps its aspect. */
  const toLocal = (clientX: number, clientY: number): { x: number; y: number } => {
    const box = frame.current?.getBoundingClientRect();
    if (!box || box.width === 0) return { x: width / 2, y: height / 2 };
    return {
      x: ((clientX - box.left) / box.width) * width,
      y: ((clientY - box.top) / box.height) * height,
    };
  };

  const zoomBy = (factor: number, focus?: { x: number; y: number }): void => {
    const point = focus ?? { x: width / 2, y: height / 2 };
    setView((current) =>
      clamp(
        scaleAbout(
          current,
          Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.k * factor)),
          point.x,
          point.y,
        ),
        width,
        height,
      ),
    );
  };

  const centre = (): { x: number; y: number; distance: number } => {
    const points = [...pointers.current.values()];
    const x = points.reduce((sum, p) => sum + p.x, 0) / Math.max(1, points.length);
    const y = points.reduce((sum, p) => sum + p.y, 0) / Math.max(1, points.length);
    const [first, second] = points;
    const distance = first && second ? Math.hypot(first.x - second.x, first.y - second.y) : 0;
    return { x, y, distance };
  };

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>): void => {
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    dragged.current = false;
    gesture.current = { view, ...centre() };
    if (pointers.current.size === 1 && view.k > MIN_SCALE) setPanning(true);
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    const start = gesture.current;
    const box = frame.current?.getBoundingClientRect();
    if (!start || !box || box.width === 0) return;

    const now = centre();
    const dx = ((now.x - start.x) / box.width) * width;
    const dy = ((now.y - start.y) / box.height) * height;
    if (Math.abs(now.x - start.x) > DRAG_SLOP || Math.abs(now.y - start.y) > DRAG_SLOP) {
      dragged.current = true;
    }

    if (now.distance > 0 && start.distance > 0) {
      const k = Math.min(
        MAX_SCALE,
        Math.max(MIN_SCALE, start.view.k * (now.distance / start.distance)),
      );
      const focusX = ((now.x - box.left) / box.width) * width;
      const focusY = ((now.y - box.top) / box.height) * height;
      dragged.current = true;
      setView(clamp(scaleAbout(start.view, k, focusX, focusY), width, height));
      return;
    }

    setView(clamp({ k: start.view.k, x: start.view.x + dx, y: start.view.y + dy }, width, height));
  };

  const onPointerEnd = (event: ReactPointerEvent<SVGSVGElement>): void => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size === 0) {
      gesture.current = null;
      setPanning(false);
      return;
    }
    // A finger lifted out of a pinch leaves the other one panning, so the
    // gesture is re-based rather than carrying the pinch's stale centre.
    gesture.current = { view, ...centre() };
  };

  const onKeyDown = (event: ReactKeyboardEvent<SVGSVGElement>): void => {
    const nudge: Record<string, [number, number]> = {
      ArrowLeft: [40, 0],
      ArrowRight: [-40, 0],
      ArrowUp: [0, 40],
      ArrowDown: [0, -40],
    };
    const move = nudge[event.key];
    if (move) {
      event.preventDefault();
      setView((current) =>
        clamp({ k: current.k, x: current.x + move[0], y: current.y + move[1] }, width, height),
      );
      return;
    }
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      zoomBy(1.6);
    } else if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      zoomBy(1 / 1.6);
    } else if (event.key === '0') {
      event.preventDefault();
      setView(HOME);
    }
  };

  const toggle = (shape: Shape): void =>
    setSelected((current) => (current?.id === shape.id ? null : shape));

  // Log scale, because the United States would otherwise flatten everything
  // else into the same shade of nothing. Discrete steps rather than a
  // continuous mix, so the legend below is the scale itself rather than an
  // approximation of it.
  const stepOf = (count: number): number => {
    if (count <= 0) return 0;
    const intensity = Math.log10(1 + count) / Math.log10(1 + max);
    return Math.min(STEPS, Math.max(1, Math.ceil(intensity * STEPS)));
  };

  /** The smallest count that reaches a step. Inverts stepOf, for the legend. */
  const floorOf = (step: number): number =>
    Math.max(1, Math.ceil(Math.pow(1 + max, (step - 1) / STEPS) - 1));

  const reading = hovered ?? selected;
  const shown = data ? (side === 'watched' ? data.watched : data.pool) : [];
  const total = data ? (side === 'watched' ? data.watchedTotal : data.poolTotal) : 0;
  const zoomed = view.k > MIN_SCALE;

  const control =
    'rounded border border-edge bg-panel/90 px-2 py-1 text-xs leading-none text-muted transition hover:border-accent hover:text-accent disabled:cursor-default disabled:opacity-30 disabled:hover:border-edge disabled:hover:text-muted';

  return (
    <figure>
      <div className="relative">
        <svg
          ref={frame}
          viewBox={`0 0 ${width} ${height}`}
          className="h-auto w-full select-none"
          role="group"
          aria-label="World map of countries by films watched. Select a country to list its films."
          // pan-y so a finger dragging up the page still scrolls it; the map
          // takes horizontal drags and anything with two fingers on it.
          style={{
            touchAction: 'pan-y',
            cursor: zoomed ? (panning ? 'grabbing' : 'grab') : 'default',
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onPointerLeave={() => setHovered(null)}
          onDoubleClick={(event) =>
            zoomBy(
              event.altKey || event.shiftKey ? 1 / 1.9 : 1.9,
              toLocal(event.clientX, event.clientY),
            )
          }
          onKeyDown={onKeyDown}
        >
          <g
            transform={`translate(${view.x.toFixed(2)},${view.y.toFixed(2)}) scale(${view.k.toFixed(4)})`}
          >
            {shapes.map((shape) => {
              const live = shape.codes.length > 0;
              const fill = GOLD_STEPS[stepOf(shape.watched)];
              return (
                <path
                  key={shape.id}
                  d={shape.d}
                  fill={fill}
                  // Its own colour, hairline: covers the seam where two fills
                  // meet without putting a line there.
                  stroke={fill}
                  strokeWidth={0.5}
                  vectorEffect="non-scaling-stroke"
                  className={live ? 'cursor-pointer' : undefined}
                  role={live ? 'button' : undefined}
                  tabIndex={live ? 0 : undefined}
                  aria-label={live ? `${shape.name}, ${films(shape.watched)} watched` : undefined}
                  onPointerEnter={() => setHovered(shape)}
                  onFocus={() => setHovered(shape)}
                  onClick={
                    live
                      ? (event) => {
                          // A drag that ends on a country is a pan, not a choice,
                          // and the second click of a double-click is a zoom --
                          // without that guard it would undo the first one's
                          // selection and leave the panel closed.
                          if (dragged.current || event.detail > 1) return;
                          toggle(shape);
                        }
                      : undefined
                  }
                  onKeyDown={
                    live
                      ? (event) => {
                          if (event.key !== 'Enter' && event.key !== ' ') return;
                          event.preventDefault();
                          toggle(shape);
                        }
                      : undefined
                  }
                >
                  <title>
                    {`${shape.name}: ${films(shape.watched)} watched${
                      shape.pool > 0 ? `, ${shape.pool} in pool` : ''
                    }`}
                  </title>
                </path>
              );
            })}

            {/* Every border once, at one weight, over the fills. */}
            <path
              d={borders}
              fill="none"
              stroke="var(--color-ink)"
              strokeWidth={0.7}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
            <path
              d={coastline}
              fill="none"
              stroke="var(--color-edge)"
              strokeWidth={0.9}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />

            {/* Last, so an outline is whole rather than partly overpainted. */}
            {hovered && hovered.id !== selected?.id ? (
              <path
                d={hovered.d}
                fill="none"
                stroke="var(--color-accent)"
                strokeWidth={1.3}
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                pointerEvents="none"
              />
            ) : null}
            {selected ? (
              <path
                d={selected.d}
                fill="none"
                stroke="var(--color-paper)"
                strokeWidth={1.6}
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                pointerEvents="none"
              />
            ) : null}
          </g>
        </svg>

        <div className="absolute top-2 right-2 flex flex-col gap-1">
          <button
            type="button"
            onClick={() => zoomBy(1.6)}
            disabled={view.k >= MAX_SCALE}
            aria-label="Zoom in"
            className={control}
          >
            +
          </button>
          <button
            type="button"
            onClick={() => zoomBy(1 / 1.6)}
            disabled={!zoomed}
            aria-label="Zoom out"
            className={control}
          >
            &minus;
          </button>
          <button
            type="button"
            onClick={() => setView(HOME)}
            disabled={!zoomed}
            aria-label="Reset the map"
            className={control}
          >
            &#8635;
          </button>
        </div>
      </div>

      <figcaption className="mt-3 space-y-1.5 text-xs text-muted">
        {/* The scale, as the scale: the same six steps the fills come from. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <span className="flex items-center gap-1.5">
            <span>none</span>
            <span aria-hidden className="flex">
              {GOLD_STEPS.map((color, index) => (
                <span
                  key={color}
                  className="h-2.5 w-6 border-y border-r border-edge first:rounded-l-xs first:border-l last:rounded-r-xs"
                  style={{ background: color }}
                  title={index === 0 ? 'none' : `${floorOf(index)}+ films`}
                />
              ))}
            </span>
            <span>{max.toLocaleString()}</span>
          </span>
          <span>{drawn} countries with something on them</span>
        </div>

        {/* One line, always present, so nothing below it moves on hover. */}
        <p className="min-h-4">
          {reading ? (
            <span className="text-paper">
              {reading.name}
              <span className="text-muted">
                {' '}
                &mdash; {films(reading.watched)} watched
                {reading.pool > 0 ? `, ${reading.pool} in the pool` : ''}
                {reading.codes.length === 0 ? ' · nothing in the data reaches it' : ''}
              </span>
            </span>
          ) : (
            <>Click a country for its films. Ctrl/&#8984; + scroll or pinch to zoom, drag to pan.</>
          )}
        </p>

        {unmatched.length > 0 ? <p>Not drawable: {unmatched.join(', ')}</p> : null}
      </figcaption>

      {selected ? (
        <div ref={panel} className="mt-4 rounded-lg border border-edge bg-ink/40 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h4 className="text-sm font-medium">{data?.name ?? selected.name}</h4>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="text-xs text-muted hover:text-paper"
            >
              close
            </button>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {(
              [
                ['watched', `Seen · ${data?.watchedTotal ?? selected.watched}`],
                ['pool', `In pool · ${data?.poolTotal ?? selected.pool}`],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setSide(key)}
                className={`rounded border px-3 py-1 text-xs transition ${
                  side === key
                    ? 'border-accent text-accent'
                    : 'border-edge text-muted hover:text-paper'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="mt-4">
            {loading ? (
              <p className="py-6 text-xs text-muted">Reading {selected.name}…</p>
            ) : error ? (
              <p className="py-6 text-xs text-under">{error}</p>
            ) : (
              <>
                <FilmGrid
                  films={shown}
                  empty={
                    side === 'watched'
                      ? `Nothing watched from ${data?.name ?? selected.name} yet. That is the point of the panel.`
                      : `No candidates from ${data?.name ?? selected.name} in the pool, so the engine cannot offer you one.`
                  }
                />
                {shown.length > 0 ? (
                  <p className="mt-3 text-xs text-muted">
                    {shown.length < total
                      ? `First ${shown.length} of ${total}, `
                      : `All ${total}, `}
                    {side === 'watched' ? 'best rated first.' : 'most voted first.'}
                  </p>
                ) : null}
              </>
            )}
          </div>
        </div>
      ) : null}
    </figure>
  );
}
