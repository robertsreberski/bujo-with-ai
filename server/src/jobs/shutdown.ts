export interface QuiesceableRuntime {
  quiesce(): Promise<void>;
  close(): Promise<void>;
}

export interface DrainableMaintenance {
  close(): Promise<void>;
}

export interface ReleasableLease {
  release(): Promise<void>;
}

/** Quiesce ingress first, drain work second, then close storage and release ownership. */
export async function shutdownJournal(
  runtime: QuiesceableRuntime,
  maintenance: DrainableMaintenance,
  lease: ReleasableLease,
): Promise<void> {
  let failure: unknown;
  for (const operation of [
    () => runtime.quiesce(),
    () => maintenance.close(),
    () => runtime.close(),
    () => lease.release(),
  ]) {
    try {
      await operation();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
}
