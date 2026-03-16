/**
 * LineEditor — raw mode stdin with line editing, history, and tab completion.
 *
 * Reads raw keystrokes, handles cursor movement, editing keys, history
 * navigation, and tab completion. Renders the current line via a callback.
 */

// Key codes
const KEY = {
  BACKSPACE: 0x7f,
  DEL_BACKSPACE: 0x08,
  TAB: 0x09,
  ENTER: 0x0d,
  CTRL_A: 0x01,
  CTRL_C: 0x03,
  CTRL_D: 0x04,
  CTRL_E: 0x05,
  CTRL_K: 0x0b,
  CTRL_L: 0x0c,
  CTRL_U: 0x15,
  CTRL_W: 0x17,
  ESC: 0x1b,
} as const;

const MAX_HISTORY = 50;

export class LineEditor {
  private buffer: string[] = [];
  private cursor = 0;
  private history: string[] = [];
  private historyIndex = -1;
  private savedLine = ""; // saved current line when navigating history
  private completions: string[] = [];
  private tabMatches: string[] = [];
  private tabIndex = -1;
  private prompt = "nucleo> ";
  private onSubmitFn: ((line: string) => void) | null = null;
  private active = false;

  /** Called when the visible input line changes. (promptText, cursorCol) */
  onRender: ((text: string, cursorCol: number) => void) | null = null;

  /** Called when Page Up is pressed. */
  onPageUp: (() => void) | null = null;

  /** Called when Page Down is pressed. */
  onPageDown: (() => void) | null = null;

  /** Called when End key is pressed (scroll to live). */
  onEnd: (() => void) | null = null;

  /** Called on Ctrl-L (full redraw). */
  onRedraw: (() => void) | null = null;

  /** Called when user wants to quit (Ctrl-C). */
  onQuit: (() => void) | null = null;

  /** Called when any key is pressed (for dismissing overlays). */
  onAnyKey: (() => void) | null = null;

  setPrompt(prompt: string): void {
    this.prompt = prompt;
  }

  setCompletions(list: string[]): void {
    this.completions = list;
  }

  start(onSubmit: (line: string) => void): void {
    this.onSubmitFn = onSubmit;
    this.active = true;

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.on("data", this.handleData);
    this.render();
  }

  stop(): void {
    this.active = false;
    process.stdin.removeListener("data", this.handleData);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
  }

  private handleData = (data: Buffer): void => {
    if (!this.active) return;

    for (let i = 0; i < data.length; i++) {
      const byte = data[i];

      // Escape sequences
      if (byte === KEY.ESC) {
        if (i + 1 < data.length && data[i + 1] === 0x5b) {
          // CSI sequence
          i += 2;
          if (i < data.length) {
            const code = data[i];
            // Check for extended sequences like 5~ (Page Up), 6~ (Page Down)
            if (
              code >= 0x30 &&
              code <= 0x39 &&
              i + 1 < data.length &&
              data[i + 1] === 0x7e
            ) {
              const num = code - 0x30;
              i++; // consume ~
              if (num === 5) {
                // Page Up
                this.onAnyKey?.();
                this.onPageUp?.();
              } else if (num === 6) {
                // Page Down
                this.onAnyKey?.();
                this.onPageDown?.();
              } else if (num === 3) {
                // Delete
                this.onAnyKey?.();
                this.deleteForward();
              }
              continue;
            }
            switch (code) {
              case 0x41: // Up arrow
                this.onAnyKey?.();
                this.historyUp();
                break;
              case 0x42: // Down arrow
                this.onAnyKey?.();
                this.historyDown();
                break;
              case 0x43: // Right arrow
                this.onAnyKey?.();
                this.cursorRight();
                break;
              case 0x44: // Left arrow
                this.onAnyKey?.();
                this.cursorLeft();
                break;
              case 0x48: // Home
                this.onAnyKey?.();
                this.cursor = 0;
                this.render();
                break;
              case 0x46: // End
                this.onAnyKey?.();
                this.cursor = this.buffer.length;
                this.onEnd?.();
                this.render();
                break;
              default:
                // Unknown escape — consume and skip
                break;
            }
          }
        } else if (i + 1 < data.length && data[i + 1] === 0x62) {
          // Alt-B: word backward
          i++;
          this.onAnyKey?.();
          this.wordBackward();
        } else if (i + 1 < data.length && data[i + 1] === 0x66) {
          // Alt-F: word forward
          i++;
          this.onAnyKey?.();
          this.wordForward();
        }
        continue;
      }

      this.onAnyKey?.();

      switch (byte) {
        case KEY.ENTER:
          this.submit();
          break;
        case KEY.BACKSPACE:
        case KEY.DEL_BACKSPACE:
          this.backspace();
          break;
        case KEY.TAB:
          this.tabComplete();
          break;
        case KEY.CTRL_A:
          this.cursor = 0;
          this.render();
          break;
        case KEY.CTRL_E:
          this.cursor = this.buffer.length;
          this.render();
          break;
        case KEY.CTRL_U:
          this.buffer.splice(0, this.cursor);
          this.cursor = 0;
          this.render();
          break;
        case KEY.CTRL_K:
          this.buffer.splice(this.cursor);
          this.render();
          break;
        case KEY.CTRL_W:
          this.deleteWord();
          break;
        case KEY.CTRL_L:
          this.onRedraw?.();
          break;
        case KEY.CTRL_C:
          this.onQuit?.();
          break;
        case KEY.CTRL_D:
          if (this.buffer.length === 0) {
            this.onQuit?.();
          } else {
            this.deleteForward();
          }
          break;
        default:
          if (byte >= 0x20 && byte < 0x7f) {
            // Printable ASCII
            this.resetTab();
            this.buffer.splice(this.cursor, 0, String.fromCharCode(byte));
            this.cursor++;
            this.render();
          } else if (byte >= 0xc0) {
            // Multi-byte UTF-8 start byte — collect remaining bytes
            const charBytes = [byte];
            const needed = byte < 0xe0 ? 1 : byte < 0xf0 ? 2 : 3;
            for (let j = 0; j < needed && i + 1 < data.length; j++) {
              i++;
              charBytes.push(data[i]);
            }
            const char = Buffer.from(charBytes).toString("utf-8");
            if (char.length > 0) {
              this.resetTab();
              this.buffer.splice(this.cursor, 0, char);
              this.cursor++;
              this.render();
            }
          }
          break;
      }
    }
  };

  private render(): void {
    const line = this.prompt + this.buffer.join("");
    const col = this.prompt.length + this.cursor;
    this.onRender?.(line, col);
  }

  private submit(): void {
    const line = this.buffer.join("").trim();
    if (line.length > 0) {
      // Add to history (dedupe recent)
      if (this.history.length === 0 || this.history[0] !== line) {
        this.history.unshift(line);
        if (this.history.length > MAX_HISTORY) this.history.pop();
      }
    }
    this.buffer = [];
    this.cursor = 0;
    this.historyIndex = -1;
    this.savedLine = "";
    this.resetTab();
    this.render();
    this.onSubmitFn?.(line);
  }

  private backspace(): void {
    if (this.cursor > 0) {
      this.resetTab();
      this.buffer.splice(this.cursor - 1, 1);
      this.cursor--;
      this.render();
    }
  }

  private deleteForward(): void {
    if (this.cursor < this.buffer.length) {
      this.resetTab();
      this.buffer.splice(this.cursor, 1);
      this.render();
    }
  }

  private deleteWord(): void {
    if (this.cursor === 0) return;
    this.resetTab();
    let end = this.cursor;
    // Skip whitespace backward
    while (end > 0 && this.buffer[end - 1] === " ") end--;
    // Skip word characters backward
    while (end > 0 && this.buffer[end - 1] !== " ") end--;
    this.buffer.splice(end, this.cursor - end);
    this.cursor = end;
    this.render();
  }

  private cursorLeft(): void {
    if (this.cursor > 0) {
      this.cursor--;
      this.render();
    }
  }

  private cursorRight(): void {
    if (this.cursor < this.buffer.length) {
      this.cursor++;
      this.render();
    }
  }

  private wordBackward(): void {
    while (this.cursor > 0 && this.buffer[this.cursor - 1] === " ")
      this.cursor--;
    while (this.cursor > 0 && this.buffer[this.cursor - 1] !== " ")
      this.cursor--;
    this.render();
  }

  private wordForward(): void {
    while (this.cursor < this.buffer.length && this.buffer[this.cursor] !== " ")
      this.cursor++;
    while (this.cursor < this.buffer.length && this.buffer[this.cursor] === " ")
      this.cursor++;
    this.render();
  }

  private historyUp(): void {
    if (this.history.length === 0) return;
    if (this.historyIndex === -1) {
      this.savedLine = this.buffer.join("");
    }
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
      this.setLine(this.history[this.historyIndex]);
    }
  }

  private historyDown(): void {
    if (this.historyIndex < 0) return;
    this.historyIndex--;
    if (this.historyIndex === -1) {
      this.setLine(this.savedLine);
    } else {
      this.setLine(this.history[this.historyIndex]);
    }
  }

  private setLine(text: string): void {
    this.buffer = [...text];
    this.cursor = this.buffer.length;
    this.resetTab();
    this.render();
  }

  private tabComplete(): void {
    if (this.completions.length === 0) return;

    const line = this.buffer.join("");
    const prefix = line.slice(0, this.cursor).split(/\s+/).pop() || "";
    if (prefix.length === 0) return;

    if (this.tabIndex === -1) {
      // First tab — compute matches
      this.tabMatches = this.completions.filter((c) =>
        c.toLowerCase().startsWith(prefix.toLowerCase()),
      );
      if (this.tabMatches.length === 0) return;
      this.tabIndex = 0;
    } else {
      this.tabIndex = (this.tabIndex + 1) % this.tabMatches.length;
    }

    // Replace the prefix with the match
    const match = this.tabMatches[this.tabIndex];
    const prefixStart = this.cursor - prefix.length;
    this.buffer.splice(prefixStart, prefix.length, ...match);
    this.cursor = prefixStart + match.length;
    this.render();
  }

  private resetTab(): void {
    this.tabIndex = -1;
    this.tabMatches = [];
  }
}
