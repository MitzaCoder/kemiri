class LaterUndo {
 notice = $state<{ text: string; undo?: () => Promise<unknown> }>();
 pending = $state(false);
 dialogHosts = $state.raw<symbol[]>([]);

 mountDialog(host: symbol) {
  this.dialogHosts = [...this.dialogHosts, host];
  return () => { this.dialogHosts = this.dialogHosts.filter(entry => entry !== host); };
 }
 #timer: ReturnType<typeof setTimeout> | undefined;

 show(text: string, undo?: () => Promise<unknown>) {
  clearTimeout(this.#timer);
  this.notice = { text, undo };
  this.#timer = setTimeout(() => this.dismiss(), 10_000);
 }

 dismiss() {
  this.notice = undefined;
  clearTimeout(this.#timer);
 }

 async restore() {
  const notice = this.notice;
  if (!notice?.undo || this.pending) return;
  this.pending = true;
  try {
   await notice.undo();
   if (this.notice === notice) this.show('Brought back.');
  } catch (error) {
   if (this.notice === notice) this.show(error instanceof Error ? error.message : 'Could not bring it back.');
  } finally { this.pending = false; }
 }
}

export const laterUndo = new LaterUndo();
