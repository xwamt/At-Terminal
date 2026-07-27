import { describe, expect, it } from 'vitest';
import {
  FAILED_NOTIFICATION_MS,
  TIMED_NOTIFICATION_MS
} from '../../src/utils/notifications';

describe('notifications', () => {
  it('uses 3s for success and 8s for failure toasts', () => {
    expect(TIMED_NOTIFICATION_MS).toBe(3000);
    expect(FAILED_NOTIFICATION_MS).toBe(8000);
  });
});
