export interface ResourceListNotifierOptions {
  send(): Promise<void>;
  closeStream(): void;
  isActive(): boolean;
}

/** Coalesces list invalidations and bounds each live SSE stream to one notification. */
export class ResourceListNotifier {
  private pending = false;
  private pump: Promise<void> | undefined;

  constructor(private readonly options: ResourceListNotifierOptions) {}

  notify(): void {
    if (!this.options.isActive()) return;
    this.pending = true;
    if (this.pump) return;

    const pump = this.flush();
    this.pump = pump;
    void pump.then(
      () => this.finish(pump),
      () => this.finish(pump),
    );
  }

  async idle(): Promise<void> {
    while (this.pump) await this.pump;
  }

  private async flush(): Promise<void> {
    // Let synchronous commit bursts collapse before the first SDK send.
    await Promise.resolve();
    while (this.pending && this.options.isActive()) {
      this.pending = false;
      try {
        await this.options.send();
        if (!this.options.isActive()) return;
        this.options.closeStream();
      } catch {
        this.pending = false;
        return;
      }
      await Promise.resolve();
    }
  }

  private finish(pump: Promise<void>): void {
    if (this.pump !== pump) return;
    this.pump = undefined;
    if (this.pending && this.options.isActive()) this.notify();
  }
}
