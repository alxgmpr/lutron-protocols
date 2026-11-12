/**
 * useLineEditor — Ink hook port of the old LineEditor.
 *
 * Drives an internal buffer/cursor/history/tab-cycle state machine from Ink's
 * useInput events. Keeps every binding from the original:
 *   Enter           — submit
 *   Backspace/Del   — erase
 *   Tab             — cycle tab completions
 *   Ctrl-A/E        — cursor home/end
 *   Ctrl-U/K        — kill to start/end
 *   Ctrl-W          — kill word backward
 *   Ctrl-L          — full redraw
 *   Ctrl-C          — quit
 *   Ctrl-D          — quit (if empty) / delete forward
 *   Arrow up/down   — history
 *   Arrow left/right— cursor
 *   Home/End        — cursor home/end (End also fires onEnd for scroll-to-live)
 *   Page Up/Down    — fire callbacks for log scrolling
 *   Alt-B/F         — word backward/forward
 *   Esc             — enter packet select mode (detail pane)
 *
 * In select mode: Up/Down or k/j move the selection, PgUp/PgDn page it,
 * Esc/Enter/q leave; any other key leaves and is handled normally.
 *
 * The hook pushes input/cursor/palette state into `store` so Ink components can
 * render without re-rendering on every keystroke through React props.
 */

import { useInput } from "ink";
import { useCallback, useRef, useState } from "react";
import { store } from "./store";

const MAX_HISTORY = 50;

export interface LineEditorCallbacks {
  onSubmit: (line: string) => void;
  onPageUp?: () => void;
  onPageDown?: () => void;
  onEnd?: () => void;
  onRedraw?: () => void;
  onQuit?: () => void;
  onAnyKey?: () => void;
  /** Select mode: whether it's active, move by `step` packets, and leave. */
  isSelecting?: () => boolean;
  onSelect?: (step: number) => void;
  onSelectExit?: () => void;
  /** Optional context-aware completion resolver. Called on Tab with the
   *  text before the cursor; return the candidate list (may be empty). */
  getCompletions?: (lineBeforeCursor: string) => string[];
}

export function useLineEditor(cb: LineEditorCallbacks): void {
  // Mutable refs — we push derived state to the store, React state is just
  // used to force a rerender of consumers subscribed via store.
  const bufferRef = useRef<string[]>([]);
  const cursorRef = useRef(0);
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);
  const savedLineRef = useRef("");
  // Active tab-completion cycle; null when not cycling. Any non-Tab key ends it.
  const tabRef = useRef<{ matches: string[]; index: number } | null>(null);
  const [, forceRender] = useState(0);

  const push = useCallback(() => {
    const text = bufferRef.current.join("");
    store.setInput(text, cursorRef.current);
    const tab = tabRef.current;
    if (tab && tab.matches.length > 1) {
      store.setPalette(tab.matches, tab.index);
    } else {
      store.setPalette(null);
    }
  }, []);

  // Ends a cycle and takes its palette down with it: not every key that ends a
  // cycle (Esc, PageUp/Down, Ctrl-L) goes on to push().
  const resetTab = useCallback(() => {
    if (!tabRef.current) return;
    tabRef.current = null;
    store.setPalette(null);
  }, []);

  const setLine = useCallback(
    (text: string) => {
      bufferRef.current = [...text];
      cursorRef.current = bufferRef.current.length;
      push();
    },
    [push],
  );

  const submit = useCallback(() => {
    const line = bufferRef.current.join("").trim();
    if (line.length > 0) {
      const hist = historyRef.current;
      if (hist.length === 0 || hist[0] !== line) {
        hist.unshift(line);
        if (hist.length > MAX_HISTORY) hist.pop();
      }
    }
    bufferRef.current = [];
    cursorRef.current = 0;
    historyIndexRef.current = -1;
    savedLineRef.current = "";
    push();
    cb.onSubmit(line);
  }, [cb, push]);

  const historyUp = useCallback(() => {
    const hist = historyRef.current;
    if (hist.length === 0) return;
    if (historyIndexRef.current === -1) {
      savedLineRef.current = bufferRef.current.join("");
    }
    if (historyIndexRef.current < hist.length - 1) {
      historyIndexRef.current++;
      setLine(hist[historyIndexRef.current]);
    }
  }, [setLine]);

  const historyDown = useCallback(() => {
    if (historyIndexRef.current < 0) return;
    historyIndexRef.current--;
    if (historyIndexRef.current === -1) {
      setLine(savedLineRef.current);
    } else {
      setLine(historyRef.current[historyIndexRef.current]);
    }
  }, [setLine]);

  const backspace = useCallback(() => {
    if (cursorRef.current > 0) {
      bufferRef.current.splice(cursorRef.current - 1, 1);
      cursorRef.current--;
      push();
    }
  }, [push]);

  const deleteForward = useCallback(() => {
    if (cursorRef.current < bufferRef.current.length) {
      bufferRef.current.splice(cursorRef.current, 1);
      push();
    }
  }, [push]);

  const deleteWord = useCallback(() => {
    if (cursorRef.current === 0) return;
    let end = cursorRef.current;
    while (end > 0 && bufferRef.current[end - 1] === " ") end--;
    while (end > 0 && bufferRef.current[end - 1] !== " ") end--;
    bufferRef.current.splice(end, cursorRef.current - end);
    cursorRef.current = end;
    push();
  }, [push]);

  const wordBackward = useCallback(() => {
    while (
      cursorRef.current > 0 &&
      bufferRef.current[cursorRef.current - 1] === " "
    )
      cursorRef.current--;
    while (
      cursorRef.current > 0 &&
      bufferRef.current[cursorRef.current - 1] !== " "
    )
      cursorRef.current--;
    push();
  }, [push]);

  const wordForward = useCallback(() => {
    while (
      cursorRef.current < bufferRef.current.length &&
      bufferRef.current[cursorRef.current] !== " "
    )
      cursorRef.current++;
    while (
      cursorRef.current < bufferRef.current.length &&
      bufferRef.current[cursorRef.current] === " "
    )
      cursorRef.current++;
    push();
  }, [push]);

  const tabComplete = useCallback(() => {
    const before = bufferRef.current.join("").slice(0, cursorRef.current);
    const completions = cb.getCompletions?.(before) ?? [];
    if (completions.length === 0) return;

    const lastSpace = before.lastIndexOf(" ");
    const prefix = lastSpace === -1 ? before : before.slice(lastSpace + 1);
    const matchLine = before.trimStart();

    let tab = tabRef.current;
    if (!tab) {
      // Prefer full-line matches (covers "cca l" → "cca level"),
      // fall back to last-word prefix matches.
      let matches = completions.filter((c) =>
        c.toLowerCase().startsWith(matchLine.toLowerCase()),
      );
      if (matches.length === 0 && prefix.length > 0) {
        matches = completions.filter((c) =>
          c.toLowerCase().startsWith(prefix.toLowerCase()),
        );
      }
      if (matches.length === 0) return;
      tab = { matches, index: 0 };
      tabRef.current = tab;
    } else {
      tab.index = (tab.index + 1) % tab.matches.length;
    }

    const match = tab.matches[tab.index];
    // Replace from last whitespace (or start) with match.
    const replaceFrom = lastSpace === -1 ? 0 : lastSpace + 1;
    // But if match actually begins with the full matchLine, use full replace
    // so "cca l" → "cca level" works.
    const useFullReplace = match
      .toLowerCase()
      .startsWith(matchLine.toLowerCase());
    const from = useFullReplace ? 0 : replaceFrom;
    const removeLen = cursorRef.current - from;
    bufferRef.current.splice(from, removeLen, ...match);
    cursorRef.current = from + match.length;
    push();
  }, [cb, push]);

  useInput((input, key) => {
    cb.onAnyKey?.();
    if (!key.tab) resetTab();

    if (cb.isSelecting?.()) {
      if (key.upArrow || input === "k") return cb.onSelect?.(-1);
      if (key.downArrow || input === "j") return cb.onSelect?.(1);
      if (key.pageUp) return cb.onPageUp?.();
      if (key.pageDown) return cb.onPageDown?.();
      if (key.escape || key.return || input === "q") return cb.onSelectExit?.();
      cb.onSelectExit?.();
    }

    if (key.return) return submit();
    if (key.backspace || key.delete) {
      // Ink 5 maps the Backspace key (\x7f) to key.delete and only Ctrl-H
      // (\b) to key.backspace, so we cannot distinguish Backspace from
      // Forward-Delete (\x1b[3~) here — both arrive as key.delete. Treat
      // both as erase-left; Ctrl-D handles forward-delete.
      backspace();
      return;
    }
    if (key.tab) return tabComplete();
    if (key.upArrow) return historyUp();
    if (key.downArrow) return historyDown();
    if (key.leftArrow) {
      if (cursorRef.current > 0) {
        cursorRef.current--;
        push();
      }
      return;
    }
    if (key.rightArrow) {
      if (cursorRef.current < bufferRef.current.length) {
        cursorRef.current++;
        push();
      }
      return;
    }
    if (key.pageUp) return cb.onPageUp?.();
    if (key.pageDown) return cb.onPageDown?.();
    if (key.escape) return cb.onSelect?.(0);

    if (key.ctrl) {
      switch (input) {
        case "a":
          cursorRef.current = 0;
          push();
          return;
        case "e":
          cursorRef.current = bufferRef.current.length;
          push();
          return;
        case "u":
          bufferRef.current.splice(0, cursorRef.current);
          cursorRef.current = 0;
          push();
          return;
        case "k":
          bufferRef.current.splice(cursorRef.current);
          push();
          return;
        case "w":
          deleteWord();
          return;
        case "l":
          cb.onRedraw?.();
          return;
        case "c":
          cb.onQuit?.();
          return;
        case "d":
          if (bufferRef.current.length === 0) cb.onQuit?.();
          else deleteForward();
          return;
      }
      return;
    }

    if (key.meta) {
      if (input === "b") return wordBackward();
      if (input === "f") return wordForward();
      return;
    }

    // Printable input (may be multi-char for bracketed paste / utf-8)
    if (input && input.length > 0) {
      const chars = [...input];
      bufferRef.current.splice(cursorRef.current, 0, ...chars);
      cursorRef.current += chars.length;
      push();
      // Force rerender to pick up the ref change for any consumers of this
      // hook that aren't subscribed via the store.
      forceRender((n) => n + 1);
    }
  });
}
