import type { Frame, Page } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { inspectMicrosoftTwoFactor } from '../../src/auth/microsoft-two-factor.js';

interface Snapshot {
  detected: boolean;
  displaySign: string | null;
  hasOtcInput: boolean;
}

function makeFrame(snapshot: Snapshot | null, url = 'https://login.microsoftonline.com/'): Frame {
  return {
    evaluate: vi.fn().mockResolvedValue(snapshot),
    url: vi.fn().mockReturnValue(url),
  } as unknown as Frame;
}

function makePage(frameGroups: Frame[][]): Page {
  const pages = frameGroups.map(
    (frames) =>
      ({
        frames: vi.fn().mockReturnValue(frames),
      }) as unknown as Page,
  );

  return {
    context: vi.fn().mockReturnValue({
      pages: vi.fn().mockReturnValue(pages),
    }),
  } as unknown as Page;
}

describe('inspectMicrosoftTwoFactor', () => {
  it('finds a delayed number-matching value in a child frame', async () => {
    const mainFrame = makeFrame({ detected: true, displaySign: null, hasOtcInput: false });
    const challengeFrame = makeFrame({
      detected: true,
      displaySign: '54',
      hasOtcInput: false,
    });

    const result = await inspectMicrosoftTwoFactor(makePage([[mainFrame, challengeFrame]]));

    expect(result).toEqual({ detected: true, displaySign: '54', hasOtcInput: false });
  });

  it('checks every page in the context so popup challenges are supported', async () => {
    const originalPageFrame = makeFrame({
      detected: false,
      displaySign: null,
      hasOtcInput: false,
    });
    const popupFrame = makeFrame({ detected: true, displaySign: '07', hasOtcInput: false });

    const result = await inspectMicrosoftTwoFactor(makePage([[originalPageFrame], [popupFrame]]));

    expect(result).toEqual({ detected: true, displaySign: '07', hasOtcInput: false });
  });

  it('preserves OTP detection when no number-matching value exists', async () => {
    const otpFrame = makeFrame({ detected: true, displaySign: null, hasOtcInput: true });

    const result = await inspectMicrosoftTwoFactor(makePage([[otpFrame]]));

    expect(result).toEqual({ detected: true, displaySign: null, hasOtcInput: true });
  });

  it('ignores inaccessible frames and continues inspecting the others', async () => {
    const inaccessibleFrame = {
      evaluate: vi.fn().mockRejectedValue(new Error('frame detached')),
      url: vi.fn().mockReturnValue('about:blank'),
    } as unknown as Frame;
    const challengeFrame = makeFrame({
      detected: true,
      displaySign: '9',
      hasOtcInput: false,
    });

    const result = await inspectMicrosoftTwoFactor(makePage([[inaccessibleFrame, challengeFrame]]));

    expect(result).toEqual({ detected: true, displaySign: '9', hasOtcInput: false });
  });
});
