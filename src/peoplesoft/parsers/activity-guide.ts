import { loadPeopleSoftMarkup, normalizePeopleSoftText } from './markup.js';

export const REVIEW_CLASS_SELECTION_SERVICE_ID = 'SSR_ENRL_SELECT_FL';

export interface ActivityGuideTarget {
  label: string | null;
  serviceId: string;
  /** A response-provided URL or JavaScript preprocessing reference. */
  preprocessingUrl: string;
  targetUrl: string | null;
  /** All query parameters, including transient Activity Guide identifiers. */
  parameters: Record<string, string>;
  /** Observed step metadata. Values are transient and must never be logged. */
  stepAttributes?: Record<string, string>;
}

function decodeCandidate(value: string): string {
  const htmlDecoded = value.replace(/&amp;/gi, '&').replace(/&#38;/g, '&').trim();

  if (!/%(?:2f|3a|3f|26|3d)/i.test(htmlDecoded)) {
    return htmlDecoded;
  }

  try {
    return decodeURIComponent(htmlDecoded);
  } catch {
    return htmlDecoded;
  }
}

function candidateFragments(value: string): string[] {
  const decoded = decodeCandidate(value);
  const fragments = [decoded];

  for (const match of decoded.matchAll(/["']([^"']+)["']/g)) {
    if (match[1] !== undefined) {
      fragments.push(match[1]);
    }
  }

  return [...new Set(fragments.map((fragment) => fragment.trim()).filter(Boolean))];
}

function queryParameters(candidate: string): URLSearchParams {
  const queryStart = candidate.indexOf('?');

  if (queryStart === -1) {
    return new URLSearchParams();
  }

  const query = candidate
    .slice(queryStart + 1)
    .split(/["'<>\s)]/, 1)[0]
    ?.replace(/&amp;/gi, '&');

  return new URLSearchParams(query ?? '');
}

function getParameterCaseInsensitive(
  parameters: URLSearchParams,
  requestedName: string,
): string | null {
  const normalizedName = requestedName.toUpperCase();

  for (const [name, value] of parameters.entries()) {
    if (name.toUpperCase() === normalizedName) {
      return value;
    }
  }

  return null;
}

function toParameterRecord(parameters: URLSearchParams): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [name, value] of parameters.entries()) {
    result[name] = value;
  }

  return result;
}

function collectParameters(values: readonly string[]): URLSearchParams {
  const collected = new URLSearchParams();

  for (const value of values) {
    for (const fragment of candidateFragments(value)) {
      for (const [name, parameterValue] of queryParameters(fragment).entries()) {
        collected.set(name, parameterValue);
      }
    }
  }

  return collected;
}

function findEmbeddedTarget(parameters: URLSearchParams): string | null {
  for (const [name, value] of parameters.entries()) {
    if (/(?:TARGET|REDIRECT).*URL/i.test(name) && value.length > 0) {
      return decodeCandidate(value);
    }
  }

  return null;
}

const REVIEW_COMPONENT_TARGET_PATTERN =
  /(?:https?:\/\/|\/)[^\s"'<>]*SSR_STUDENT_FL\.SSR_ENRL_SELECT_FL\.GBL(?:\?[^\s"'<>]*)?/i;

function findReviewComponentTarget(value: string): string | null {
  for (const candidate of candidateFragments(value)) {
    const match = REVIEW_COMPONENT_TARGET_PATTERN.exec(decodeCandidate(candidate));

    if (match !== null) {
      return match[0].replace(/[),;]+$/, '');
    }
  }

  return null;
}

/**
 * Extracts the review-component URL from the separate AIPreProcessing response.
 * The exact envelope is intentionally not assumed; only the observed component
 * name is treated as stable enough to identify the returned target.
 */
export function parseActivityGuidePreprocessingTarget(markup: string): string | null {
  const $ = loadPeopleSoftMarkup(markup);
  const candidates = [markup];

  $('*').each((_index, element) => {
    const candidateElement = $(element);

    for (const attribute of ['href', 'value', 'data-url', 'data-target-url'] as const) {
      const value = candidateElement.attr(attribute);

      if (value !== undefined && value.length > 0) {
        candidates.push(value);
      }
    }
  });

  $('script, target-url, redirect-url, url').each((_index, element) => {
    const value = $(element).text().trim();

    if (value.length > 0) {
      candidates.push(value);
    }
  });

  for (const candidate of candidates) {
    const target = findReviewComponentTarget(candidate);

    if (target !== null) {
      return target;
    }
  }

  return null;
}

/**
 * Parses a rendered Activity Guide step and retains its response-provided query
 * parameters verbatim. This intentionally makes no assumptions about names or
 * values of temporary list, item, instance, or window identifiers.
 */
export function parseActivityGuide(
  markup: string,
  requestedServiceId = REVIEW_CLASS_SELECTION_SERVICE_ID,
): ActivityGuideTarget | null {
  const $ = loadPeopleSoftMarkup(markup);
  const attributes = [
    'href',
    'action',
    'onclick',
    'value',
    'data-url',
    'data-preprocessing-url',
    'data-target-url',
  ] as const;
  const allCandidateValues: string[] = [];

  for (const element of $('*').toArray()) {
    const candidateElement = $(element);
    const values = attributes
      .map((attribute) => candidateElement.attr(attribute))
      .filter((value): value is string => value !== undefined && value.length > 0);

    allCandidateValues.push(...values);
  }

  for (const element of $('*').toArray()) {
    const candidateElement = $(element);
    const values = attributes
      .map((attribute) => candidateElement.attr(attribute))
      .filter((value): value is string => value !== undefined && value.length > 0);

    if (values.length === 0) {
      continue;
    }

    const fragments = values.flatMap((value) => candidateFragments(value));
    const parameters = collectParameters(values);
    const explicitServiceId = getParameterCaseInsensitive(parameters, 'SERVICEID');
    const referencesRequestedService = fragments.some((fragment) =>
      fragment.toUpperCase().includes(requestedServiceId.toUpperCase()),
    );

    if (
      explicitServiceId?.toUpperCase() !== requestedServiceId.toUpperCase() &&
      !referencesRequestedService
    ) {
      continue;
    }

    const preprocessingReference =
      values.find(
        (value) =>
          value.toUpperCase().includes(requestedServiceId.toUpperCase()) &&
          /(?:AIPreProcessing|IScript_AIPreProcessing)/i.test(value),
      ) ?? values.find((value) => value.toUpperCase().includes(requestedServiceId.toUpperCase()));

    if (preprocessingReference === undefined) {
      continue;
    }

    let targetUrl = findEmbeddedTarget(parameters);

    if (targetUrl === null) {
      for (const value of allCandidateValues) {
        const target = findReviewComponentTarget(value);

        if (target !== null) {
          targetUrl = target;
          break;
        }
      }
    }

    const stepTitle = normalizePeopleSoftText(candidateElement.attr('steptitle') ?? '');
    const elementLabel = normalizePeopleSoftText(candidateElement.text());
    const stepAttributeNames = [
      'ptgpid',
      'stepnumber',
      'stepprogress',
      'steplabel',
      'steptitle',
    ] as const;
    const hasStepMetadata = stepAttributeNames.some(
      (attribute) => candidateElement.attr(attribute) !== undefined,
    );
    const stepAttributes: Record<string, string> = {};

    if (hasStepMetadata) {
      for (const attribute of ['id', ...stepAttributeNames] as const) {
        const value = candidateElement.attr(attribute);

        if (value !== undefined) {
          stepAttributes[attribute] = value;
        }
      }
    }

    return {
      label: stepTitle || elementLabel || null,
      serviceId: explicitServiceId ?? requestedServiceId,
      preprocessingUrl: decodeCandidate(preprocessingReference),
      targetUrl,
      parameters: toParameterRecord(parameters),
      ...(hasStepMetadata ? { stepAttributes } : {}),
    };
  }

  // Some PeopleSoft envelopes place the service reference inside a script/text
  // node rather than an interactive element. Preserve the previous generic
  // fallback without assuming a captured ID or parameter name.
  for (const element of $('script, target-url, redirect-url, url').toArray()) {
    const value = $(element).text().trim();

    if (value.toUpperCase().includes(requestedServiceId.toUpperCase())) {
      const parameters = collectParameters([value]);

      return {
        label: null,
        serviceId: getParameterCaseInsensitive(parameters, 'SERVICEID') ?? requestedServiceId,
        preprocessingUrl: decodeCandidate(value),
        targetUrl: findReviewComponentTarget(value),
        parameters: toParameterRecord(parameters),
      };
    }
  }

  return null;
}
