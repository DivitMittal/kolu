import { Then, When } from "@cucumber/cucumber";
import { type KoluWorld, POLL_TIMEOUT } from "../support/world.ts";

const CHIP_SELECTOR =
  '[data-testid="canvas-tile"][data-active="true"] [data-testid="terminal-icon-chip"]';
const POPOVER_SELECTOR = '[data-testid="terminal-icon-popover"]';

When("I open the terminal icon picker", async function (this: KoluWorld) {
  const chip = this.page.locator(CHIP_SELECTOR).first();
  await chip.waitFor({ state: "visible", timeout: POLL_TIMEOUT });
  await chip.click({ force: true });
  await this.page
    .locator(POPOVER_SELECTOR)
    .waitFor({ state: "visible", timeout: POLL_TIMEOUT });
});

When(
  "I pick the icon {string} from the quick row",
  async function (this: KoluWorld, glyph: string) {
    const button = this.page
      .locator(`${POPOVER_SELECTOR} [data-glyph="${glyph}"]`)
      .first();
    await button.waitFor({ state: "visible", timeout: POLL_TIMEOUT });
    await button.click({ force: true });
    await this.waitForFrame();
  },
);

When(
  "I type {string} into the custom icon input",
  async function (this: KoluWorld, value: string) {
    const input = this.page.locator(
      `${POPOVER_SELECTOR} [data-testid="terminal-icon-custom"]`,
    );
    await input.waitFor({ state: "visible", timeout: POLL_TIMEOUT });
    await input.fill(value);
  },
);

When("I clear the terminal icon", async function (this: KoluWorld) {
  const clearBtn = this.page.locator(
    `${POPOVER_SELECTOR} [data-testid="terminal-icon-clear"]`,
  );
  await clearBtn.waitFor({ state: "visible", timeout: POLL_TIMEOUT });
  await clearBtn.click({ force: true });
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
