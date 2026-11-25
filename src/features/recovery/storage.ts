import type { z } from 'zod';
const prefix = 'cmon-recovery:v1:';
const ownerKey = prefix + 'account';
const keyFor = (userId: string, scope: string) => prefix + JSON.stringify([userId, scope]);

export function recoveryAccount() {
  try {
    return localStorage.getItem(ownerKey);
  } catch {
    return undefined;
  }
}
export function clearRecovery(userId: string | null | undefined) {
  if (!userId) return;
  try {
    const accountPrefix = prefix + JSON.stringify([userId]).slice(0, -1) + ',';
    for (const key of Object.keys(localStorage))
      if (key.startsWith(accountPrefix)) localStorage.removeItem(key);
    if (localStorage.getItem(ownerKey) === userId) localStorage.removeItem(ownerKey);
  } catch {
    /* The UI reports unavailable storage when it next tries to write. */
  }
}
export function activateRecoveryAccount(
  userId: string | null,
  previousOwner: string | null | undefined,
) {
  try {
    // A /me response may arrive after another tab has established a new owner.
    // Revalidate that response instead of replacing the newer account's drafts.
    if (localStorage.getItem(ownerKey) !== previousOwner) return false;
    if (previousOwner === userId) return true;
    clearRecovery(previousOwner);
    if (localStorage.getItem(ownerKey) !== null) return false;
    if (userId) localStorage.setItem(ownerKey, userId);
  } catch {
    /* Reading the account must remain possible without storage. */
  }
  return true;
}
export function readRecovery<T>(userId: string, scope: string, schema: z.ZodType<T>): T | null {
  if (localStorage.getItem(ownerKey) !== userId) return null;
  const key = keyFor(userId, scope),
    raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    return schema.parse(JSON.parse(raw));
  } catch {
    localStorage.removeItem(key);
    return null;
  }
}
export function writeRecovery(userId: string, scope: string, value: unknown) {
  // A late callback from an old account cannot recreate cleared private data.
  if (localStorage.getItem(ownerKey) !== userId) throw new Error('Account changed');
  localStorage.setItem(keyFor(userId, scope), JSON.stringify(value));
}
export function removeRecovery(userId: string, scope: string) {
  localStorage.removeItem(keyFor(userId, scope));
}
