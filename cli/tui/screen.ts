/**
 * Screen — Chat-style TUI with append-only output and pinned footer.
 *
 * Packets append to the main terminal buffer (no alternate screen),
 * enabling native scrollback (Shift+PgUp, mouse wheel). A 3-row footer
 * is pinned at the bottom via a VT100 scroll region.
 *
 * Layout:
 *   Rows 1..H-3:  Scroll region (append-only packet output)
 *   Row H-2:      Separator
 *   Row H-1:      Footer legend (column names left, status/counts right)
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
// Screen — chat-style TUI with pinned footer
// ============================================================================
export class Screen implements IScreen {
  private _width = 120;
  private _height = 24;
  private headerText = "";
  private colLabels = "";
  private statusText = "";
  private inputText = "";
  private inputCursorCol = 0;
  private pendingLines: string[] = [];
  private flushScheduled = false;

  get width(): number {
    return this._width;
  }
  get height(): number {
    return this._height;
  }
  get tableHeight(): number {
    return Math.max(1, this._height - 3);
  }
  get isTTY(): boolean {
    return true;
  }

  /** Row positions (1-indexed). Footer occupies last 3 rows. */
  private get scrollBottom(): number {
    return this._height - 3;
  }
  private get separatorRow(): number {
    return this._height - 2;
  }
  private get legendRow(): number {
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

    // No alt screen — stay in main buffer for native scrollback.
    // Scroll region: rows 1..H-3. Footer rows H-2, H-1, H are pinned.
    const buf =
      hideCursor() + disableLineWrap() + setScrollRegion(1, this.scrollBottom);

    process.stdout.write(buf);
    this.drawFooter();
  }

  destroy(): void {
    const buf = resetScrollRegion() + enableLineWrap() + showCursor() + "\n";
    process.stdout.write(buf);
  }

  /** Header info is displayed in the footer legend bar (right side). */
  setHeader(left: string, right?: string): void {
    this.headerText = right ? `${left}  ${right}` : left;
    this.drawFooter();
  }

  /** Column labels are displayed in the footer legend bar (left side). */
  setColumnHeaders(labels: string, _separator: string): void {
    this.colLabels = labels;
    this.drawFooter();
  }

  /** Hot path: append a line at the bottom of the scroll region. */
  appendLine(text: string): void {
    this.pendingLines.push(text);
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => this.flushPending());
    }
  }

  /** No-op in chat mode — packets are already in the terminal buffer. */
  redrawTable(_lines: string[]): void {}

  setStatusBar(text: string): void {
    this.statusText = text;
    this.drawFooter();
  }

  setInputLine(text: string): void {
    this.inputText = text;
    this.writeAt(this.inputRow, text);
  }

  setCursorToInput(col: number): void {
    this.inputCursorCol = col;
    process.stdout.write(moveTo(this.inputRow, col + 1) + showCursor());
  }

  /** Append overlay content inline as styled text. */
  showOverlay(lines: string[]): void {
    const sep = "\x1b[2m" + "─".repeat(this._width - 1) + "\x1b[0m";
    this.pendingLines.push(sep);
    for (const line of lines) {
      this.pendingLines.push(line);
    }
    this.pendingLines.push(sep);
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => this.flushPending());
    }
  }

  clearOverlay(): void {}

  handleResize(onResize: () => void): void {
    process.stdout.on("resize", () => {
      this._width = process.stdout.columns || 120;
      this._height = process.stdout.rows || 24;

      // Re-establish scroll region with new dimensions and redraw footer
      process.stdout.write(setScrollRegion(1, this.scrollBottom));
      this.drawFooter();
      onResize();
    });
  }

  // ============================================================================
  // Internal helpers
  // ============================================================================

  /** Compose and draw the 3-row pinned footer. */
  private drawFooter(): void {
    const dimSep = "\x1b[2m" + "─".repeat(this._width - 1) + "\x1b[0m";

    // Legend row: column labels left, header/status info right
    const rightParts: string[] = [];
    if (this.statusText) rightParts.push(this.statusText);
    if (this.headerText) rightParts.push(this.headerText);
    const right = rightParts.join("  ");

    let legend = "";
    if (this.colLabels && right) {
      const leftLen = stripAnsi(this.colLabels).length;
      const rightLen = stripAnsi(right).length;
      const usable = this._width - 1;
      const gap = Math.max(2, usable - leftLen - rightLen);
      legend = this.colLabels + " ".repeat(gap) + right;
    } else {
      legend = this.colLabels || right;
    }

    this.writeAt(this.separatorRow, dimSep);
    this.writeAt(this.legendRow, legend);
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

    for (const line of this.pendingLines) {
      buf += moveTo(this.scrollBottom, 1) + "\n" + line + eraseToEOL();
    }

    this.pendingLines.length = 0;

    buf += moveTo(this.inputRow, this.inputCursorCol + 1) + showCursor();
    process.stdout.write(buf);
  }
}
