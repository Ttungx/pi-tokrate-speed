// Live rates estimate output over a trailing window; final rates use provider usage.
// Keep gaps within one response: buffered providers may emit seconds apart.
// The message boundary resets the timer so tool execution stays outside it.
import { estimateTokens } from "./estimate.ts";

/** Trailing window for the live rate. */
const WINDOW_MS = 1000;

interface Sample {
  at: number;
  tokens: number;
}

/** What a delta was: the model deliberating, or the model answering. */
export type DeltaKind = "thinking" | "output";

export class Meter {
  private samples: Sample[] = [];
  private estimated = 0;
  private estimatedThinking = 0;
  private actual: number | null = null;
  private activeMs = 0;
  private lastDeltaAt: number | null = null;
  private streaming = false;

  // Null rather than 0 for "not started": a timestamp of 0 is a legitimate
  // value, and treating it as absent silently drops time-to-first-token.
  private promptAt: number | null = null;
  private ttftMs: number | null = null;

  /** Begin a turn. Everything from the previous one is discarded. */
  reset(now: number = Date.now()): void {
    this.samples = [];
    this.estimated = 0;
    this.estimatedThinking = 0;
    this.actual = null;
    this.activeMs = 0;
    this.lastDeltaAt = null;
    this.streaming = false;
    this.promptAt = now;
    this.ttftMs = null;
  }

  /** Begin one assistant response, excluding the preceding tool/wait interval. */
  markGenerationStart(): void {
    this.streaming = true;
    this.lastDeltaAt = null;
    this.samples = [];
  }

  /** Record substantive output; all gaps within this response count. */
  record(delta: string, kind: DeltaKind = "output", now: number = Date.now()): void {
    const tokens = estimateTokens(delta);
    if (tokens <= 0) return;

    if (this.ttftMs === null && this.promptAt !== null) this.ttftMs = now - this.promptAt;
    if (this.lastDeltaAt !== null) {
      this.activeMs += Math.max(0, now - this.lastDeltaAt);
    }
    this.lastDeltaAt = now;
    this.streaming = true;

    this.estimated += tokens;
    if (kind === "thinking") this.estimatedThinking += tokens;
    this.samples.push({ at: now, tokens });
    this.trim(now);
  }

  /** End the turn, adopting the provider's authoritative output count. */
  finish(actualTokens: number): void {
    this.streaming = false;
    if (Number.isFinite(actualTokens) && actualTokens > 0) this.actual = actualTokens;
  }

  private trim(now: number): void {
    const cutoff = now - WINDOW_MS;
    let i = 0;
    while (i < this.samples.length && this.samples[i].at < cutoff) i++;
    if (i > 0) this.samples = this.samples.slice(i);
  }

  get isStreaming(): boolean {
    return this.streaming;
  }

  /** Raw estimated tokens this turn, before any calibration. */
  get estimatedTokens(): number {
    return this.estimated;
  }

  /**
   * The share of this turn's estimated tokens that went into thinking.
   *
   * A share rather than a count, because that is the part worth trusting.
   * Both halves come from the same estimator, so its bias largely cancels
   * in the ratio — and a share is what gets scaled against the provider's
   * authoritative total to recover counts.
   */
  get thinkingShare(): number {
    return this.estimated > 0 ? this.estimatedThinking / this.estimated : 0;
  }

  /** The provider's count, once the turn has ended. */
  get actualTokens(): number | null {
    return this.actual;
  }

  get ttft(): number | null {
    return this.ttftMs;
  }

  /** Seconds spent generating, excluding pauses. */
  get activeSeconds(): number {
    return this.activeMs / 1000;
  }

  /** Use the trailing window when measurable, otherwise this turn's average. */
  windowRate(now: number = Date.now()): number | null {
    this.trim(now);
    if (this.samples.length < 2) return this.turnRate();

    const span = this.samples[this.samples.length - 1].at - this.samples[0].at;
    if (span <= 0) return this.turnRate();

    // The first sample's tokens arrived before the span opened, so counting
    // them would inflate the rate on a slow stream.
    let tokens = 0;
    for (let i = 1; i < this.samples.length; i++) tokens += this.samples[i].tokens;
    return (tokens / span) * 1000;
  }

  /**
   * The turn's overall rate, using the authoritative count when the turn has
   * finished and the estimate while it is still running.
   */
  turnRate(): number | null {
    if (this.activeMs <= 0) return null;
    const tokens = this.actual ?? this.estimated;
    if (tokens <= 0) return null;
    return tokens / this.activeSeconds;
  }
}
