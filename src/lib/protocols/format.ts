/**
 * Display helpers for the Protocols screens — the human labels for the
 * `protocols.type` vocabulary (the text + CHECK enum in 0001_init.sql).
 */
import type { ProtocolType } from '@/lib/db/types';

/** Every schema type, in the order the editor's chips present them. */
export const PROTOCOL_TYPES: { type: ProtocolType; label: string }[] = [
  { type: 'daily_routine', label: 'Daily routine' },
  { type: 'supplement_stack', label: 'Supplement stack' },
  { type: 'meal_template', label: 'Meal template' },
  { type: 'training_block', label: 'Training block' },
  { type: 'therapy_protocol', label: 'Therapy' },
  { type: 'sleep_protocol', label: 'Sleep' },
  { type: 'other', label: 'Other' },
];

export function protocolTypeLabel(type: ProtocolType): string {
  return PROTOCOL_TYPES.find((t) => t.type === type)?.label ?? type;
}
