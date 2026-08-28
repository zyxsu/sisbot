import type { Frame, Page } from 'playwright-core';

export interface MicrosoftTwoFactorSnapshot {
  detected: boolean;
  displaySign: string | null;
  hasOtcInput: boolean;
}

interface FrameSnapshot {
  detected: boolean;
  displaySign: string | null;
  hasOtcInput: boolean;
}

const INSPECT_FRAME_SCRIPT = String.raw`
  (function () {
    var bodyText = document.body ? (document.body.innerText || document.body.textContent || '') : '';
    var challengePattern = /approve\s+(?:a\s+)?(?:sign[- ]?in\s+)?request|check\s+your\s+(?:microsoft\s+)?authenticator|open\s+your\s+(?:microsoft\s+)?authenticator|we(?:'ve| have)\s+sent\s+a\s+notification|enter\s+(?:the\s+)?code|verify\s+your\s+identity|help\s+us\s+protect\s+your\s+account|number\s+shown\s+below|enter\s+the\s+number\s+if\s+prompted|are\s+you\s+trying\s+to\s+sign\s+in/i;
    var displaySelectors = [
      '#idRichContext_DisplaySign',
      '.displaySign',
      '[data-test-id="richContextDisplaySign"]',
      '#idRemoteNGC_DisplaySign',
      '[class*="displaySign"]',
      '[id*="displaySign"]',
      '[id*="DisplaySign"]'
    ];
    var hasOtcInput = document.querySelector(
      'input[name="otc"], input[type="tel"], #idTxtBx_SAOTCC_OTC, #idTxtBx_SAOTCS_ProofConfirmation'
    ) !== null;
    var hasChallengeText = challengePattern.test(bodyText);

    function candidateFromElement(element) {
      var values = [
        element.textContent || '',
        element.innerText || '',
        typeof element.value === 'string' ? element.value : '',
        element.getAttribute('aria-label') || ''
      ];
      for (var valueIndex = 0; valueIndex < values.length; valueIndex += 1) {
        var value = values[valueIndex].trim();
        var exact = value.match(/^\D*(\d{1,2})\D*$/);
        if (exact && exact[1]) return exact[1];
      }
      return null;
    }

    for (var selectorIndex = 0; selectorIndex < displaySelectors.length; selectorIndex += 1) {
      var elements = Array.from(document.querySelectorAll(displaySelectors[selectorIndex]));
      for (var elementIndex = 0; elementIndex < elements.length; elementIndex += 1) {
        var directCandidate = candidateFromElement(elements[elementIndex]);
        if (directCandidate !== null) {
          return { detected: true, displaySign: directCandidate, hasOtcInput: hasOtcInput };
        }
      }
    }

    if (hasChallengeText) {
      var challengeRoots = Array.from(document.querySelectorAll(
        '#lightbox, [role="dialog"], [role="main"], #idDiv_SAOTCAS_Description, #idSpan_SAOTCAS_Description, main'
      ));
      if (challengeRoots.length === 0 && document.body) challengeRoots.push(document.body);

      for (var rootIndex = 0; rootIndex < challengeRoots.length; rootIndex += 1) {
        var leaves = Array.from(challengeRoots[rootIndex].querySelectorAll('div, span, p, h1, h2, h3, output, input'));
        for (var leafIndex = 0; leafIndex < leaves.length; leafIndex += 1) {
          var leaf = leaves[leafIndex];
          if (leaf.children.length === 0) {
            var leafCandidate = candidateFromElement(leaf);
            if (leafCandidate !== null) {
              return { detected: true, displaySign: leafCandidate, hasOtcInput: hasOtcInput };
            }
          }
        }
      }
    }

    return {
      detected: hasChallengeText || hasOtcInput || document.querySelector(displaySelectors.join(',')) !== null,
      displaySign: null,
      hasOtcInput: hasOtcInput
    };
  })()
`;

function allFrames(page: Page): Frame[] {
  const pages = page.context().pages();
  const frames: Frame[] = [];

  for (const contextPage of pages) {
    frames.push(...contextPage.frames());
  }

  return frames;
}

export async function inspectMicrosoftTwoFactor(page: Page): Promise<MicrosoftTwoFactorSnapshot> {
  let detected = false;
  let hasOtcInput = false;

  for (const frame of allFrames(page)) {
    const snapshot = (await frame
      .evaluate(INSPECT_FRAME_SCRIPT)
      .catch(() => null)) as FrameSnapshot | null;

    if (snapshot === null) continue;

    detected = detected || snapshot.detected || /\/SAS\/|proof/i.test(frame.url());
    hasOtcInput = hasOtcInput || snapshot.hasOtcInput;

    if (snapshot.displaySign !== null && /^\d{1,2}$/.test(snapshot.displaySign)) {
      return { detected: true, displaySign: snapshot.displaySign, hasOtcInput };
    }
  }

  return { detected, displaySign: null, hasOtcInput };
}

export async function clickMicrosoftPushOption(page: Page): Promise<boolean> {
  const selector =
    '#idDiv_SAOTCS_Proofs .table-row, [data-value="PhoneAppNotification"], div[role="button"]:has-text("Approve a request"), div[role="button"]:has-text("Authenticator"), [data-value="PhoneAppNotification"]';

  for (const frame of allFrames(page)) {
    const option = frame.locator(selector).first();
    if (await option.isVisible().catch(() => false)) {
      await option.click();
      return true;
    }
  }

  return false;
}
