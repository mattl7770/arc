import { View } from 'react-native';

import type { SignalLevel } from '@/types/home';

/*
 * Tailwind's scanner only sees class names that appear literally in source, so
 * these maps hold whole class strings rather than building them from a prefix.
 */
const DOT: Record<SignalLevel, string> = {
  optimal: 'bg-signal-optimal',
  good: 'bg-signal-good',
  caution: 'bg-signal-caution',
  poor: 'bg-signal-poor',
  unknown: 'bg-signal-unknown',
};

const TEXT: Record<SignalLevel, string> = {
  optimal: 'text-signal-optimal',
  good: 'text-signal-good',
  caution: 'text-signal-caution',
  poor: 'text-signal-poor',
  unknown: 'text-ink-muted',
};

export function signalTextClass(level: SignalLevel): string {
  return TEXT[level];
}

/** Background class for surfaces that carry a signal colour (segment bars). */
export function signalBgClass(level: SignalLevel): string {
  return DOT[level];
}

/** The readiness colour, carried consistently everywhere it appears. */
export function SignalDot({ level, small = false }: { level: SignalLevel; small?: boolean }) {
  return <View className={`${small ? 'h-1.5 w-1.5' : 'h-2.5 w-2.5'} rounded-full ${DOT[level]}`} />;
}
