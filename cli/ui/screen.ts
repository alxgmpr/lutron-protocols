/**
 * Screen adapter — exposes the historical IScreen + LineEditor surface
 * used by cli/nucleo.ts, backed by the Ink `<App/>` tree and the
 * ui/store.ts store.
 *
 * Goals:
 *   - Keep nucleo.ts's call sites unchanged: screen.appendLine(...), etc.
 *   - Route all mutations through `store` so Ink components re-render.
 *   - Fall back to a simple passthrough when stdout is not a TTY (piped).
 */

import { render as inkRender } from "ink";
import { createElement } from "react";
import { App } from "./App";
import { store } from "./store";

// ============================================================================
// Combined screen + line-editor surface. nucleo.ts interacts with this
// single object for both packet output (Screen methods) and shell input
// (LineEditor methods).
// ============================================================================
export interface InkScreen {
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
  setCompletions(list: string[]): void;
  setPrompt(prompt: string): void;
  start(onSubmit: (line: string) => void): void;
  stop(): void;
  onQuit: (() => void) | null;
  onRedraw: (() => void) | null;
  readonly width: number;
  readonly height: number;
  readonly tableHeight: number;
  readonly isTTY: boolean;
}

// ============================================================================
// PassthroughScreen — non-TTY fallback (pipe mode).
// Mirrors the old PassthroughScreen: prints lines directly, ignores layout.
// ============================================================================
class PassthroughScreen implements InkScreen {
  private headerPrinted = false;
  onQuit: (() => void) | null = null;
  onRedraw: (() => void) | null = null;

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
  setCompletions(_list: string[]): void {}
  setPrompt(_prompt: string): void {}
  start(_onSubmit: (line: string) => void): void {
    // In piped mode there is no interactive shell. Exit when stdin ends.
    process.stdin.on("end", () => {
      this.onQuit?.();
    });
    process.stdin.resume();
  }
  stop(): void {
    process.stdin.pause();
  }
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
// InkScreenImpl — mounts <App/> and routes all screen/line-editor mutations
// through ui/store.ts.
// ============================================================================
class InkScreenImpl implements InkScreen {
  private inkInstance: ReturnType<typeof inkRender> | null = null;
  private completions: string[] = [];
  private onSubmitCb: ((line: string) => void) | null = null;
  onQuit: (() => void) | null = null;
  onRedraw: (() => void) | null = null;

  init(): void {
    // Mount happens in start(); init is a no-op so nucleo.ts's init/start
    // sequencing still works (init can be called early before onSubmit is set).
  }

  destroy(): void {
    this.inkInstance?.unmount();
    this.inkInstance = null;
  }

  setHeader(left: string, right?: string): void {
    store.setHeader(left, right);
  }

  setColumnHeaders(labels: string, _separator: string): void {
    store.setColumnHeaders(labels);
  }

  appendLine(text: string): void {
    store.appendLines([text]);
  }

  redrawTable(_lines: string[]): void {}

  setStatusBar(text: string): void {
    store.setStatusText(text);
  }

  setInputLine(_text: string): void {}

  setCursorToInput(_col: number): void {}

  showOverlay(lines: string[]): void {
    store.showOverlay(lines);
  }

  clearOverlay(): void {
    store.clearOverlay();
  }

  handleResize(_onResize: () => void): void {
    // Ink reflows automatically on SIGWINCH. Nothing to wire up.
  }

  setCompletions(list: string[]): void {
    this.completions = list;
  }

  setPrompt(prompt: string): void {
    store.setPrompt(prompt);
  }

  start(onSubmit: (line: string) => void): void {
    this.onSubmitCb = onSubmit;
    this.inkInstance = inkRender(
      createElement(App, {
        getCompletions: (before) => this.resolveCompletions(before),
        onSubmit: (line) => this.onSubmitCb?.(line),
        onQuit: () => this.onQuit?.(),
        onRedraw: () => this.onRedraw?.(),
      }),
      { exitOnCtrlC: false },
    );
  }

  stop(): void {
    this.destroy();
  }

  /** Default resolver: flat prefix match on the static list. nucleo.ts can
   *  layer on LEAP-driven context by calling setCompletions with a richer
   *  list or by patching resolveCompletions in a future step. */
  private resolveCompletions(_before: string): string[] {
    return this.completions;
  }

  get width(): number {
    return process.stdout.columns || 120;
  }
  get height(): number {
    return process.stdout.rows || 24;
  }
  get tableHeight(): number {
    return Math.max(1, this.height - 3);
  }
  get isTTY(): boolean {
    return true;
  }
}

// ============================================================================
// Factory mirroring the old Screen.create() API.
// ============================================================================
export function createScreen(): InkScreen {
  if (process.stdout.isTTY) {
    return new InkScreenImpl();
  }
  return new PassthroughScreen();
}
