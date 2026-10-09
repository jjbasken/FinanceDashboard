import { useEffect, useRef, useState, useSyncExternalStore } from "react";

/** Whether a CSS media query currently matches, updating when it changes. */
export function useMediaQuery(query: string) {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
  );
}

/** The layout breakpoint the stylesheet uses for phones. */
export const PHONE_QUERY = "(max-width: 1000px)";

/** A wide sidebar must not force a desktop register into a narrow content area. */
export function useContentWidth() {
  const ref = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}
