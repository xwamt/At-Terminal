import { describe, expect, it } from 'vitest';
import { detectHostApp } from '../../src/mcp/hostApp';

describe('detectHostApp', () => {
  it('detects kiro from extension path or app name', () => {
    expect(
      detectHostApp({
        extensionPath: 'C:/Users/alan/.kiro/extensions/local.at-terminal-mcp-0.2.10'
      })
    ).toBe('kiro');
    expect(detectHostApp({ appName: 'Kiro' })).toBe('kiro');
  });

  it('detects cursor from app name or extension path', () => {
    expect(detectHostApp({ appName: 'Cursor', uriScheme: 'cursor' })).toBe('cursor');
    expect(
      detectHostApp({
        extensionPath: 'C:/Users/alan/.cursor/extensions/local.at-terminal-mcp-0.2.10'
      })
    ).toBe('cursor');
  });

  it('detects vscode from uriScheme or app name', () => {
    expect(detectHostApp({ appName: 'Visual Studio Code', uriScheme: 'vscode' })).toBe('vscode');
    expect(detectHostApp({ uriScheme: 'vscode' })).toBe('vscode');
  });

  it('detects qoder, windsurf, and continue from signals', () => {
    expect(detectHostApp({ appName: 'Qoder' })).toBe('qoder');
    expect(detectHostApp({ appRoot: 'C:/Program Files/Windsurf' })).toBe('windsurf');
    expect(detectHostApp({ uriScheme: 'continue' })).toBe('continue');
  });

  it('prefers kiro over cursor when both signals appear', () => {
    expect(
      detectHostApp({
        appName: 'Cursor',
        extensionPath: 'C:/Users/alan/.kiro/extensions/local.at-terminal-mcp-0.2.10'
      })
    ).toBe('kiro');
  });

  it('returns unknown when no host signal matches', () => {
    expect(detectHostApp({})).toBe('unknown');
    expect(detectHostApp({ appName: 'Some Other IDE' })).toBe('unknown');
  });
});
