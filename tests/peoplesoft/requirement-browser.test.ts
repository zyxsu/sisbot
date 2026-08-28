import { describe, expect, it } from 'vitest';
import {
  parseRequirementChoices,
  parseRequirementCourses,
} from '../../src/peoplesoft/parsers/requirement-browser.js';

describe('requirement browser parsers', () => {
  it('returns every selectable requirement detail, not only Pharmacy Core', () => {
    const markup = `
      <div title="Requirement: Pharmacy Program">Parent requirement</div>
      <div role="row"><span title="Requirement Details: Pharmacy Core">Pharmacy- Core - Courses</span> Not Satisfied</div>
      <div role="row"><span title="Requirement Details: CLA General">CLA-General - Courses</span> Satisfied</div>
      <div role="row"><span title="Requirement Details: Pharmacy Core duplicate">Pharmacy- Core - Courses</span></div>
    `;

    expect(parseRequirementChoices(markup)).toEqual([
      { label: 'Pharmacy- Core - Courses', satisfied: false },
      { label: 'CLA-General - Courses', satisfied: true },
    ]);
  });

  it('parses and deduplicates courses from a selected requirement table', () => {
    const markup = `
      <table>
        <tr id="CRSE_GRID_LIST_NFF$0"><td><span id="CRSE_NAME1$0">cla 101</span></td><td><span id="CRSE_DESCR1$0">Academic Writing</span></td><td>Not Taken</td></tr>
        <tr id="CRSE_GRID_LIST_NFF$1"><td><span id="CRSE_NAME1$1">MAT 120</span></td><td><span id="CRSE_DESCR1$1">College Algebra</span></td><td>In Progress</td></tr>
        <tr id="CRSE_GRID_LIST_NFF$2"><td><span id="CRSE_NAME1$2">CLA 101</span></td></tr>
      </table>
    `;

    expect(parseRequirementCourses(markup)).toEqual([
      { courseCode: 'CLA 101', courseTitle: 'Academic Writing', progress: 'Not Taken' },
      { courseCode: 'MAT 120', courseTitle: 'College Algebra', progress: 'In Progress' },
    ]);
  });
});
