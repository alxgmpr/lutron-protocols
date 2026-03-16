/**
 * Screen — TUI rendering with alternate buffer, scroll regions, and fixed chrome.
 *
 * Uses VT100 scroll regions to confine packet output to the table area.
 * Header (row 1), column headers (rows 2-3), status bar (row H-1), and
 * input line (row H) are outside the scroll region and never move.
 *
 * Layout:
 *   Row 1:        Header bar
 *   Row 2:        Column labels
 *   Row 3:        Separator
 *   Rows 4..H-2:  Scroll region (packet table)
 *   Row H-1:      Status bar
 *   Row H:        Input line
 */

import { stripAnsi } from "./table";

const ESC = "\x1b";
const CSI = `${ESC}[`;

// ============================================================================
// ANSI helpers
// ============================================================================
function moveTo(row: number, col: number): string {
  return `${CSI}${row};${col}H`;
}
function eraseLine(): string {
  return `${CSI}2K`;
}
function eraseToEOL(): string {
  return `${CSI}K`;
}
function setScrollRegion(top: number, bottom: number): string {
  return `${CSI}${top};${bottom}r`;
}
function resetScrollRegion(): string {
  return `${CSI}r`;
}
function altScreenOn(): string {
  return `${CSI}?1049h`;
}
function altScreenOff(): string {
  return `${CSI}?1049l`;
}
function hideCursor(): string {
  return `${CSI}?25l`;
}
function showCursor(): string {
  return `${CSI}?25h`;
}
function disableLineWrap(): string {
  return `${CSI}?7l`;
}
function enableLineWrap(): string {
  return `${CSI}?7h`;
}

// ============================================================================
// IScreen interface — shared between TUI and passthrough
// ============================================================================
export interface IScreen {
  init(): void;
  destroy(): void;
  setHeader(left: string, right?: string): void;
  setColumnHeaders(labels: string, separator: string): void;
  appendLine(text: string): void;
  redrawTable(lines: string[]): void;
  setStatusBar(text: string): void;
  setInputLine(text: string): void;
  setCursorToInput(col: number): void;
  showOverlay(lines: string[]): void;
  clearOverlay(): void;
  handleResize(onResize: () => void): void;
  readonly width: number;
  readonly height: number;
  readonly tableHeight: number;
  readonly isTTY: boolean;
}

// ============================================================================
// PassthroughScreen — non-TTY fallback (pipe mode)
// ============================================================================
export class PassthroughScreen implements IScreen {
  private headerPrinted = false;

  init(): void {}
  destroy(): void {}

  setHeader(_left: string, _right?: string): void {}

  setColumnHeaders(labels: string, _separator: string): void {
    if (!this.headerPrinted) {
      console.log(labels);
      this.headerPrinted = true;
    }
  }

  appendLine(text: string): void {
    console.log(text);
  }

  redrawTable(_lines: string[]): void {}

  setStatusBar(_text: string): void {}

  setInputLine(_text: string): void {}

  setCursorToInput(_col: number): void {}

  showOverlay(lines: string[]): void {
    for (const line of lines) console.log(line);
  }

  clearOverlay(): void {}

  handleResize(_onResize: () => void): void {}

  get width(): number {
    return process.stdout.columns || 120;
  }
  get height(): number {
    return process.stdout.rows || 24;
  }
  get tableHeight(): number {
    return this.height;
  }
  get isTTY(): boolean {
    return false;
  }
}

// ============================================================================
// Screen — full TUI with scroll regions
// ============================================================================
export class Screen implements IScreen {
  private _width = 120;
  private _height = 24;
  private headerText = "";
  private headerSep = "";
  private colLabels = "";
  private colSeparator = "";
  private statusText = "";
  private inputText = "";
  private inputCursorCol = 0;
  private overlayActive = false;
  private pendingLines: string[] = [];
  private flushScheduled = false;

  get width(): number {
    return this._width;
  }
  get height(): number {
    return this._height;
  }
  get tableHeight(): number {
    // chrome: header, header sep, col labels, col sep (top) + status, input sep, input (bottom)
    return Math.max(1, this._height - 7);
  }
  get isTTY(): boolean {
    return true;
  }

  /** Row positions (1-indexed) */
  private get headerRow(): number {
    return 1;
  }
  private get headerSepRow(): number {
    return 2;
  }
  private get colLabelRow(): number {
    return 3;
  }
  private get colSepRow(): number {
    return 4;
  }
  private get scrollTop(): number {
    return 5;
  }
  private get scrollBottom(): number {
    return this._height - 3;
  }
  private get statusRow(): number {
    return this._height - 2;
  }
  private get inputSepRow(): number {
    return this._height - 1;
  }
  private get inputRow(): number {
    return this._height;
  }

  static create(): IScreen {
    if (process.stdout.isTTY) {
      return new Screen();
    }
    return new PassthroughScreen();
  }

  init(): void {
    this._width = process.stdout.columns || 120;
    this._height = process.stdout.rows || 24;

    const buf =
      altScreenOn() +
      hideCursor() +
      disableLineWrap() +
      `${CSI}2J` + // clear screen
      setScrollRegion(this.scrollTop, this.scrollBottom);

    process.stdout.write(buf);
    this.drawChrome();
  }

  destroy(): void {
    const buf =
      resetScrollRegion() + enableLineWrap() + showCursor() + altScreenOff();
    process.stdout.write(buf);
  }

  setHeader(left: string, right?: string): void {
    if (right) {
      const leftLen = stripAnsi(left).length;
      const rightLen = stripAnsi(right).length;
      const usable = this._width - 1; // avoid writing to last column
      const gap = Math.max(2, usable - leftLen - rightLen);
      this.headerText = left + " ".repeat(gap) + right;
    } else {
      this.headerText = left;
    }
    this.headerSep = "\x1b[2m" + "─".repeat(this._width - 1) + "\x1b[0m";
    this.writeAt(this.headerRow, this.headerText);
    this.writeAt(this.headerSepRow, this.headerSep);
  }

  setColumnHeaders(labels: string, separator: string): void {
    this.colLabels = labels;
    this.colSeparator = separator;
    this.writeAt(this.colLabelRow, labels);
    this.writeAt(this.colSepRow, separator);
  }

  /** Hot path: append a line at the bottom of the scroll region. */
  appendLine(text: string): void {
    if (this.overlayActive) return; // don't write behind overlay
    this.pendingLines.push(text);
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => this.flushPending());
    }
  }

  /** Full redraw of the table area (resize, scroll-back). */
  redrawTable(lines: string[]): void {
    let buf = "";
    const top = this.scrollTop;
    const bottom = this.scrollBottom;
    const maxLines = bottom - top + 1;

    // Clear the scroll region
    for (let r = top; r <= bottom; r++) {
      buf += moveTo(r, 1) + eraseLine();
    }

    // Write visible lines (bottom-aligned)
    const startRow = bottom - Math.min(lines.length, maxLines) + 1;
    for (let i = Math.max(0, lines.length - maxLines); i < lines.length; i++) {
      const row = startRow + (i - Math.max(0, lines.length - maxLines));
      buf += moveTo(row, 1) + lines[i] + eraseToEOL();
    }

    // Restore cursor to input
    buf += moveTo(this.inputRow, this.inputCursorCol + 1) + showCursor();
    process.stdout.write(buf);
  }

  setStatusBar(text: string): void {
    this.statusText = text;
    this.writeAt(this.statusRow, text);
  }

  setInputLine(text: string): void {
    this.inputText = text;
    this.writeAt(this.inputRow, text);
  }

  setCursorToInput(col: number): void {
    this.inputCursorCol = col;
    process.stdout.write(moveTo(this.inputRow, col + 1) + showCursor());
  }

  showOverlay(lines: string[]): void {
    this.overlayActive = true;
    let buf = "";
    const top = this.scrollTop;
    const bottom = this.scrollBottom;
    const maxLines = bottom - top + 1;

    // Clear scroll area
    for (let r = top; r <= bottom; r++) {
      buf += moveTo(r, 1) + eraseLine();
    }

    // Write overlay lines from top
    for (let i = 0; i < Math.min(lines.length, maxLines); i++) {
      buf += moveTo(top + i, 1) + lines[i] + eraseToEOL();
    }

    buf += moveTo(this.inputRow, this.inputCursorCol + 1) + showCursor();
    process.stdout.write(buf);
  }

  clearOverlay(): void {
    if (!this.overlayActive) return;
    this.overlayActive = false;
    // Caller should redrawTable with current visible lines
  }

  handleResize(onResize: () => void): void {
    process.stdout.on("resize", () => {
      this._width = process.stdout.columns || 120;
      this._height = process.stdout.rows || 24;

      // Re-establish scroll region and redraw chrome
      process.stdout.write(
        setScrollRegion(this.scrollTop, this.scrollBottom) + `${CSI}2J`,
      );
      this.drawChrome();
      onResize();
    });
  }

  // ============================================================================
  // Internal helpers
  // ============================================================================
  private drawChrome(): void {
    const dimSep = "\x1b[2m" + "─".repeat(this._width - 1) + "\x1b[0m";
    if (this.headerText) this.writeAt(this.headerRow, this.headerText);
    if (this.headerSep) this.writeAt(this.headerSepRow, this.headerSep);
    if (this.colLabels) this.writeAt(this.colLabelRow, this.colLabels);
    if (this.colSeparator) this.writeAt(this.colSepRow, this.colSeparator);
    if (this.statusText) this.writeAt(this.statusRow, this.statusText);
    this.writeAt(this.inputSepRow, dimSep);
    if (this.inputText) this.writeAt(this.inputRow, this.inputText);
  }

  private writeAt(row: number, text: string): void {
    process.stdout.write(
      moveTo(row, 1) +
        eraseLine() +
        text +
        eraseToEOL() +
        moveTo(this.inputRow, this.inputCursorCol + 1) +
        showCursor(),
    );
  }

  /** Flush batched appendLine calls into a single write. */
  private flushPending(): void {
    this.flushScheduled = false;
    if (this.pendingLines.length === 0) return;

    let buf = hideCursor();

    // Position cursor at bottom of scroll region, then write lines.
    // Each line at the bottom causes the scroll region to scroll up.
    for (const line of this.pendingLines) {
      buf += moveTo(this.scrollBottom, 1) + "\n" + line + eraseToEOL();
    }

    this.pendingLines.length = 0;

    // Restore cursor to input line
    buf += moveTo(this.inputRow, this.inputCursorCol + 1) + showCursor();
    process.stdout.write(buf);
  }
}
