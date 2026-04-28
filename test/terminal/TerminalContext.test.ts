import { describe, expect, it, vi } from 'vitest';
import { TerminalContextRegistry, type TerminalContext } from '../../src/terminal/TerminalContext';
import type { ServerConfig } from '../../src/config/schema';

function server(id: string): ServerConfig {
  return {
    id,
    label: id,
    host: `${id}.example.com`,
    port: 22,
    username: 'deploy',
    authType: 'password',
    keepAliveInterval: 30,
    encoding: 'utf-8',
    createdAt: 1,
    updatedAt: 1
  };
}

describe('TerminalContextRegistry', () => {
  it('publishes the active terminal context and connection state', () => {
    const registry = new TerminalContextRegistry();
    const listener = vi.fn();
    registry.onDidChangeActiveContext(listener);

    const context: TerminalContext = {
      terminalId: 'terminal-a',
      server: server('a'),
      connected: true,
      write: vi.fn()
    };

    registry.setActive(context);

    expect(registry.getActive()).toBe(context);
    expect(listener).toHaveBeenCalledWith(context);
  });

  it('does not publish when the same terminal is activated without a state change', () => {
    const registry = new TerminalContextRegistry();
    const listener = vi.fn();
    registry.onDidChangeActiveContext(listener);
    const firstContext: TerminalContext = {
      terminalId: 'terminal-a',
      server: server('a'),
      connected: true,
      write: vi.fn()
    };
    const sameContext: TerminalContext = {
      ...firstContext,
      write: vi.fn()
    };

    registry.setActive(firstContext);
    registry.setActive(sameContext);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps the context but marks it disconnected', () => {
    const registry = new TerminalContextRegistry();
    registry.setActive({
      terminalId: 'terminal-a',
      server: server('a'),
      connected: true,
      write: vi.fn()
    });

    registry.markDisconnected('terminal-a');

    expect(registry.getActive()?.connected).toBe(false);
  });

  it('clears only the matching active terminal', () => {
    const registry = new TerminalContextRegistry();
    registry.setActive({
      terminalId: 'terminal-a',
      server: server('a'),
      connected: true,
      write: vi.fn()
    });

    registry.clearIfActive('terminal-b');
    expect(registry.getActive()?.terminalId).toBe('terminal-a');

    registry.clearIfActive('terminal-a');
    expect(registry.getActive()).toBeUndefined();
  });
});
