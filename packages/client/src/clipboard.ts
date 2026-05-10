/**
 * Clipboard write with a fallback for non-secure contexts.
 *
 * `navigator.clipboard` is only defined in secure contexts (https, localhost,
 * 127.0.0.1). On plain http to any other host it is undefined, so direct
 * writes can throw `TypeError: Cannot read properties of undefined`.
 *
 * The fallback selects a hidden textarea and runs `document.execCommand("copy")`,
 * which works in any browsing context at the cost of a brief focus steal.
 */

import { toast } from "solid-sonner";

/** Write `text` to the system clipboard, falling back to execCommand when
 * navigator.clipboard is unavailable or throws. Throws if both paths fail. */
export async function writeTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to execCommand — navigator.clipboard can reject for
      // reasons other than missing secure context (permission denied, etc.).
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  try {
    textarea.select();
    const ok = document.execCommand("copy");
    if (!ok) throw new Error("clipboard access blocked");
  } finally {
    document.body.removeChild(textarea);
  }
}

/** Copy text and show a success/failure toast. */
export async function copyTextWithToast(
  text: string,
  messages: { success: string; failure: string },
): Promise<void> {
  try {
    await writeTextToClipboard(text);
    toast.success(messages.success);
  } catch (err) {
    console.error(`${messages.failure}:`, err);
    toast.error(`${messages.failure}: ${(err as Error).message}`);
  }
}
