import { InMemoryCourseResolver, type ResolvedCourse } from './course-resolver.js';

export interface DiscoveredSection {
  classNumber: string;
  component: string;
}

export interface DiscoveredCourseCatalogEntry extends ResolvedCourse {
  courseCode: string;
  courseTitle: string;
  sections: readonly DiscoveredSection[];
}

/**
 * Sanitized course identifiers confirmed from authorized captures and live
 * read-only checks. No session, window, action, or authentication values belong
 * in this catalog.
 */
export const DISCOVERED_COURSE_CATALOG: readonly DiscoveredCourseCatalogEntry[] = [
  {
    courseCode: 'PHA 500',
    courseTitle: 'Pharmacoeconomics and Drug Marketing',
    subject: 'PHA',
    catalogNumber: '500',
    term: '2701',
    crseId: '000702',
    crseOfferNbr: '1',
    acadCareer: 'UGRD',
    institution: 'AUIB',
    sections: [
      { classNumber: '1494', component: 'Lecture' },
      { classNumber: '1495', component: 'Lecture' },
    ],
  },
  {
    courseCode: 'ENL 201',
    courseTitle: 'Academic Writing',
    subject: 'ENL',
    catalogNumber: '201',
    term: '2701',
    crseId: '000375',
    crseOfferNbr: '1',
    acadCareer: 'UGRD',
    institution: 'AUIB',
    sections: [
      { classNumber: '1243', component: 'Lecture' },
      { classNumber: '1244', component: 'Lecture' },
      { classNumber: '1245', component: 'Lecture' },
      { classNumber: '1246', component: 'Lecture' },
      { classNumber: '1247', component: 'Lecture' },
      { classNumber: '1249', component: 'Lecture' },
      { classNumber: '1250', component: 'Lecture' },
      { classNumber: '1251', component: 'Lecture' },
      { classNumber: '1254', component: 'Lecture' },
      { classNumber: '1255', component: 'Lecture' },
    ],
  },
  {
    courseCode: 'HCT 480',
    courseTitle: 'Marketing in the Healthcare Sector',
    subject: 'HCT',
    catalogNumber: '480',
    term: '2701',
    crseId: '000966',
    crseOfferNbr: '1',
    acadCareer: 'UGRD',
    institution: 'AUIB',
    sections: [{ classNumber: '1544', component: 'Lecture' }],
  },
];

export function createDiscoveredCourseResolver(): InMemoryCourseResolver {
  return new InMemoryCourseResolver(DISCOVERED_COURSE_CATALOG);
}
