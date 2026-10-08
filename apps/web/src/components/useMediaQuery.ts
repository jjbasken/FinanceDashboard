import { useSyncExternalStore } from "react";

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
export const PHONE_QUERY = "(max-width: 720px)";
