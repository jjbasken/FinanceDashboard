import { type KeyboardEvent, type Ref, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface Option<T> {
  key: string;
  label: string;
  value: T;
  group?: string;
}

/**
 * A keyboard-first combobox. Arrow keys browse, Enter or Tab picks the highlighted option,
 * and leaving the field after typing picks the best match, so fast entry never needs the mouse.
 * Keys it doesn't use (and Enter/Escape when the list is closed) bubble up to the register.
 */
export function Autocomplete<T>(props: {
  /** Label of the current selection. */
  value: string;
  options: Option<T>[];
  onSelect: (value: T, label: string) => void;
  /** Offered when the typed text matches no option exactly, e.g. "Create payee". */
  create?: (text: string) => Option<T> | null;
  /** Called when the text is cleared and the field is left. */
  onClear?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  ariaLabel: string;
}) {
  const [text, setText] = useState(props.value);
  const [typed, setTyped] = useState(false);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [navigated, setNavigated] = useState(false);
  const inputEl = useRef<HTMLInputElement | null>(null);
  const listId = useId();

  useEffect(() => {
    if (!typed) setText(props.value);
  }, [props.value, typed]);

  const shown = useMemo(() => {
    if (!typed) return props.options;
    const q = text.trim().toLowerCase();
    const matches = q ? props.options.filter((o) => o.label.toLowerCase().includes(q)) : props.options;
    // Prefix matches first, keeping the original order otherwise.
    const sorted = [...matches].sort(
      (a, b) => Number(!a.label.toLowerCase().startsWith(q)) - Number(!b.label.toLowerCase().startsWith(q)),
    );
    const exact = props.options.some((o) => o.label.toLowerCase() === q);
    const created = q && !exact ? props.create?.(text.trim()) : null;
    return created ? [...sorted, created] : sorted;
  }, [props.options, props.create, text, typed]);

  // Keep the floating list attached to its field when anything scrolls or the viewport changes. On
  // phones, the keyboard opening scrolls the page or dialog to keep the field in view.
  const [, setLayout] = useState(0);
  useEffect(() => {
    if (!open) return;
    let frame = 0;
    const follow = (e: Event) => {
      if (e.target instanceof Node && document.getElementById(listId)?.contains(e.target)) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setLayout((n) => n + 1));
    };
    const viewport = window.visualViewport;
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    viewport?.addEventListener("resize", follow);
    viewport?.addEventListener("scroll", follow);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
      viewport?.removeEventListener("resize", follow);
      viewport?.removeEventListener("scroll", follow);
    };
  }, [open, listId]);

  function openList() {
    if (props.disabled) return;
    const current = props.options.findIndex((o) => o.label === props.value);
    setHighlight(Math.max(0, current));
    setNavigated(false);
    setOpen(true);
  }

  function choose(option: Option<T> | undefined) {
    setOpen(false);
    setTyped(false);
    setNavigated(false);
    if (!option) {
      setText(props.value);
      return;
    }
    setText(option.label);
    props.onSelect(option.value, option.label);
  }

  /** Settle typed text: empty clears, otherwise take the exact match or the highlighted option. */
  function settle() {
    if (!typed && !navigated) return setOpen(false);
    const q = text.trim().toLowerCase();
    if (typed && q === "") {
      setTyped(false);
      setOpen(false);
      props.onClear?.();
      return;
    }
    const exact = shown.find((o) => o.label.toLowerCase() === q);
    choose(navigated ? shown[highlight] : (exact ?? shown[highlight]));
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp": {
        e.preventDefault();
        e.stopPropagation();
        if (!open) return openList();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setHighlight((h) => Math.min(Math.max(h + step, 0), Math.max(shown.length - 1, 0)));
        setNavigated(true);
        return;
      }
      case "Enter":
        if (open && (typed || navigated)) {
          e.preventDefault();
          e.stopPropagation();
          settle();
        } else {
          setOpen(false);
        }
        return;
      case "Escape":
        if (open) {
          // preventDefault also stops a surrounding <dialog> from closing.
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
          setTyped(false);
          setText(props.value);
        }
        return;
      case "Tab":
        settle();
        return;
    }
  }

  const rect = open ? inputEl.current?.getBoundingClientRect() : undefined;
  // The part of the page actually visible, which shrinks when a phone's keyboard is open.
  const viewport = window.visualViewport;
  const visibleTop = viewport?.offsetTop ?? 0;
  const visibleBottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
  const onScreen = !!rect && rect.bottom > visibleTop && rect.top < visibleBottom;
  const spaceBelow = rect ? visibleBottom - rect.bottom - 8 : 0;
  const spaceAbove = rect ? rect.top - visibleTop - 8 : 0;
  const below = spaceBelow >= 260 || spaceBelow >= spaceAbove;
  const maxHeight = Math.max(120, Math.min(260, below ? spaceBelow : spaceAbove));
  // In a modal dialog, everything outside it is inert and drawn underneath, so the list goes inside it.
  const portalTarget = inputEl.current?.closest("dialog") ?? document.body;

  return (
    <>
      <input
        ref={(el) => {
          inputEl.current = el;
          if (typeof props.inputRef === "function") props.inputRef(el);
          else if (props.inputRef) props.inputRef.current = el;
        }}
        className="cell-input"
        role="combobox"
        aria-label={props.ariaLabel}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && shown.length > 0 ? `${listId}-${highlight}` : undefined}
        value={text}
        placeholder={props.placeholder}
        autoFocus={props.autoFocus}
        disabled={props.disabled}
        onFocus={(e) => {
          e.currentTarget.select();
          openList();
        }}
        onClick={() => !open && openList()}
        onBlur={settle}
        onChange={(e) => {
          setText(e.target.value);
          setTyped(true);
          setNavigated(false);
          setHighlight(0);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
      />
      {/* Rendered into <body> (or the open dialog): a transformed ancestor (the register's virtual
          rows) would otherwise become the containing block for position: fixed and push the list away. */}
      {open &&
        rect &&
        onScreen &&
        shown.length > 0 &&
        createPortal(
          <ul
            id={listId}
            role="listbox"
            className="autocomplete-list"
            style={{
              left: rect.left,
              width: Math.max(rect.width, 220),
              maxHeight,
              ...(below ? { top: rect.bottom + 2 } : { bottom: window.innerHeight - rect.top + 2 }),
            }}
          >
            {shown.map((o, i) => (
              <li key={o.key} role="presentation">
                {o.group && o.group !== shown[i - 1]?.group && <div className="autocomplete-group">{o.group}</div>}
                <div
                  role="option"
                  id={`${listId}-${i}`}
                  aria-selected={i === highlight}
                  className={i === highlight ? "autocomplete-option active" : "autocomplete-option"}
                  ref={(el) => {
                    if (i === highlight) el?.scrollIntoView({ block: "nearest" });
                  }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(o);
                  }}
                  onMouseEnter={() => setHighlight(i)}
                >
                  {o.label}
                </div>
              </li>
            ))}
          </ul>,
          portalTarget,
        )}
    </>
  );
}
