import { test, expect } from "@playwright/test";

const runtimeErrors = new WeakMap();

test.beforeEach(async ({ context, page }) => {
  // Every Playwright test gets a fresh context. Seed only onboarding state so
  // coach marks cannot cover the controls under test; project data remains
  // isolated while a same-test reload can still prove persistence.
  await context.addInitScript(() => {
    try {
      localStorage.setItem("sxratch.toured", "1");
      localStorage.setItem("sxratch.dawtoured", "1");
      localStorage.setItem("sxratch.daw-tour.v1", JSON.stringify({
        v: 1,
        index: 0,
        currentId: null,
        started: true,
        done: true,
        outcome: "skipped",
      }));
    } catch {
      // Storage can be unavailable on the initial opaque document. The same
      // script runs again once the app origin exists.
    }
  });

  const errors = [];
  runtimeErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
});

test.afterEach(async ({ page }) => {
  expect(runtimeErrors.get(page), "the app should not emit runtime errors").toEqual([]);
});

function viewNavigation(page) {
  return page.getByRole("navigation", { name: "View" });
}

async function unlockCurrentPage(page) {
  await expect(page).toHaveTitle(/Sxratch \/ Pad/i);
  const enter = page.getByRole("button", { name: "Enter the booth", exact: true });
  await expect(enter).toBeVisible();
  await enter.click();
  await expect(page.locator("#start-overlay")).toBeHidden();
  await expect(page.getByRole("region", { name: "Sxratch dual-deck controller" })).toBeVisible();
}

async function openAndUnlock(page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await unlockCurrentPage(page);
}

async function openStudio(page) {
  const nav = viewNavigation(page);
  await nav.getByRole("button", { name: "STUDIO", exact: true }).click();
  await expect(page.locator("#studio")).toBeVisible();
  await expect(page.getByRole("heading", { name: /PAD.*Studio/i })).toBeVisible();
  await expect(page.getByRole("spinbutton", { name: /^bpm$/i })).toBeVisible();
}

test.describe("@source source application", () => {
  test("unlocks the booth and switches between SXRATCH and Studio", async ({ page }) => {
    await openAndUnlock(page);

    const nav = viewNavigation(page);
    const decksButton = nav.getByRole("button", { name: "SXRATCH", exact: true });
    const studioButton = nav.getByRole("button", { name: "STUDIO", exact: true });

    await expect(decksButton).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#console")).toBeVisible();
    await expect(page.locator("#studio")).toBeHidden();

    await openStudio(page);
    await expect(page.locator("body")).toHaveClass(/view-studio/);
    await expect(page.locator("#console")).toBeHidden();
    await expect(page.getByRole("button", { name: "Play / stop (Space)", exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Add track", exact: true })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Audio input and monitoring" })).toBeVisible();
    await expect(page.getByRole("grid", { name: "Piano roll note grid" })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Sound designer" })).toBeVisible();
    expect(await page.locator(".daw-head-name").evaluateAll((names) => names.map((name) => name.value)))
      .toEqual(["Chords", "Bass", "Drums"]);
    await expect(page.locator(".daw-head-kind")).toHaveText(["Analog Pad", "Sub Bass", "Studio Kit"]);
    expect(await page.locator(".daw-ruler-bar").evaluateAll((bars) => bars.slice(0, 4).map((bar) => bar.textContent?.trim())))
      .toEqual(["1", "5", "9", "13"]);

    await page.locator(".daw-file summary").click();
    await page.getByRole("button", { name: "Open recording and MIDI setup", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Studio setup", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Enable audio inputs", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close studio setup", exact: true }).click();

    const commandMenu = page.locator(".daw-file");
    if (await commandMenu.getAttribute("open") === null) await commandMenu.locator("summary").click();
    await expect(page.getByRole("button", { name: "Import MIDI (.mid)", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Export portable project (.sxpad)", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "PAD Studio", exact: true }).click();
    await expect(decksButton).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#console")).toBeVisible();
    await expect(page.locator("#studio")).toBeHidden();
  });

  test("loads the built-in deck demos", async ({ page }) => {
    await openAndUnlock(page);

    const deckA = page.getByRole("region", { name: "Deck A" });
    const deckB = page.getByRole("region", { name: "Deck B" });

    await page.getByRole("button", { name: /LOAD DEMO BEAT/ }).click();
    await expect(deckA.getByText("Demo Beat (100 BPM)", { exact: true })).toBeVisible();
    await expect(deckA.getByRole("button", { name: /PLAY$/ })).toBeEnabled();

    await page.getByRole("button", { name: /LOAD SCRATCH SOUND/ }).click();
    await expect(deckB.getByText("Scratch Tool (Synth)", { exact: true })).toBeVisible();
    await expect(deckB.getByRole("button", { name: /PLAY$/ })).toBeEnabled();
  });

  test("persists DAW edits across a reload", async ({ page }) => {
    await openAndUnlock(page);
    await openStudio(page);

    const bpm = page.getByRole("spinbutton", { name: /^bpm$/i });
    const firstTrackName = page.getByRole("textbox", { name: "Track name" }).first();

    await bpm.fill("133");
    await bpm.press("Tab");
    await firstTrackName.fill("Smoke Keys");
    await firstTrackName.press("Tab");

    const saveStatus = page.locator(".daw-status-save");
    // A fast IndexedDB transaction can advance straight from the previous
    // Saved state to Saved again between Playwright polls. The durable state,
    // rather than a transient status frame, is what this regression covers.
    await expect(saveStatus).toHaveText(/^(Saving|Saved|Saved locally)$/);
    await expect(saveStatus).toHaveText(/^(Saved|Saved locally)$/);

    await page.reload({ waitUntil: "domcontentloaded" });
    await unlockCurrentPage(page);
    await openStudio(page);

    await expect(page.getByRole("spinbutton", { name: /^bpm$/i })).toHaveValue("133");
    await expect(page.getByRole("textbox", { name: "Track name" }).first()).toHaveValue("Smoke Keys");
  });
});

test.describe("@dist production distribution", () => {
  test("boots the prebuilt application", async ({ page }) => {
    await openAndUnlock(page);

    await expect(viewNavigation(page).getByRole("button", { name: "SXRATCH", exact: true }))
      .toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("region", { name: "Deck A" })).toContainText("No track loaded");
    await expect(page.getByRole("region", { name: "Deck B" })).toContainText("No track loaded");
  });
});
