type CopyInput = Pick<HTMLInputElement, "focus" | "select">;
type ClipboardAccess = {
  clipboard?: Pick<Clipboard, "writeText">;
  copySelection: () => boolean;
};

/** Copy on HTTPS or LAN HTTP, leaving the link selected when manual copying is needed. */
export async function copyInviteLink(
  text: string,
  input: CopyInput | null,
  access: ClipboardAccess = { clipboard: navigator.clipboard, copySelection: () => document.execCommand("copy") },
): Promise<boolean> {
  try {
    if (access.clipboard?.writeText) {
      await access.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied or clipboard unavailable; select the link for the fallback.
  }
  input?.focus();
  input?.select();
  try {
    return !!input && access.copySelection();
  } catch {
    return false;
  }
}
