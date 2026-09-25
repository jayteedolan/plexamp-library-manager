// End-to-end smoke test against a running app wired to devtools/mock_services.py.
//
//   BASE_URL=http://127.0.0.1:8080 MOCK_URL=http://127.0.0.1:5031 SHOTS=./shots \
//   CHROMIUM=/path/to/chrome node e2e/smoke.mjs
//
// Covers: first-run setup, search ranking + "in library" hints, download progress, cancel → keep,
// filing into the suggested folder (after deleting an old track in the explorer), the targeted Plex
// scan, and explorer operations (new folder, rename, cut/paste, delete, restore) on a phone viewport.
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8080";
const MOCK = process.env.MOCK_URL ?? "http://127.0.0.1:5031";
const SHOTS = process.env.SHOTS ?? "./shots";
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const errors = [];
const step = (msg) => console.log(`• ${msg}`);
const expect = (cond, msg) => {
  if (!cond) throw new Error(`Expectation failed: ${msg}`);
};

async function newPage(viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: "dark" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && !m.text().includes("401") && errors.push(m.text()));
  return { ctx, page };
}

try {
  // ------------------------------------------------------------------ desktop: setup + search
  const { ctx, page } = await newPage({ width: 1366, height: 900 });
  await page.goto(BASE);
  await page.getByRole("heading", { name: "Create your admin account" }).waitFor();
  await page.screenshot({ path: `${SHOTS}/01-setup.png` });
  await page.getByLabel(/^Password/).fill("correct horse battery");
  await page.getByLabel("Repeat password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByRole("heading", { name: "Dashboard" }).waitFor();
  await page.getByText("Connected to Soulseek.").waitFor();
  step("admin account created, dashboard loaded");
  await page.screenshot({ path: `${SHOTS}/02-dashboard-desktop.png` });

  await page.getByRole("link", { name: "Search" }).first().click();
  await page.getByPlaceholder("Artist, album or track").fill("mock album");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByText("Search finished.").waitFor({ timeout: 20000 });
  const cards = page.locator("button[aria-expanded]");
  const firstCard = await cards.first().innerText();
  expect(firstCard.includes("FLAC 24/96") && firstCard.includes("flac_hoarder"), "lossless + fast user ranks first");
  const lastCard = await cards.last().innerText();
  expect(lastCard.includes("MP3 128"), "low bitrate ranks last");
  expect((await page.getByText("Partly in library").count()) > 0, "partial library hint shown");
  expect((await page.getByText("private_guy").count()) === 0, "locked folders hidden by default");
  step("search results ranked by quality then speed, with library hints");
  await page.screenshot({ path: `${SHOTS}/03-search-desktop.png`, fullPage: false });

  // Download everything from cd_ripper, then cancel part-way and keep what finished.
  const card = page.locator("div.rounded-xl", { has: page.getByText("cd_ripper") }).first();
  await card.getByRole("button", { name: "Download all" }).click();
  await page.getByText(/Queued 10 files/).waitFor();
  await page.getByRole("link", { name: "Downloads" }).first().click();
  await page.getByText("In progress").waitFor();
  await page.waitForTimeout(5500);
  await page.screenshot({ path: `${SHOTS}/04-downloads-progress.png` });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel download" }).click();
  const keep = page.getByRole("dialog").getByRole("button", { name: /^Keep \d+ file/ });
  await keep.waitFor();
  await page.screenshot({ path: `${SHOTS}/05-cancel-choice.png` });
  const keptLabel = await keep.innerText();
  const kept = Number(keptLabel.match(/\d+/)[0]);
  expect(kept > 0 && kept < 10, `some files finished before cancel (${kept})`);
  await keep.click();
  await page.getByText("Ready to file").first().waitFor();
  step(`cancelled part-way and kept ${kept} finished files`);

  // File into the suggested Some Artist/Mock Album folder, deleting an old track there first.
  await page.getByRole("button", { name: "File into library" }).click();
  await page.getByText("Suggested from tags").waitFor();
  await page.getByText("01 - Track 01.flac").waitFor();
  await page.screenshot({ path: `${SHOTS}/06-file-pick-destination.png` });
  await page.getByRole("button", { name: "Actions for 01 - Track 01.flac" }).click();
  await page.getByRole("menuitem", { name: "Move to Trash" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Move to Trash" }).click();
  await page.getByText("01 - Track 01.flac").waitFor({ state: "detached" });
  await page.getByRole("button", { name: new RegExp(`^File ${kept} files? here`) }).click();
  await page.getByText(/Filed \d+ files? into Library \/ Some Artist \/ Mock Album/).waitFor();
  await page.getByText("01 - Track 1.flac").waitFor();
  const calls = await (await fetch(`${MOCK}/_mock/plex-refresh-calls`)).json();
  expect(calls.at(-1)?.path === "/mnt/usb/Music/Some Artist/Mock Album", "targeted Plex scan of the album folder");
  step("filed into library and triggered a targeted Plex scan");
  await page.screenshot({ path: `${SHOTS}/07-library-after-filing.png` });
  await ctx.storageState({ path: `${SHOTS}/.state.json` });
  await ctx.close();

  // ------------------------------------------------------------------ phone: explorer + trash
  const phoneCtx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    colorScheme: "dark",
    storageState: `${SHOTS}/.state.json`,
  });
  const phone = await phoneCtx.newPage();
  phone.on("pageerror", (e) => errors.push(String(e)));
  await phone.goto(BASE);
  await phone.getByRole("heading", { name: "Dashboard" }).waitFor();
  await phone.screenshot({ path: `${SHOTS}/08-dashboard-phone.png`, fullPage: true });

  await phone.goto(`${BASE}/library`);
  await phone.getByText("Radiohead").waitFor();
  await phone.getByRole("button", { name: "New folder" }).click();
  await phone.getByRole("dialog").locator("input").fill("Temp Artist");
  await phone.getByRole("dialog").getByRole("button", { name: "Create" }).click();
  await phone.getByText("Temp Artist").waitFor();
  await phone.getByRole("button", { name: "Actions for Temp Artist" }).click();
  await phone.getByRole("menuitem", { name: "Rename" }).click();
  await phone.getByRole("dialog").locator("input").fill("Renamed Artist");
  await phone.getByRole("dialog").getByRole("button", { name: "Rename" }).click();
  await phone.getByText("Renamed Artist", { exact: true }).waitFor();
  step("created and renamed a folder on the phone");

  // Cut "Boards of Canada" and paste into "Renamed Artist".
  await phone.getByLabel("Select Boards of Canada").check();
  await phone.screenshot({ path: `${SHOTS}/09-explorer-phone-selection.png` });
  await phone.getByRole("button", { name: "Cut" }).click();
  await phone.getByText("Renamed Artist", { exact: true }).click();
  await phone.getByRole("button", { name: "Paste here" }).click();
  await phone.getByText(/Moved 1 item/).waitFor();
  await phone.getByText("Boards of Canada").waitFor();
  step("cut + paste moved a folder");

  // Delete it and restore from the Trash.
  await phone.getByRole("button", { name: "Actions for Boards of Canada" }).click();
  await phone.getByRole("menuitem", { name: "Move to Trash" }).click();
  await phone.getByRole("dialog").getByRole("button", { name: "Move to Trash" }).click();
  await phone.getByText(/Moved 1 item to the Trash/).waitFor();
  await phone.getByRole("link", { name: "Trash" }).click();
  await phone.getByText("Boards of Canada").waitFor();
  await phone.screenshot({ path: `${SHOTS}/10-trash-phone.png` });
  await phone.getByRole("button", { name: "Restore" }).first().click();
  await phone.getByText(/Restored to Library \/ Renamed Artist \/ Boards of Canada/).waitFor();
  step("deleted to Trash and restored");

  await phone.goto(`${BASE}/search`);
  await phone.getByPlaceholder("Artist, album or track").fill("kid a");
  await phone.getByRole("button", { name: "Search", exact: true }).click();
  await phone.getByText("Search finished.").waitFor({ timeout: 20000 });
  await phone.locator("button[aria-expanded]").first().click();
  await phone.screenshot({ path: `${SHOTS}/11-search-phone.png` });
  await phone.goto(`${BASE}/downloads`);
  await phone.getByRole("heading", { name: /History/ }).waitFor();
  await phone.screenshot({ path: `${SHOTS}/12-downloads-phone.png`, fullPage: true });
  await phoneCtx.close();

  expect(errors.length === 0, `no page errors (got: ${errors.join(" | ")})`);
  console.log("\nE2E smoke test passed.");
} catch (e) {
  console.error("\nE2E FAILED:", e.message);
  if (errors.length) console.error("Page errors:", errors);
  process.exitCode = 1;
} finally {
  await browser.close();
}
