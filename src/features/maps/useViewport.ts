import { useCallback, useEffect, useRef, useState } from 'react';
import { fitCamera, panBy, screenToMap, zoomAt, type Camera, type Point } from '@shared/geometry/transform';

/** Pan/zoom camera for a DOM element, driven by the shared transform module. */
export function useViewport(mapW: number, mapH: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, zoom: 1 });
  const [size, setSize] = useState({ w: 0, h: 0 });

  const fit = useCallback(() => {
    const el = ref.current;
    if (!el || !mapW) return;
    setCamera(fitCamera(mapW, mapH, el.clientWidth, el.clientHeight));
  }, [mapW, mapH]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    fit();
  }, [fit]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      if (e.ctrlKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) setCamera((c) => zoomAt(c, anchor, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))));
      else setCamera((c) => panBy(c, -e.deltaX, -e.deltaY));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const toMap = useCallback(
    (clientX: number, clientY: number): Point => {
      const rect = ref.current!.getBoundingClientRect();
      return screenToMap({ x: clientX - rect.left, y: clientY - rect.top }, camera);
    },
    [camera],
  );

  return { ref, camera, setCamera, size, fit, toMap, pan: (dx: number, dy: number) => setCamera((c) => panBy(c, dx, dy)) };
}
