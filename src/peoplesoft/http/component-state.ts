import { parseHiddenFields, type PeopleSoftHiddenFields } from '../parsers/hidden-fields.js';
import { assertValidPeopleSoftResponse } from '../parsers/component-response.js';

export interface ComponentStateTransition {
  previousStateNum: string | null;
  currentStateNum: string | null;
}

function decodeAssignmentValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  const quote = trimmed[0];
  const unquoted =
    (quote === '"' || quote === "'") && trimmed.at(-1) === quote ? trimmed.slice(1, -1) : trimmed;

  return unquoted
    .replace(/\\x([0-9a-f]{2})/gi, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/\\u([0-9a-f]{4})/gi, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/\\(['"\\])/g, '$1')
    .replace(/\\r/g, '\r')
    .replace(/\\n/g, '\n');
}

function absoluteComponentUrl(candidate: string, responseUrl?: string): string | null {
  try {
    const url = responseUrl === undefined ? new URL(candidate) : new URL(candidate, responseUrl);
    if (!/\/psc\/ps_\d+\//i.test(url.pathname)) return null;
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

export class PeopleSoftComponentState {
  private readonly fields: PeopleSoftHiddenFields = {};
  public componentUrl: string | null = null;
  public windowName: string | null = null;

  public get stateNum(): string | null {
    return this.fields.ICStateNum ?? null;
  }

  public get elementNum(): string | null {
    return this.fields.ICElementNum ?? null;
  }

  public get icsid(): string | null {
    return this.fields.ICSID ?? null;
  }

  public get icBcDomData(): string | null {
    return this.fields.ICBcDomData ?? null;
  }

  public updateFromResponse(markup: string, responseUrl?: string): ComponentStateTransition {
    assertValidPeopleSoftResponse(markup);
    const previousStateNum = this.stateNum;
    Object.assign(this.fields, parseHiddenFields(markup));

    const assignmentPattern =
      /(?:oDoc\.)?(win\d+)\.([A-Za-z][A-Za-z0-9_$]*)\.value\s*=\s*("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^;]+)\s*;/g;
    for (const match of markup.matchAll(assignmentPattern)) {
      if (match[1] !== undefined) this.windowName = match[1];
      if (match[2] !== undefined && match[3] !== undefined) {
        this.fields[match[2]] = decodeAssignmentValue(match[3]);
      }
    }

    // ps_newwin launcher responses often keep ps_newwin in the response URL but
    // render controls whose IDs are prefixed with the allocated window name
    // (for example, win15div...). Derive the dynamic window from that markup.
    if (this.windowName === null) {
      const renderedWindow = /\b(win(\d+))div[A-Za-z0-9_$]*/i.exec(markup);
      if (renderedWindow?.[1] !== undefined) this.windowName = renderedWindow[1];
    }

    if (responseUrl !== undefined) {
      this.componentUrl = absoluteComponentUrl(responseUrl) ?? this.componentUrl;

      const windowNumber = /^win(\d+)$/i.exec(this.windowName ?? '')?.[1];
      if (windowNumber !== undefined && /\/psc\/ps_newwin\//i.test(responseUrl)) {
        const allocatedUrl = responseUrl.replace(
          /\/psc\/ps_newwin\//i,
          `/psc/ps_${windowNumber}/`,
        );
        this.componentUrl = absoluteComponentUrl(allocatedUrl) ?? this.componentUrl;
      }
    }

    const urlPattern = /(?:https?:\/\/[^'"\s]+)?\/psc\/ps_\d+\/EMPLOYEE\/SA\/c\/[A-Z0-9_.]+\.GBL/gi;
    for (const match of markup.matchAll(urlPattern)) {
      const discovered = absoluteComponentUrl(match[0], responseUrl);
      if (discovered !== null) this.componentUrl = discovered;
    }

    return { previousStateNum, currentStateNum: this.stateNum };
  }

  public toFormData(
    action: string,
    additionalFields: Record<string, string> = {},
  ): Record<string, string> {
    if (action.trim().length === 0) throw new Error('PeopleSoft ICAction is required');

    return {
      ...this.fields,
      ICAJAX: '1',
      ICNAVTYPEDROPDOWN: '0',
      ICType:
        this.fields.ICType !== undefined && this.fields.ICType.length > 0
          ? this.fields.ICType
          : 'Panel',
      ICModelCancel: '0',
      ICXPos: '0',
      ICYPos: '0',
      ResponsetoDiffFrame: '-1',
      TargetFrameName: 'None',
      FacetPath: 'None',
      ICFocus: '',
      ICSaveWarningFilter: '0',
      ICChanged: '0',
      ICSkipPending: '0',
      ICAutoSave: '0',
      ICResubmit: '0',
      ICActionPrompt: 'false',
      ICTypeAheadID: '',
      ICDNDSrc: '',
      ICPanelName: '',
      ICFind: '',
      ICAddCount: '',
      ICAppClsData: '',
      ...additionalFields,
      ICAction: action,
    };
  }
}
