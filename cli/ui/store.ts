/**
 * Ink-facing store — central state shared between nucleo.ts business logic
 * and the Ink component tree.
 *
 * Exposes a React-compatible subscribe/getSnapshot surface (for
 * useSyncExternalStore) plus mutation methods called by the IScreen adapter.
 */

import {
  entryLineCount,
  type LogEntry,
  parseFilter,
  RING_BUFFER_SIZE,
  type RowFilter,
} from "../core/packets";

export interface OverlayState {
  lines: string[];
}

export interface AppState {
  /** Ring buffer of log entries; packets stay structured until rendered. */
  entries: LogEntry[];
  /** Scroll offset in display lines: 0 = live (tail), negative = scrolled back. */
  scrollOffset: number;
  /** Packet display options, applied at render time to the whole buffer. */
  raw: boolean;
  verbose: boolean;
  /** Active packet filter, or null. */
  filter: { spec: string; match: RowFilter } | null;
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
}

export type Listener = () => void;

export class Store {
  private state: AppState = {
    entries: [],
    scrollOffset: 0,
    raw: true,
    verbose: false,
    filter: null,
    headerLeft: "",
    headerRight: "",
    statusText: "",
    inputText: "",
    inputCursor: 0,
    prompt: "nucleo> ",
    palette: null,
    overlay: null,
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

  private lineCount(e: LogEntry): number {
    return entryLineCount(
      e,
      this.state.verbose,
      this.state.filter?.match ?? null,
    );
  }

  append(newEntries: LogEntry[]): void {
    if (newEntries.length === 0) return;
    let entries = this.state.entries.concat(newEntries);
    if (entries.length > RING_BUFFER_SIZE) {
      entries = entries.slice(entries.length - RING_BUFFER_SIZE);
    }
    // If we're scrolled back, keep the same viewport (shift offset).
    let scrollOffset = this.state.scrollOffset;
    if (scrollOffset < 0) {
      for (const e of newEntries) scrollOffset -= this.lineCount(e);
    }
    this.state = { ...this.state, entries, scrollOffset };
    this.emit();
  }

  /** Change display options; the viewport snaps back to live. */
  setDisplay(opts: { raw?: boolean; verbose?: boolean }): void {
    this.state = { ...this.state, ...opts, scrollOffset: 0 };
    this.emit();
  }

  /** Set the packet filter (empty spec clears it). Throws on a bad spec. */
  setFilter(spec: string): void {
    const filter = spec.trim()
      ? { spec: spec.trim(), match: parseFilter(spec) }
      : null;
    this.state = { ...this.state, filter, scrollOffset: 0 };
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
    let total = 0;
    for (const e of this.state.entries) total += this.lineCount(e);
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
    this.state = { ...this.state };
    this.emit();
  }
}

export const store = new Store();
