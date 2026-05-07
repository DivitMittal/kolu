/** Saved-session store helpers shared by the session domain and surface cell. */

import type { SavedSession } from "kolu-common/surface";
import { store } from "./state.ts";

/** Pending autosave timer — explicit session writes cancel it before persist. */
let saveTimer: ReturnType<typeof setTimeout> | undefined;

/** Get the saved session, or null if none exists. */
export function getSavedSession(): SavedSession | null {
  const session = store.get("session");
  if (!session || session.terminals.length === 0) return null;
  return session;
}

/** Cancel a queued session auto-save before an explicit session write. */
export function cancelPendingSessionAutoSave(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = undefined;
  }
}

/** Schedule one autosave in the current quiet period. */
export function scheduleSessionAutoSave(save: () => void): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    save();
  }, 500);
}
