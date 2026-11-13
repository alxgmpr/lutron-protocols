/**
 * Ink-facing store — central state shared between openlutron.ts business logic
 * and the Ink component tree.
 *
 * Exposes a React-compatible subscribe/getSnapshot surface (for
 * useSyncExternalStore) plus mutation methods called by the IScreen adapter.
 */

import {
  entryLineCount,
  isText,
  type LogEntry,
  type PacketRow,
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
  /** Per-device sparkline panel visible. */
  devices: boolean;
  /** Packet selected for the detail pane; non-null means select mode. */
  selected: PacketRow | null;
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
    devices: false,
    selected: null,
    headerLeft: "",
    headerRight: "",
    statusText: "",
    inputText: "",
    inputCursor: 0,
    prompt: "openlutron> ",
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
  // Mutations — called by the screen adapter / openlutron.ts business logic.
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
    // If scrolled back or selecting, keep the same viewport (shift offset).
    let scrollOffset = this.state.scrollOffset;
    if (scrollOffset < 0 || this.state.selected) {
      for (const e of newEntries) scrollOffset -= this.lineCount(e);
    }
    this.state = { ...this.state, entries, scrollOffset };
    this.emit();
  }

  /** Change display options; the viewport snaps back to live. */
  setDisplay(opts: { raw?: boolean; verbose?: boolean }): void {
    this.state = { ...this.state, ...opts, scrollOffset: 0, selected: null };
    this.emit();
  }

  /** Set the packet filter (empty spec clears it). Throws on a bad spec. */
  setFilter(spec: string): void {
    const filter = spec.trim()
      ? { spec: spec.trim(), match: parseFilter(spec) }
      : null;
    this.state = { ...this.state, filter, scrollOffset: 0, selected: null };
    this.emit();
  }

  /**
   * Move the selection `step` visible packets (negative = older). With no
   * selection, selects the newest visible packet. Scrolls so the selected
   * row stays within a log window of `height` lines.
   */
  moveSelection(step: number, height: number): void {
    const { entries, selected } = this.state;
    const match = this.state.filter?.match ?? null;
    const rows: { idx: number; row: PacketRow }[] = [];
    entries.forEach((e, idx) => {
      if (!isText(e) && (!match || match(e))) rows.push({ idx, row: e });
    });
    if (rows.length === 0) return;
    const cur = rows.findIndex((r) => r.row === selected);
    const pos =
      cur === -1
        ? rows.length - 1
        : Math.max(0, Math.min(rows.length - 1, cur + step));
    this.select(rows[pos].idx, rows[pos].row, height);
  }

  /** Select a specific row (e.g. clicked), keeping it in view. */
  selectRow(row: PacketRow, height: number): void {
    const idx = this.state.entries.lastIndexOf(row);
    if (idx !== -1) this.select(idx, row, height);
  }

  private select(idx: number, row: PacketRow, height: number): void {
    const { entries } = this.state;
    // Display lines below the selected row's main line.
    let below = this.state.verbose && row.verboseLine ? 1 : 0;
    for (let i = idx + 1; i < entries.length; i++) {
      below += this.lineCount(entries[i]);
    }
    const offset = Math.min(
      below,
      Math.max(below - height + 1, -this.state.scrollOffset),
    );
    this.state = { ...this.state, selected: row, scrollOffset: -offset };
    this.emit();
  }

  toggleDevices(): boolean {
    this.state = { ...this.state, devices: !this.state.devices };
    this.emit();
    return this.state.devices;
  }

  clearSelection(): void {
    if (!this.state.selected) return;
    this.state = { ...this.state, selected: null };
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

  /** Scroll by `pages` × `pageSize` lines; `height` is the log window, so
   *  scrolling stops once the oldest line reaches its top. */
  scrollBy(pages: number, pageSize: number, height = pageSize): void {
    let total = 0;
    for (const e of this.state.entries) total += this.lineCount(e);
    const maxBack = -Math.max(0, total - height);
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
