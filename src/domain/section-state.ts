export type SectionStatus = 'OPEN' | 'CLOSED' | 'WAITLIST' | 'UNKNOWN';

export interface SectionState {
  term: string;
  termLabel?: string;

  courseCode: string;
  courseTitle?: string;
  crseId?: string;
  crseOfferNbr?: string;
  acadCareer?: string;
  institution?: string;

  classNumber: string;
  component?: string;

  status: SectionStatus;
  availableSeats: number | null;

  meetingDates?: string;
  schedule?: string;
  sessionName?: string;

  checkedAt: Date;
}
