import { load } from 'cheerio';
import { expandPeopleSoftResponse } from './component-response.js';
import { normalizePeopleSoftText } from './markup.js';

export interface SectionAction {
  action: string;
  classNumber: string;
  component: string;
  label: string;
}

export interface PanelAction {
  action: string;
  value: 'CA' | 'CD';
}

export interface AvailabilityResult {
  courseCode: string;
  description: string;
  classNumber: string;
  component: string;
  status: string;
  capacity: number;
  enrollmentTotal: number;
  availableSeats: number;
  waitlistCapacity: number;
  waitlistTotal: number;
}

export class PeopleSoftComponentParseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PeopleSoftComponentParseError';
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function actionFromElement(attributes: Record<string, string | undefined>): string | null {
  const id = attributes.id?.trim();
  if (id !== undefined && id.length > 0) return id;
  const name = attributes.name?.trim();
  if (name !== undefined && name.length > 0) return name;

  const script = `${attributes.href ?? ''} ${attributes.onclick ?? ''}`;
  const match = /submitAction_[^(]*\([^,]+,\s*['"]([^'"]+)['"]\)/i.exec(script);
  const action = match?.[1]?.trim();
  return action === undefined || action.length === 0 ? null : action;
}

export function findSectionAction(markup: string, classNumber: string): SectionAction | null {
  const normalizedClassNumber = classNumber.trim();
  if (!/^\d{1,8}$/.test(normalizedClassNumber)) {
    throw new PeopleSoftComponentParseError('Class number must contain digits only');
  }

  const $ = load(expandPeopleSoftResponse(markup));
  const classPattern = new RegExp(`^(.+?)\\s*-\\s*${escapeRegExp(normalizedClassNumber)}$`, 'i');
  const matches = new Map<string, SectionAction>();

  $('a, button, input, [onclick]').each((_index, element) => {
    const node = $(element);
    const nodeText = node.text();
    const label = normalizePeopleSoftText(
      nodeText.trim().length > 0 ? nodeText : (node.attr('value') ?? ''),
    );
    const labelMatch = classPattern.exec(label);
    if (labelMatch?.[1] === undefined) return;

    const action = actionFromElement({
      id: node.attr('id'),
      name: node.attr('name'),
      href: node.attr('href'),
      onclick: node.attr('onclick'),
    });
    if (action === null) return;

    matches.set(action, {
      action,
      classNumber: normalizedClassNumber,
      component: normalizePeopleSoftText(labelMatch[1]),
      label,
    });
  });

  if (matches.size > 1) {
    throw new PeopleSoftComponentParseError(
      `Multiple section actions matched class ${normalizedClassNumber}`,
    );
  }

  return matches.values().next().value ?? null;
}

export function findPanelAction(markup: string, value: 'CA' | 'CD'): PanelAction | null {
  const $ = load(expandPeopleSoftResponse(markup));
  const actions = new Set<string>();

  $(`input[value="${value}"]`).each((_index, element) => {
    const node = $(element);
    const name = node.attr('name')?.trim();
    const id = node.attr('id')?.trim();
    const action = name !== undefined && name.length > 0 ? name : id;
    if (action !== undefined && action.length > 0) actions.add(action);
  });

  if (actions.size > 1) {
    throw new PeopleSoftComponentParseError(`Multiple ${value} panel controls were found`);
  }

  const action = actions.values().next().value;
  return action === undefined ? null : { action, value };
}

function lastTextById(markup: string, id: string): string {
  const $ = load(markup);
  const node = $(`[id="${id}"]`).last();
  const value = node.attr('value');
  return normalizePeopleSoftText(value !== undefined && value.length > 0 ? value : node.text());
}

function parseIntegerField(markup: string, fieldNumber: number): number {
  const id = `DERIVED_SSR_FL_SSR_DTL_FIELD${String(fieldNumber)}$0`;
  const value = lastTextById(markup, id);
  if (!/^\d+(?:\.0+)?$/.test(value)) {
    throw new PeopleSoftComponentParseError(
      `Availability field ${String(fieldNumber)} is missing or invalid`,
    );
  }
  return Number.parseInt(value, 10);
}

export function parseAvailability(
  markup: string,
  expectedClassNumber?: string,
): AvailabilityResult | null {
  const expanded = expandPeopleSoftResponse(markup);
  const $ = load(expanded);
  const selectedPanels = $('input[value="CA"], input[value="CD"]')
    .filter(
      (_index, element) => $(element).is(':checked') || $(element).attr('checked') !== undefined,
    )
    .toArray();
  const activePanel = selectedPanels.at(-1);

  if (activePanel === undefined || $(activePanel).attr('value') !== 'CA') return null;

  const courseText = lastTextById(expanded, 'DERIVED_SSR_FL_SSR_SBJ_CAT_NBR');
  const courseMatch = /^([A-Z]{2,5})\s*(\d{3,4}[A-Z]?)\s+(.+)$/i.exec(courseText);
  if (
    courseMatch?.[1] === undefined ||
    courseMatch[2] === undefined ||
    courseMatch[3] === undefined
  ) {
    throw new PeopleSoftComponentParseError('Course code and description are missing');
  }

  const classText = lastTextById(expanded, 'DERIVED_SSR_FL_SSR_SESSION_TRAN');
  const classMatch = /^(.+?)\s*-\s*(\d{1,8})$/.exec(classText);
  if (classMatch?.[1] === undefined || classMatch[2] === undefined) {
    throw new PeopleSoftComponentParseError('Component and class number are missing');
  }

  if (expectedClassNumber !== undefined && classMatch[2] !== expectedClassNumber.trim()) {
    throw new PeopleSoftComponentParseError(
      `Availability response is for class ${classMatch[2]}, not ${expectedClassNumber.trim()}`,
    );
  }

  const statusText = lastTextById(expanded, 'DERIVED_SSR_FL_SSR_CLASS_SPECS');
  const statusMatch = /\bStatus\s*:\s*(.+)$/i.exec(statusText);
  if (statusMatch?.[1] === undefined) {
    throw new PeopleSoftComponentParseError('Class status is missing');
  }

  return {
    courseCode: `${courseMatch[1].toUpperCase()} ${courseMatch[2].toUpperCase()}`,
    description: normalizePeopleSoftText(courseMatch[3]),
    classNumber: classMatch[2],
    component: normalizePeopleSoftText(classMatch[1]),
    status: normalizePeopleSoftText(statusMatch[1]),
    capacity: parseIntegerField(expanded, 1),
    enrollmentTotal: parseIntegerField(expanded, 2),
    availableSeats: parseIntegerField(expanded, 3),
    waitlistCapacity: parseIntegerField(expanded, 4),
    waitlistTotal: parseIntegerField(expanded, 5),
  };
}
