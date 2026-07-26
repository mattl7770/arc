/**
 * View-model + insert types for symptom logging (0004_symptoms.sql). Row type
 * mirrors the table; NewSymptom is what the capture screen passes to logSymptom
 * (ids/timestamps come from the DB).
 */
export type SymptomRow = {
  id: string;
  date: string;
  time: string | null;
  name: string;
  severity: number | null;
  body_area: string | null;
  notes: string | null;
  source: string;
  created_at: string;
  updated_at: string;
};

export type NewSymptom = {
  /** Local calendar day, YYYY-MM-DD. */
  date: string;
  /** Wall-clock HH:MM it occurred, or null when logged after the fact. */
  time?: string | null;
  name: string;
  /** Subjective 1–10 intensity, or null if unrated. */
  severity?: number | null;
  bodyArea?: string | null;
  notes?: string | null;
};
