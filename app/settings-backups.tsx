import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Pressable,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Block, Divider } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { nativeBackupStore, type SnapshotInfo } from '@/lib/backup/backup-file-store';
import {
  adoptRecoveryKey,
  getBackupKey,
  hydrateBackupKey,
  isBackupKeyPersistent,
  persistAdoptedKey,
  restoreSessionKey,
} from '@/lib/backup/key';
import { formatRecoveryCode, parseRecoveryCode } from '@/lib/backup/recovery-code';
import {
  createBackup,
  CURRENT_SNAPSHOT,
  lastBackupInfo,
  PREVIOUS_SNAPSHOT,
  restoreFromSnapshot,
  type RestoreOutcome,
} from '@/lib/backup/snapshot';
import { getDb } from '@/lib/db/client';
import { clockFromISO } from '@/lib/db/date';
import { isBackupEnabled, setBackupEnabled } from '@/lib/db/repositories/user';
import { shareExistingFile } from '@/lib/files/share-file';

/**
 * Settings › Backups — the encrypted snapshot's one surface
 * (docs/backups-subapp.md).
 *
 * ## What this screen is actually offering
 *
 * ARC's privacy ADR excluded the plaintext database and the photo directories
 * from the iCloud device backup, which bought absolute privacy and left the
 * owner with *zero durability*: a lost phone was a lost decade. This screen is
 * the resolution. The snapshot is `VACUUM INTO` + XChaCha20-Poly1305, written to
 * `Documents/backups/` — a directory that **deliberately DOES ride the device
 * backup**, because what rides it is ciphertext. "Nothing personal at rest in
 * any cloud" (CLAUDE.md §2) is satisfied by the bytes being unreadable, not by
 * their absence.
 *
 * ## The honesty rules it lives by
 *
 *   - **Never claim a backup that is not on disk.** Every status line here comes
 *     from `lastBackupInfo()`, which stats the actual file. There is no "last
 *     attempted" cursor and no optimistic state: if the stat returns null the
 *     screen says nothing was written.
 *   - **Never mint a key that cannot be persisted.** `ensureBackupKey` returns
 *     null rather than hold a key in memory for one session, because a snapshot
 *     encrypted under a key that dies with the process is not a backup, it is a
 *     landfill. When the Keychain module is absent this screen says so instead
 *     of writing an unopenable file.
 *   - **The restore is stated as what it is.** It REPLACES the database, it
 *     loses everything logged since the snapshot, and it needs the app closed
 *     and reopened. All three are in the confirmation, not in a footnote.
 *   - **The recovery code is the fallback, and it is dangerous.** It is the
 *     master key in Crockford base32; anyone holding it can read the backup
 *     file. So it is reveal-on-tap with the warning on the same screen, never
 *     printed by default.
 *
 * ## Conformed Set treatment
 *
 * Status carries its own action, so it is a **ruled plate**. The toggle, the
 * recovery code and the snapshot actions are lists of settings — plates. The
 * post-restore instruction is a **measured field**: it is a verdict about the
 * app's state, not a record. Explanations are **margin annotations**. The
 * recovery-code entry is a bare `TextInput` wearing the well's own tokens
 * (form b in block.tsx — a form is controls, not content).
 *
 * **Zero accent.** Settings spends none (00-design-spec.md §2), so the presence
 * mark, the restore control and the primary action are all neutral ink — even
 * the destructive one. Colour here would be interface chrome wearing a signal
 * that belongs to biology.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * `Aug 25 · 14:33` — the same stamp shape Settings › Apple Health uses. The
 * store stats a momentarily-unstattable file as `modifiedAt: 0`, and rendering
 * that sentinel as a 1970 date would be the screen fabricating a fact.
 */
function fmtStamp(ms: number): string {
  if (ms <= 0) return 'date unknown';
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()] ?? ''} ${d.getDate()} · ${clockFromISO(d.toISOString())}`;
}

/**
 * A file size a person can read. Deliberately coarse — the question a backup
 * size answers is "did it actually contain my database", and one decimal of a
 * megabyte settles that as well as seven digits do.
 */
function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

type Busy = 'backing-up' | 'restoring' | 'sharing' | null;

/** Stat of the previous-generation snapshot, or null when there is none. */
function statPrevious(): SnapshotInfo | null {
  const store = nativeBackupStore();
  if (!store || !store.available()) return null;
  return store.list().find((entry) => entry.name === PREVIOUS_SNAPSHOT) ?? null;
}

/**
 * One tappable line of the snapshot plate. Local rather than shared: the
 * settings index has its own `NavRow` for pushing to a destination, and these
 * rows ACT — they need a disabled state and a trailing spinner, which a
 * navigation row has no use for.
 */
function ActionRow({
  icon,
  label,
  sub,
  first,
  disabled,
  busy,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  sub: string;
  first?: boolean;
  disabled?: boolean;
  busy?: boolean;
  onPress: () => void;
}) {
  return (
    <View>
      <Divider first={first} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled: disabled === true }}
        disabled={disabled === true}
        onPress={onPress}
        className="min-h-[44px] flex-row items-center gap-3 py-3 active:opacity-60">
        <Ionicons
          name={icon}
          size={18}
          color={disabled ? palette.inkMuted : palette.inkSecondary}
        />
        <View className="flex-1">
          <Text className={`font-serif text-[15px] ${disabled ? 'text-ink-muted' : 'text-ink'}`}>
            {label}
          </Text>
          <Text className="mt-0.5 font-serif text-[12px] text-ink-muted">{sub}</Text>
        </View>
        {busy ? (
          <ActivityIndicator size="small" color={palette.ink} />
        ) : (
          <Ionicons name="chevron-forward" size={16} color={palette.inkMuted} />
        )}
      </Pressable>
    </View>
  );
}

export default function SettingsBackupsScreen() {
  // Held in state rather than called per render: the guarded require behind it
  // hands back a fresh object each time, and the store is either there for the
  // life of the process or it is not.
  const [store] = useState(() => nativeBackupStore());
  const storeAvailable = store !== null && store.available();

  const [enabled, setEnabled] = useState(() => isBackupEnabled(getDb()));
  const [last, setLast] = useState(() => lastBackupInfo());
  const [previous, setPrevious] = useState<SnapshotInfo | null>(() => statPrevious());
  const [busy, setBusy] = useState<Busy>(null);
  const [note, setNote] = useState<string | null>(null);

  // The recovery code is derived from the key mirror, so it is re-read rather
  // than kept: the key can appear (first backup mints it) or change (a recovery
  // code adopted during a restore) while this screen is mounted.
  const [code, setCode] = useState<string | null>(null);
  const [keyPersistent, setKeyPersistent] = useState(() => isBackupKeyPersistent());
  const [revealed, setRevealed] = useState(false);

  // The post-restore instruction, which is deliberately sticky: the swap has
  // already happened on disk and the running process is still holding the old
  // world, so anything that clears this line would be telling the user the job
  // is finished when it is not.
  const [restored, setRestored] = useState(false);
  const [codeEntry, setCodeEntry] = useState(false);
  const [draft, setDraft] = useState('');

  const readKey = useCallback(() => {
    const key = getBackupKey();
    setCode(key ? formatRecoveryCode(key) : null);
    setKeyPersistent(isBackupKeyPersistent());
  }, []);

  const refresh = useCallback(() => {
    setLast(lastBackupInfo());
    setPrevious(statPrevious());
    readKey();
  }, [readKey]);

  // The automatic pass runs at boot and on every foreground, and can finish
  // while this screen is mounted — the status line's whole contract is that it
  // comes from disk, so re-stat on focus and on foreground rather than only
  // after this screen's own actions.
  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh])
  );
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => sub.remove();
  }, [refresh]);

  // Pull the key out of the Keychain into the sync mirror. Done here rather than
  // at boot because this is the only screen that reads it — the backup path
  // itself goes through `ensureBackupKey`, which hydrates on its own.
  useEffect(() => {
    let alive = true;
    const run = async () => {
      try {
        await hydrateBackupKey();
      } catch {
        // The store degrades to memory-only by itself; `keyPersistent` below is
        // what tells the user, so there is nothing to report from here.
      }
      if (alive) readKey();
    };
    void run();
    return () => {
      alive = false;
    };
  }, [readKey]);

  const toggle = useCallback((next: boolean) => {
    setBackupEnabled(getDb(), next);
    setEnabled(next);
  }, []);

  const backUpNow = useCallback(async () => {
    if (busy !== null) return;
    setBusy('backing-up');
    setNote(null);
    try {
      const outcome = await createBackup(getDb());
      switch (outcome.status) {
        case 'done':
          setNote(`Backed up · ${fmtBytes(outcome.bytes)}`);
          break;
        case 'no-key':
          // Two honest reasons, one message each: the Keychain is unreachable,
          // or a snapshot exists that a fresh key must never be minted over.
          setNote(
            lastBackupInfo() !== null || statPrevious() !== null
              ? 'A snapshot exists but this iPhone has no key for it — restore it or enter your recovery code first'
              : 'No key could be stored — nothing was written'
          );
          break;
        case 'unavailable':
          setNote('Backups need the device build');
          break;
        case 'failed':
          setNote(`Failed · ${outcome.message}`);
          break;
      }
    } finally {
      setBusy(null);
      refresh();
    }
  }, [busy, refresh]);

  const exportSnapshot = useCallback(async () => {
    if (busy !== null) return;
    const uri = store?.uriFor(CURRENT_SNAPSHOT) ?? null;
    if (uri === null) {
      setNote('No snapshot to export');
      return;
    }
    setBusy('sharing');
    setNote(null);
    try {
      const result = await shareExistingFile(uri, {
        // No registered UTI for `.arcb`, and inventing one would only teach iOS
        // to hand the file to an app that cannot read it. `public.data` is the
        // honest answer: opaque bytes, offered to whatever the user picks.
        mimeType: 'application/octet-stream',
        uti: 'public.data',
        dialogTitle: 'ARC backup',
      });
      setNote(
        result === 'shared'
          ? 'Shared · the copy on this iPhone is untouched'
          : 'The share sheet rides the next build'
      );
    } finally {
      setBusy(null);
    }
  }, [busy, store]);

  const applyRestoreOutcome = useCallback((outcome: RestoreOutcome) => {
    switch (outcome.status) {
      case 'restored':
        setRestored(true);
        setCodeEntry(false);
        setDraft('');
        setNote(null);
        break;
      case 'no-snapshot':
        setNote('No snapshot on this iPhone');
        break;
      case 'unavailable':
        setNote('Backups need the device build');
        break;
      case 'no-key':
        // Offered the code path for the same reason 'bad-key' is: a device
        // restored from an iCloud backup can arrive with the snapshot and
        // without the Keychain item, and the code is the whole answer to that.
        setNote('No key on this iPhone — enter your recovery code');
        setCodeEntry(true);
        break;
      case 'bad-key':
        setNote('This iPhone’s key does not open that snapshot — enter your recovery code');
        setCodeEntry(true);
        break;
      case 'newer-schema':
        setNote('That snapshot was made by a newer version of ARC — update ARC first');
        break;
      case 'failed':
        setNote(`Restore failed · ${outcome.message}`);
        break;
    }
  }, []);

  const runRestore = useCallback(
    async (name: string) => {
      // Guarded HERE as well as at tap time: the confirm Alert is a native
      // async round-trip, so a fast double-tap can queue two accepted
      // confirmations — the second must find the first already running.
      if (busy !== null) return;
      setBusy('restoring');
      setNote(null);
      try {
        applyRestoreOutcome(await restoreFromSnapshot(name));
      } finally {
        setBusy(null);
        refresh();
      }
    },
    [applyRestoreOutcome, busy, refresh]
  );

  const confirmRestore = useCallback(
    (name: string, info: SnapshotInfo | null) => {
      if (busy !== null || info === null) return;
      const whichCopy = name === PREVIOUS_SNAPSHOT ? 'the PREVIOUS snapshot' : 'the snapshot';
      // The store stats an unreadable file as modifiedAt 0 — never present the
      // sentinel as a real date in a destructive confirmation.
      const fromClause =
        info.modifiedAt > 0 ? `${whichCopy} from ${fmtStamp(info.modifiedAt)}` : whichCopy;
      Alert.alert(
        'Restore from this backup?',
        `This REPLACES everything currently in ARC with ${fromClause}. Anything logged since then is lost. You will need to close ARC and reopen it to finish.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Replace my data', style: 'destructive', onPress: () => void runRestore(name) },
        ]
      );
    },
    [busy, runRestore]
  );

  const adoptAndRetry = useCallback(async () => {
    if (busy !== null) return;
    const key = parseRecoveryCode(draft);
    if (key === null) {
      setNote('That recovery code isn’t valid');
      return;
    }
    setBusy('restoring');
    setNote(null);
    // The typed code is used for THIS SESSION first and earns the Keychain only
    // by decrypting something. Writing it straight over the stored key would
    // destroy the one durable copy of a key that may still open every existing
    // snapshot — on the strength of a checksum that only proves the code is
    // well-formed, not that it is this install's key.
    const displaced = getBackupKey();
    try {
      if (!adoptRecoveryKey(key)) {
        setNote('That recovery code isn’t valid');
        return;
      }
      // Exactly one retry. The code already parsed and passed its checksum, so
      // if it still does not open the snapshot then it is not this snapshot's
      // key — and asking again cannot change that, it can only look like
      // progress.
      const outcome = await restoreFromSnapshot();
      if (outcome.status === 'restored') {
        const persisted = await persistAdoptedKey();
        applyRestoreOutcome(outcome);
        if (persisted === 'memory-only') {
          // The sticky field says the restore worked; this says the key does
          // not survive a relaunch — both are true, and the second is the one
          // that costs the user their data if it goes unsaid.
          setNote('Restored — but the key could not be stored. Keep your recovery code.');
        }
      } else {
        // The code opened nothing: put the session key back the way it was so
        // the device's real key (if any) keeps working.
        restoreSessionKey(displaced);
        applyRestoreOutcome(outcome);
      }
      readKey();
    } finally {
      setBusy(null);
      refresh();
    }
  }, [applyRestoreOutcome, busy, draft, readKey, refresh]);

  // `!restored` makes the post-restore state terminal: the database on disk is
  // no longer the one this process loaded, so every further action here would
  // re-enter it mid-swap. The screen keeps the instruction and stops offering
  // doors.
  const canAct = storeAvailable && busy === null && !restored;
  const hasSnapshot = last !== null;

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Backups" parent="Settings" />
      </View>

      {/* The restore verdict. A measured field, and it does not go away: the
          database on disk has already been swapped and this process is still
          running on the old one. */}
      {restored ? (
        <View className="mt-3">
          <Block device="field">
            <Text className="font-serif text-[16px] font-semibold text-ink">
              Close and reopen ARC to finish.
            </Text>
            <Text className="mt-1.5 font-serif text-[12.5px] leading-5 text-ink-secondary">
              The snapshot is in place on disk. ARC is still showing the data it loaded when it
              opened — swipe it away from the app switcher and start it again.
            </Text>
          </Block>
        </View>
      ) : null}

      {/* Status, and the one action that changes it. */}
      <View className="mt-3">
        <Block device="plate">
          {!storeAvailable ? (
            <>
              <Text className="font-serif text-[16px] font-semibold text-ink">
                Backups need the device build
              </Text>
              <Text className="mt-1 font-serif text-[12.5px] leading-5 text-ink-secondary">
                The file-system module isn&rsquo;t in this binary yet, so there is nowhere to write
                a snapshot. Run the next EAS build (docs/dev-build.md) and this screen goes live —
                nothing else to set up.
              </Text>
            </>
          ) : (
            <>
              <View className="flex-row items-center gap-2.5">
                {/* Square, ink, no accent — Settings spends none. */}
                <View className={`h-1.5 w-1.5 ${hasSnapshot ? 'bg-ink' : 'bg-hairline'}`} />
                <Text className="font-serif text-[16px] font-semibold text-ink">
                  {hasSnapshot ? 'Backed up' : 'No backup yet'}
                </Text>
              </View>
              <Text className="mt-2 font-mono text-[11px] text-ink-muted">
                {last
                  ? `${fmtStamp(last.modifiedAt)} · ${fmtBytes(last.size)}`
                  : 'Nothing written yet'}
              </Text>
              {!keyPersistent ? (
                <Text className="mt-2 font-serif text-[11px] leading-4 text-ink-muted">
                  The Keychain module isn&rsquo;t in this binary, so ARC won&rsquo;t create a key it
                  cannot store — a snapshot nobody can open is worse than no snapshot. This rides
                  the next build too.
                </Text>
              ) : null}

              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Back up now"
                accessibilityState={{ disabled: !canAct }}
                disabled={!canAct}
                onPress={() => void backUpNow()}
                className={`mt-4 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn py-3.5 ${
                  canAct ? 'bg-ink active:opacity-70' : 'border border-hairline bg-paper-dim'
                }`}>
                {busy === 'backing-up' ? (
                  <ActivityIndicator size="small" color={palette.paperHi} />
                ) : (
                  <Ionicons
                    name="archive-outline"
                    size={18}
                    color={canAct ? palette.paperHi : palette.inkMuted}
                  />
                )}
                <Text
                  className={`font-label text-[15px] font-semibold ${
                    canAct ? 'text-paper-hi' : 'text-ink-muted'
                  }`}>
                  {busy === 'backing-up' ? 'Encrypting…' : 'Back up now'}
                </Text>
              </Pressable>

              {/* The outcome, inline and measured. No toast: an outcome the user
                  has to catch in three seconds is an outcome they will miss.
                  While the recovery-code entry is open the line moves down to
                  sit with it — a verdict on what you just typed, printed four
                  sections above the field you typed it into, is a verdict
                  nobody reads. */}
              {note && !codeEntry ? (
                <Text className="mt-3 font-mono text-[11px] text-ink">{note}</Text>
              ) : null}
            </>
          )}
        </Block>
      </View>

      {/* The schedule. */}
      <View className="mt-8">
        <SectionLabel label="Schedule" />
        <View className="mt-3">
          <Block device="plate">
            {/* Not an `accessible` container — the Switch must stay individually
                focusable and toggleable for VoiceOver. */}
            <View className="min-h-[44px] flex-row items-center gap-3 py-3">
              <Ionicons name="time-outline" size={18} color={palette.inkSecondary} />
              <View className="flex-1">
                <Text className="font-serif text-[15px] text-ink">Automatic backups</Text>
                <Text className="mt-0.5 font-serif text-[12px] text-ink-muted">
                  Once a day, when ARC opens
                </Text>
              </View>
              <Switch
                accessibilityLabel="Automatic backups"
                value={enabled}
                disabled={restored}
                onValueChange={toggle}
                trackColor={{ true: palette.ink, false: palette.hairlineStrong }}
                ios_backgroundColor={palette.hairlineStrong}
              />
            </View>
          </Block>
        </View>

        <View className="mt-4">
          <Block device="margin">
            <Text className="font-serif text-[11px] leading-4 text-ink-muted">
              The snapshot is encrypted on this iPhone before it is written, and the encrypted file
              is the only thing that reaches your iCloud device backup. Apple stores bytes it cannot
              read; ARC keeps the key. Photos are not included — the originals are already in your
              Photos library, which has its own backup.
            </Text>
          </Block>
        </View>
      </View>

      {/* The key, in the one form a person can carry. */}
      <View className="mt-8">
        <SectionLabel label="Recovery code" />
        <View className="mt-3">
          <Block device="plate">
            {code === null ? (
              <View
                accessible
                accessibilityLabel="No recovery code yet. One is created with your first backup."
                className="min-h-[44px] flex-row items-center gap-3 py-3">
                <Ionicons name="key-outline" size={18} color={palette.inkMuted} />
                <View className="flex-1">
                  <Text className="font-serif text-[15px] text-ink-muted">No code yet</Text>
                  <Text className="mt-0.5 font-serif text-[12px] text-ink-muted">
                    One is created with your first backup
                  </Text>
                </View>
              </View>
            ) : (
              <>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={revealed ? 'Hide recovery code' : 'Show recovery code'}
                  onPress={() => setRevealed((on) => !on)}
                  className="min-h-[44px] flex-row items-center gap-3 py-3 active:opacity-60">
                  <Ionicons
                    name={revealed ? 'eye-off-outline' : 'eye-outline'}
                    size={18}
                    color={palette.inkSecondary}
                  />
                  <View className="flex-1">
                    <Text className="font-serif text-[15px] text-ink">Recovery code</Text>
                    <Text className="mt-0.5 font-serif text-[12px] text-ink-muted">
                      {revealed ? 'Tap to hide' : 'Tap to show'}
                    </Text>
                  </View>
                </Pressable>
                {revealed ? (
                  <>
                    <Divider />
                    <View className="py-3">
                      <Text className="font-serif text-[11px] leading-4 text-ink-muted">
                        This code unlocks your backup — anyone who has it can read your data.
                      </Text>
                      <Text selectable className="mt-2 font-mono text-[13px] leading-6 text-ink">
                        {code}
                      </Text>
                    </View>
                  </>
                ) : null}
              </>
            )}
          </Block>
        </View>

        <View className="mt-4">
          <Block device="margin">
            <Text className="font-serif text-[11px] leading-4 text-ink-muted">
              The key normally travels with your iPhone&rsquo;s Keychain, so restoring a new phone
              from an iCloud backup brings it along and you never need this. Write it down anyway:
              it is the only way into your backup if the Keychain does not survive the trip.
            </Text>
          </Block>
        </View>
      </View>

      {/* What you can do with the snapshot that exists. */}
      <View className="mt-8">
        <SectionLabel label="This snapshot" />
        <View className="mt-3">
          <Block device="plate">
            <ActionRow
              first
              icon="share-outline"
              label="Export backup file"
              sub={
                hasSnapshot ? 'Hand the encrypted file to somewhere else' : 'Nothing to export yet'
              }
              disabled={!canAct || !hasSnapshot}
              busy={busy === 'sharing'}
              onPress={() => void exportSnapshot()}
            />
            <ActionRow
              icon="refresh-outline"
              label="Restore from this backup"
              sub={hasSnapshot ? 'Replaces everything in ARC' : 'Nothing to restore from'}
              disabled={!canAct || !hasSnapshot}
              busy={busy === 'restoring'}
              onPress={() => confirmRestore(CURRENT_SNAPSHOT, last)}
            />
            {/* The second generation exists precisely for "the newest snapshot
                captured a database that was already wrong" — a copy that can
                never be selected is a copy that does not exist. */}
            {previous !== null ? (
              <ActionRow
                icon="return-down-back-outline"
                label="Restore the previous backup"
                sub={
                  previous.modifiedAt > 0
                    ? `One generation older · ${fmtStamp(previous.modifiedAt)}`
                    : 'One generation older'
                }
                disabled={!canAct}
                busy={false}
                onPress={() => confirmRestore(PREVIOUS_SNAPSHOT, previous)}
              />
            ) : null}
          </Block>
        </View>

        {/* The recovery-code entry, shown only when a restore actually needs it.
            The field IS the well (form b in block.tsx): a form is controls, not
            content, so it carries no device of its own. */}
        {codeEntry ? (
          <View className="mt-4">
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder="XXXX-XXXX-XXXX-…"
              placeholderTextColor={palette.inkMuted}
              autoCapitalize="characters"
              autoCorrect={false}
              multiline
              className="border border-paper-deep bg-paper-dim px-3.5 py-3 font-mono text-[13px] leading-6 text-ink"
              accessibilityLabel="Recovery code"
            />
            <View className="mt-3 flex-row items-center gap-2">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Unlock and restore"
                accessibilityState={{ disabled: busy !== null || draft.trim().length === 0 }}
                disabled={busy !== null || draft.trim().length === 0}
                onPress={() => void adoptAndRetry()}
                className={`min-h-[44px] flex-1 items-center justify-center rounded-btn py-3 ${
                  busy === null && draft.trim().length > 0
                    ? 'bg-ink active:opacity-70'
                    : 'border border-hairline bg-paper-dim'
                }`}>
                <Text
                  className={`font-label text-[14px] font-semibold ${
                    busy === null && draft.trim().length > 0 ? 'text-paper-hi' : 'text-ink-muted'
                  }`}>
                  Unlock and restore
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Cancel recovery code entry"
                onPress={() => {
                  setCodeEntry(false);
                  setDraft('');
                }}
                className="min-h-[44px] items-center justify-center rounded-btn border border-hairline px-4 py-3 active:bg-paper-dim">
                <Text className="font-label text-[14px] text-ink">Cancel</Text>
              </Pressable>
            </View>
            {note ? <Text className="mt-3 font-mono text-[11px] text-ink">{note}</Text> : null}
          </View>
        ) : null}

        <View className="mt-4">
          <Block device="margin">
            <Text className="font-serif text-[11px] leading-4 text-ink-muted">
              Restoring writes the snapshot over ARC&rsquo;s database and leaves the running app on
              the old copy until you close and reopen it. An older snapshot is brought up to the
              current schema on that next open, so a backup does not go stale.
            </Text>
          </Block>
        </View>
      </View>
    </Screen>
  );
}
