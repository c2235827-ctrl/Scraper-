import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import puppeteer from "puppeteer";
// @ts-ignore
import qrcode from "qrcode-terminal";

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  let currentStatus: "idle" | "qr" | "scraping" | "done" | "error" = "idle";
  let extractedMembers: string[] = [];
  let currentQrCode: string | null = null;
  let browser: puppeteer.Browser | null = null;

  app.post("/scrape", async (req, res) => {
    const { link } = req.body;
    if (!link) {
      return res.status(400).json({ error: "Link is required" });
    }

    if (currentStatus === "qr" || currentStatus === "scraping") {
      return res.status(400).json({ error: "A scraping session is already in progress" });
    }

    currentStatus = "qr";
    extractedMembers = [];
    currentQrCode = null;
    res.json({ status: "qr" });

    try {
      const match = link.match(/chat\.whatsapp\.com\/([A-Za-z0-9]+)/);
      if (!match) throw new Error("Invalid WhatsApp group link");
      const inviteCode = match[1];

      browser = await puppeteer.launch({
        headless: true, // Reverted to true because the container lacks an X server
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
        defaultViewport: null,
      });

      const page = await browser.newPage();
      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
      );

      // Go to WhatsApp Web first (not the invite link — that can redirect weirdly)
      await page.goto("https://web.whatsapp.com", { 
        waitUntil: "domcontentloaded", 
        timeout: 120000 // 2 minutes timeout for slow loading
      });

      // Wait for QR code and expose it to the frontend
      const qrInterval = setInterval(async () => {
        if (currentStatus !== "qr") {
          clearInterval(qrInterval);
          return;
        }
        try {
          const qrData = await page.$eval('div[data-ref]', (el) =>
            el.getAttribute("data-ref")
          );
          if (qrData && qrData !== currentQrCode) {
            currentQrCode = qrData;
            console.log("\n=========================================");
            console.log("SCAN THIS QR CODE WITH WHATSAPP:");
            qrcode.generate(qrData, { small: true });
            console.log("=========================================\n");
          }
        } catch (_) {
          // QR element gone = logged in
        }
      }, 2000);

      // Wait for login (chat list appears)
      try {
        // Increased timeout to 5 minutes (300000ms) to give users plenty of time to scan the QR code and sync messages
        // We wait for the side pane which contains the chat list
        await page.waitForSelector('#pane-side', { timeout: 300000 });
      } catch (e) {
        throw new Error("Login timed out. Please ensure you scan the QR code within 5 minutes.");
      }
      
      clearInterval(qrInterval);
      currentQrCode = null;
      currentStatus = "scraping";

      console.log("✅ Logged in. Navigating to group...");

      // Now navigate to the invite link to open the group directly in WhatsApp Web
      await page.goto(`https://web.whatsapp.com/accept?code=${inviteCode}`, {
        waitUntil: "domcontentloaded",
        timeout: 120000
      });

      // Wait for the group chat to load
      try {
        await page.waitForSelector("#main", { timeout: 120000 });
      } catch (e) {
        throw new Error("Failed to load the group chat. The invite link might be invalid or expired.");
      }
      await sleep(2000);

      // Click the group header to open the info panel
      console.log("📋 Opening group info panel...");
      await page.click("#main header");
      await sleep(2000);

      // Wait for the right drawer / info panel to open
      await page.waitForSelector('[data-testid="drawer-right"]', { timeout: 15000 });
      await sleep(1500);

      // Scroll the right drawer panel to load ALL virtualized participants
      console.log("⬇️  Scrolling to load all members...");
      const totalScrolls = 60; // Handles groups up to ~500 members
      for (let i = 0; i < totalScrolls; i++) {
        await page.evaluate(() => {
          const panel = document.querySelector('[data-testid="drawer-right"]');
          if (panel) panel.scrollTop += 400;
        });
        await sleep(200);
      }

      // Scroll back to top and do it again (to catch late-loading items)
      await page.evaluate(() => {
        const panel = document.querySelector('[data-testid="drawer-right"]');
        if (panel) panel.scrollTop = 0;
      });
      await sleep(500);

      for (let i = 0; i < totalScrolls; i++) {
        await page.evaluate(() => {
          const panel = document.querySelector('[data-testid="drawer-right"]');
          if (panel) panel.scrollTop += 400;
        });
        await sleep(150);
      }

      await sleep(1000);

      // Extract all participant names/numbers from the info panel
      console.log("📤 Extracting members...");
      const members = await page.evaluate(() => {
        const results = new Set<string>();

        // Primary selector: participant cell titles in the drawer
        const selectors = [
          '[data-testid="drawer-right"] [data-testid="cell-frame-title"] span',
          '[data-testid="drawer-right"] ._21S-L span[dir="auto"]',
          '[data-testid="drawer-right"] span[dir="auto"][title]',
          '[data-testid="drawer-right"] .zoWT4 span[dir="auto"]',
        ];

        for (const sel of selectors) {
          document.querySelectorAll(sel).forEach((el) => {
            const text = (el as HTMLElement).innerText?.trim() ||
              el.getAttribute("title")?.trim() || "";

            if (
              text &&
              text.length > 2 &&
              text !== "You" &&
              !text.includes("member") &&
              !text.toLowerCase().includes("add participant")
            ) {
              results.add(text);
            }
          });
        }

        // Fallback: scan all spans with title attribute in the drawer
        // This catches phone numbers for unsaved contacts
        const drawer = document.querySelector('[data-testid="drawer-right"]');
        if (drawer) {
          drawer.querySelectorAll("span[title]").forEach((el) => {
            const title = el.getAttribute("title")?.trim() || "";
            // Phone number pattern: starts with + or digits, 7+ chars
            if (title && (title.startsWith("+") || /^\d{7,}/.test(title))) {
              results.add(title);
            }
          });
        }

        return Array.from(results);
      });

      console.log(`✅ Found ${members.length} members`);
      extractedMembers = members;
      currentStatus = "done";
    } catch (error) {
      console.error("Scraping error:", error);
      currentStatus = "error";
    } finally {
      if (browser) {
        await browser.close().catch(console.error);
        browser = null;
      }
    }
  });

  app.get("/status", (req, res) => {
    res.json({
      status: currentStatus,
      members: extractedMembers,
      qrCode: currentQrCode,
    });
  });

  // Reset endpoint so user can run again without restarting server
  app.post("/reset", (req, res) => {
    currentStatus = "idle";
    extractedMembers = [];
    currentQrCode = null;
    res.json({ ok: true });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*all", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`\n🚀 Server running on http://localhost:${PORT}`);
    console.log(`📱 Open the app, paste a group link, and scan the QR code\n`);
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

startServer();
