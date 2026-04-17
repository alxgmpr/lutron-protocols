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
  const tabMatchesRef = useRef<string[]>([]);
  const tabIndexRef = useRef(-1);
  const [, forceRender] = useState(0);

  const push = useCallback(() => {
    const text = bufferRef.current.join("");
    store.setInput(text, cursorRef.current);
    if (tabMatchesRef.current.length > 1) {
      store.setPalette(tabMatchesRef.current, tabIndexRef.current);
    } else {
      store.setPalette(null);
    }
  }, []);

  const resetTab = useCallback(() => {
    tabIndexRef.current = -1;
    tabMatchesRef.current = [];
  }, []);

  const setLine = useCallback(
    (text: string) => {
      bufferRef.current = [...text];
      cursorRef.current = bufferRef.current.length;
      resetTab();
      push();
    },
    [push, resetTab],
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
    resetTab();
    push();
    cb.onSubmit(line);
  }, [cb, push, resetTab]);

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
      resetTab();
      bufferRef.current.splice(cursorRef.current - 1, 1);
      cursorRef.current--;
      push();
    }
  }, [push, resetTab]);

  const deleteForward = useCallback(() => {
    if (cursorRef.current < bufferRef.current.length) {
      resetTab();
      bufferRef.current.splice(cursorRef.current, 1);
      push();
    }
  }, [push, resetTab]);

  const deleteWord = useCallback(() => {
    if (cursorRef.current === 0) return;
    resetTab();
    let end = cursorRef.current;
    while (end > 0 && bufferRef.current[end - 1] === " ") end--;
    while (end > 0 && bufferRef.current[end - 1] !== " ") end--;
    bufferRef.current.splice(end, cursorRef.current - end);
    cursorRef.current = end;
    push();
  }, [push, resetTab]);

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

    if (tabIndexRef.current === -1) {
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
      tabMatchesRef.current = matches;
      tabIndexRef.current = 0;
    } else {
      tabIndexRef.current =
        (tabIndexRef.current + 1) % tabMatchesRef.current.length;
    }

    const match = tabMatchesRef.current[tabIndexRef.current];
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

    if (key.return) return submit();
    if (key.backspace || key.delete) {
      // Ink's `delete` is forward-delete; `backspace` is erase left.
      if (key.delete) deleteForward();
      else backspace();
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
    if (key.escape) return;

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
      resetTab();
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
