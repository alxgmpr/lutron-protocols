/**
 * Ink-facing store — central state shared between nucleo.ts business logic
 * and the Ink component tree.
 *
 * Exposes a React-compatible subscribe/getSnapshot surface (for
 * useSyncExternalStore) plus mutation methods called by the IScreen adapter.
 */

import { RING_BUFFER_SIZE } from "../core/packets";

export interface OverlayState {
  lines: string[];
}

export interface AppState {
  /** Append-only buffer of rendered log lines (ring buffer). */
  lines: string[];
  /** Monotonically increasing generation; changes whenever lines changes. */
  linesGen: number;
  /** Scroll offset: 0 = live (tail), negative = scrolled back by N lines. */
  scrollOffset: number;
  /** Column header labels (left of footer legend). */
  columnHeaders: string;
  /** Header text (right side of footer legend). */
  headerLeft: string;
  headerRight: string;
  /** Status bar text. */
  statusText: string;
  /** Current input line (raw text including prompt? — no: just the typed text) */
  inputText: string;
  /** Cursor position (0-indexed column into inputText). */
  inputCursor: number;
  /** Prompt shown before inputText. */
  prompt: string;
  /** Tab completion palette. null = no palette. */
  palette: { matches: string[]; index: number } | null;
  /** Modal overlay. null = none. */
  overlay: OverlayState | null;
  /** Version counter that increments on any terminal-relevant redraw request. */
  redrawGen: number;
}

export type Listener = () => void;

export class Store {
  private state: AppState = {
    lines: [],
    linesGen: 0,
    scrollOffset: 0,
    columnHeaders: "",
    headerLeft: "",
    headerRight: "",
    statusText: "",
    inputText: "",
    inputCursor: 0,
    prompt: "nucleo> ",
    palette: null,
    overlay: null,
    redrawGen: 0,
  };
  private listeners = new Set<Listener>();

  getState = (): AppState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private emit(): void {
    for (const l of this.listeners) l();
  }

  // ============================================================================
  // Mutations — called by the screen adapter / nucleo.ts business logic.
  // Each produces a new AppState object so React can detect the change.
  // ============================================================================

  appendLines(newLines: string[]): void {
    if (newLines.length === 0) return;
    let lines = this.state.lines;
    // Copy-on-write to a new array, enforce ring size.
    lines = lines.concat(newLines);
    if (lines.length > RING_BUFFER_SIZE) {
      lines = lines.slice(lines.length - RING_BUFFER_SIZE);
    }
    // If we're scrolled back, keep the same viewport (shift offset).
    let scrollOffset = this.state.scrollOffset;
    if (scrollOffset < 0) scrollOffset -= newLines.length;
    this.state = {
      ...this.state,
      lines,
      linesGen: this.state.linesGen + 1,
      scrollOffset,
    };
    this.emit();
  }

  setColumnHeaders(labels: string): void {
    if (this.state.columnHeaders === labels) return;
    this.state = { ...this.state, columnHeaders: labels };
    this.emit();
  }

  setHeader(left: string, right = ""): void {
    if (this.state.headerLeft === left && this.state.headerRight === right)
      return;
    this.state = { ...this.state, headerLeft: left, headerRight: right };
    this.emit();
  }

  setStatusText(text: string): void {
    if (this.state.statusText === text) return;
    this.state = { ...this.state, statusText: text };
    this.emit();
  }

  setInput(text: string, cursor: number): void {
    if (this.state.inputText === text && this.state.inputCursor === cursor)
      return;
    this.state = { ...this.state, inputText: text, inputCursor: cursor };
    this.emit();
  }

  setPrompt(prompt: string): void {
    if (this.state.prompt === prompt) return;
    this.state = { ...this.state, prompt };
    this.emit();
  }

  setPalette(matches: string[] | null, index = 0): void {
    if (!matches || matches.length === 0) {
      if (this.state.palette === null) return;
      this.state = { ...this.state, palette: null };
    } else {
      this.state = { ...this.state, palette: { matches, index } };
    }
    this.emit();
  }

  showOverlay(lines: string[]): void {
    this.state = { ...this.state, overlay: { lines } };
    this.emit();
  }

  clearOverlay(): void {
    if (this.state.overlay === null) return;
    this.state = { ...this.state, overlay: null };
    this.emit();
  }

  scrollBy(pages: number, pageSize: number): void {
    const total = this.state.lines.length;
    const maxBack = -Math.max(0, total - pageSize);
    const offset = Math.max(
      maxBack,
      Math.min(0, this.state.scrollOffset + pages * pageSize),
    );
    if (offset === this.state.scrollOffset) return;
    this.state = { ...this.state, scrollOffset: offset };
    this.emit();
  }

  scrollToLive(): void {
    if (this.state.scrollOffset === 0) return;
    this.state = { ...this.state, scrollOffset: 0 };
    this.emit();
  }

  requestRedraw(): void {
    this.state = { ...this.state, redrawGen: this.state.redrawGen + 1 };
    this.emit();
  }
}

export const store = new Store();
