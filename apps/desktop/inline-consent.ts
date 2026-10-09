import { randomUUID } from 'node:crypto';
export interface PendingHandoff { id: string; source: string; snapshotId: string }
/** Remote code/data never supplies consent. Only the trusted app's explicit inline action resolves this gate. */
export class InlineHandoffConsent {
  private pending: { view: PendingHandoff; resolve: (accepted: boolean) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  status(): PendingHandoff | null { return this.pending ? { ...this.pending.view } : null; }
  request(source: string, snapshotId: string): Promise<boolean> {
    if (this.pending) return Promise.resolve(false);
    return new Promise(resolve => {
      const view = { id: randomUUID(), source, snapshotId };
      const timer = setTimeout(() => { if (this.pending?.view.id === view.id) this.close(); }, 120000);
      timer.unref();
      this.pending = { view, resolve, timer };
    });
  }
  respond(id: string, accepted: boolean): void {
    const pending = this.pending;
    if (!pending || pending.view.id !== id || typeof accepted !== 'boolean') throw new Error('Incoming handoff changed or is no longer pending');
    clearTimeout(pending.timer); this.pending = null; pending.resolve(accepted);
  }
  close(): void { if (this.pending) this.respond(this.pending.view.id, false); }
}
