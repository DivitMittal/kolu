import { Then, When } from "@cucumber/cucumber";
import { type KoluWorld, POLL_TIMEOUT } from "../support/world.ts";

const CHIP_SELECTOR =
  '[data-testid="canvas-tile"][data-active="true"] [data-testid="terminal-icon-chip"]';

When("I click the terminal icon chip", async function (this: KoluWorld) {
  const chip = this.page.locator(CHIP_SELECTOR).first();
  await chip.waitFor({ state: "visible", timeout: POLL_TIMEOUT });
  await chip.click({ force: true });
  await this.waitForFrame();
});

Then(
  "the active tile should show the icon {string}",
  async function (this: KoluWorld, expected: string) {
    await this.page.waitForFunction(
      (want) => {
        const chip = document.querySelector(
          '[data-testid="canvas-tile"][data-active="true"] [data-testid="terminal-icon-chip"] [data-testid="terminal-icon"]',
        );
        return chip?.textContent === want;
      },
      expected,
      { timeout: POLL_TIMEOUT },
    );
  },
);

Then(
  "the terminal icon chip should show the placeholder",
  async function (this: KoluWorld) {
    // Placeholder state: the chip is present, but no inner terminal-icon span
    // has rendered (`<Show fallback=...>` short-circuits to the "＋" glyph).
    await this.page.waitForFunction(
      () => {
        const chip = document.querySelector(
          '[data-testid="canvas-tile"][data-active="true"] [data-testid="terminal-icon-chip"]',
        );
        if (!chip) return false;
        return chip.querySelector('[data-testid="terminal-icon"]') === null;
      },
      undefined,
      { timeout: POLL_TIMEOUT },
    );
  },
);
