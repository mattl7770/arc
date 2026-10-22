import { Pressable, Text, View } from 'react-native';

import { Block, Divider } from '@/components/ui/block';
import { SectionLabel } from '@/components/ui/section-label';
import type { StoredProposal } from '@/lib/ai/proposals';

/**
 * Coach proposals, drawn — the changes the unattended Coach drafted, each with
 * Approve and Decline (src/lib/ai/proposals.ts). The same rows appear in two
 * places: inside Home's Coach card, and in the thread under the pass's record
 * of them. The Home card is already its own surface, so there the rows are
 * drawn bare; the thread wraps them in a plate ({@link ProposalRecord}).
 *
 * ## What a row says
 *
 * The card line is the tool's own `confirmSummary`, drawn by code when the pass
 * ran — the line a chat card would show for the same write — and under it the
 * Coach's one line of why. A removal says what Approve costs, as the chat card
 * does: the summary names the row, this says it does not come back.
 *
 * Once answered, the buttons give way to what happened, in the thread's own
 * words: "Saved to your record", "Declined, not saved", "Expired, not saved",
 * or the refusal itself — a draft whose row moved since it was drawn is
 * refused at the tap and says so.
 *
 * ## Accent
 *
 * None. Home's budget is the hero, the completion stamps and the active tab;
 * the Coach tab's is the composer. Approve is the label-voice bordered action
 * the reminders and nudges cards use, ink-secondary, 44pt — a draft is a
 * suggestion, not the one thing the screen exists to make you do. No signal
 * colour either: this is workflow state, and the signal palette is biology.
 */

function statusLine(p: StoredProposal): string | null {
  switch (p.status) {
    case 'approved':
      return 'Saved to your record';
    case 'declined':
      return 'Declined, not saved';
    case 'expired':
      return 'Expired, not saved';
    case 'refused':
      return `Not written: ${p.outcome ?? 'the card no longer matched'}`;
    default:
      return null;
  }
}

function Action({
  label,
  hint,
  onPress,
  disabled,
}: {
  label: string;
  hint: string;
  onPress: () => void;
  disabled: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={hint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className="min-h-[44px] flex-1 items-center justify-center border border-hairline px-2.5 active:opacity-60">
      <Text className="font-label text-[11px] font-semibold uppercase tracking-[1.2px] text-ink-secondary">
        {label}
      </Text>
    </Pressable>
  );
}

/** One draft: the card line, the why, and the answer or what became of it. */
export function ProposalRow({
  proposal,
  busy,
  onApprove,
  onDecline,
}: {
  proposal: StoredProposal;
  /** Some draft's tap is being answered: every Approve waits. */
  busy: boolean;
  onApprove: (id: string) => void;
  onDecline: (id: string) => void;
}) {
  const status = statusLine(proposal);
  const removing = proposal.snapshot.kind === 'delete';
  return (
    <View className="py-2.5">
      <Text className="font-serif text-[15px] leading-5 text-ink">{proposal.summary}</Text>
      <Text className="mt-1 font-serif text-[12px] leading-5 text-ink-secondary">
        {proposal.reason}
      </Text>
      {status === null ? (
        <>
          {removing || proposal.until ? (
            <Text className="mt-1 font-mono text-[10px] text-ink-muted">
              {[
                removing ? 'Deleted for good on Approve' : null,
                proposal.until ? `Open until ${proposal.until}` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </Text>
          ) : null}
          <View className="mt-2 flex-row gap-2">
            <Action
              label="Approve"
              hint={`Approve: ${proposal.summary}`}
              onPress={() => onApprove(proposal.id)}
              disabled={busy}
            />
            <Action
              label="Decline"
              hint={`Decline: ${proposal.summary}`}
              onPress={() => onDecline(proposal.id)}
              disabled={busy}
            />
          </View>
        </>
      ) : (
        <Text className="mt-1 font-mono text-[10px] text-ink-muted">{status}</Text>
      )}
    </View>
  );
}

/** The rows, ruled between, with no surface of their own (Home's card is one). */
export function ProposalRows({
  proposals,
  busyId,
  onApprove,
  onDecline,
}: {
  proposals: StoredProposal[];
  busyId: string | null;
  onApprove: (id: string) => void;
  onDecline: (id: string) => void;
}) {
  return (
    <View>
      {proposals.map((proposal, index) => (
        <View key={proposal.id}>
          <Divider first={index === 0} />
          <ProposalRow
            proposal={proposal}
            busy={busyId !== null}
            onApprove={onApprove}
            onDecline={onDecline}
          />
        </View>
      ))}
    </View>
  );
}

/**
 * The thread's record of a pass's drafts — a ruled plate, the device the
 * reminders and nudges cards use, because a set of decisions is a record.
 */
export function ProposalRecord(props: {
  proposals: StoredProposal[];
  busyId: string | null;
  onApprove: (id: string) => void;
  onDecline: (id: string) => void;
}) {
  if (props.proposals.length === 0) return null;
  const open = props.proposals.filter((p) => p.status === 'pending').length;
  return (
    <Block device="plate">
      <SectionLabel
        label="Drafted by the Coach"
        note={open === 0 ? 'closed' : open === 1 ? '1 to answer' : `${open} to answer`}
      />
      <View className="mt-1">
        <ProposalRows {...props} />
      </View>
    </Block>
  );
}
