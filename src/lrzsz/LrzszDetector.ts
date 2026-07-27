export type LrzszDirection = 'upload' | 'download';

export interface LrzszTransferStart {
  direction: LrzszDirection;
}

export class LrzszDetector {
  constructor(private readonly events: { onTransfer(start: LrzszTransferStart): void }) {}

  inspect(data: string): { passthrough: string } {
    if (data.includes('**\x18B')) {
      this.events.onTransfer({ direction: 'download' });
      return { passthrough: '' };
    }
    if (data.includes('\x18B0100000023be50')) {
      this.events.onTransfer({ direction: 'upload' });
      return { passthrough: '' };
    }
    return { passthrough: data };
  }
}
