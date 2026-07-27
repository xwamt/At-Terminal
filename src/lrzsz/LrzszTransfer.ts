import type { LrzszTransferStart } from './LrzszDetector';
import { showTimedNotification } from '../utils/notifications';

export class LrzszTransfer {
  async start(start: LrzszTransferStart): Promise<void> {
    await showTimedNotification(`lrzsz ${start.direction} detected. Waiting for protocol adapter validation.`);
  }
}
