import { expect, mock, test } from "bun:test";
import { copyInviteLink } from "../src/clipboard";

test("uses the modern clipboard when permitted", async () => {
  const writeText = mock(async (_text: string) => {});
  const copySelection = mock(() => true);
  expect(await copyInviteLink("invite-url", null, { clipboard: { writeText }, copySelection })).toBe(true);
  expect(writeText).toHaveBeenCalledWith("invite-url");
  expect(copySelection).not.toHaveBeenCalled();
});

test("copies the focused and selected link when the clipboard is missing on HTTP", async () => {
  const steps: string[] = [];
  const input = { focus: () => { steps.push("focus"); }, select: () => { steps.push("select"); } };
  expect(await copyInviteLink("invite-url", input, {
    copySelection: () => { steps.push("copy"); return true; },
  })).toBe(true);
  expect(steps).toEqual(["focus", "select", "copy"]);
});

test("clipboard rejection falls back and copy failure leaves a manual selection", async () => {
  const input = { focus: mock(() => {}), select: mock(() => {}) };
  const clipboard = { writeText: async () => { throw new Error("permission denied"); } };
  expect(await copyInviteLink("invite-url", input, { clipboard, copySelection: () => false })).toBe(false);
  expect(input.focus).toHaveBeenCalled();
  expect(input.select).toHaveBeenCalled();
  expect(await copyInviteLink("invite-url", input, {
    copySelection: () => { throw new Error("copy unavailable"); },
  })).toBe(false);
});
