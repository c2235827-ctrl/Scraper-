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
    if (!link) return res.status(400).json({ error: "Link is required" });

    if (currentStatus === "qr" || currentStatus === "scraping") {
      return res.status(400).json({ error: "Session already in progress" });
    }

    currentStatus = "qr";
    extractedMembers = [];
    currentQrCode = null;
    res.json({ status: "qr" });

    try {
      const match = link.match(/chat\.whatsapp\.com\/([A-Za-z0-9]+)/);
      if (!match) throw new Error("Invalid WhatsApp group link");
      const inviteCode = match[1];

      // Running in headless mode so it works directly in the cloud browser
      browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
        defaultViewport: { width: 1920, height: 1080 }, // CRITICAL: Force desktop layout so the right drawer exists
      });

      const page = await browser.newPage();
      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
      );

      await page.goto("https://web.whatsapp.com", { waitUntil: "domcontentloaded", timeout: 60000 });

      // Poll for QR code and expose to frontend
      const qrInterval = setInterval(async () => {
        if (currentStatus !== "qr") { clearInterval(qrInterval); return; }
        try {
          const qrData = await page.$eval('div[data-ref]', el => el.getAttribute("data-ref"));
          if (qrData && qrData !== currentQrCode) {
            currentQrCode = qrData;
            console.log("\n=========================================");
            console.log("SCAN THIS QR CODE:");
            qrcode.generate(qrData, { small: true });
            console.log("=========================================\n");
          }
        } catch (_) {}
      }, 2000);

      // Wait for login
      console.log("⏳ Waiting for QR scan...");
      try {
        await page.waitForFunction(
          () => !!document.querySelector('#pane-side, [data-testid="chat-list"], #app .two, [data-testid="search"]'),
          { timeout: 600000 } // Increased to 10 minutes
        );
      } catch (e) {
        throw new Error("Login timed out after 10 minutes. Please ensure you scan the QR code and wait for WhatsApp to finish loading your messages.");
      }
      clearInterval(qrInterval);
      currentQrCode = null;
      currentStatus = "scraping";
      console.log("✅ Logged in!");

      // Navigate to group invite page
      console.log("🔗 Opening group invite...");
      await page.goto(`https://web.whatsapp.com/accept?code=${inviteCode}`, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      await sleep(3000);

      // Click "Join Group" button if it appears
      try {
        const allButtons = await page.$$('div[role="button"], button');
        for (const btn of allButtons) {
          const text = await page.evaluate(el => el.textContent?.toLowerCase() || '', btn);
          if (text.includes('join')) {
            console.log("🟢 Clicking Join Group button...");
            await btn.click();
            await sleep(3000);
            break;
          }
        }
      } catch (_) {}

      // Wait for group chat to load
      await page.waitForSelector("#main", { timeout: 60000 });
      await sleep(3000);

      // Verify we are in a group chat, not the contact list
      const isGroupChat = await page.evaluate(() => {
        const header = document.querySelector('#main header');
        const text = header?.textContent?.toLowerCase() || '';
        return text.includes('member') || text.includes('participant');
      });
      console.log("In group chat:", isGroupChat);
      if (!isGroupChat) {
        console.log("⚠️ Warning: May not be in a group. Check the browser window.");
      }

      // Click the group header to open info panel
      console.log("📋 Clicking group header...");
      await page.click("#main header");
      await sleep(3000);

      // Find the info panel drawer selector
      const drawerSel = await page.evaluate(() => {
        const candidates = [
          '[data-testid="drawer-right"]',
          '[data-testid="group-info-drawer"]',
          '#app > div > div.two > div:last-child',
          '#app aside',
          'div[role="navigation"]', // Sometimes used for the info panel
        ];
        for (const sel of candidates) {
          if (document.querySelector(sel)) return sel;
        }
        return null;
      });

      if (!drawerSel) {
        console.log("⚠️ Right drawer not found by selector. Will use coordinate-based fallback (right half of screen).");
      } else {
        console.log("✅ Drawer found:", drawerSel);
      }

      // Scroll the info panel and extract simultaneously
      console.log("⬇️ Scrolling and extracting members...");
      const allMembers = new Set<string>();

      for (let pass = 0; pass < 2; pass++) {
        // Reset to top
        await page.evaluate((sel) => {
          const el = sel ? document.querySelector(sel) : null;
          if (el) (el as HTMLElement).scrollTop = 0;
          else {
            // STRICT FALLBACK: Only scroll divs on the RIGHT half of the screen
            const panels = Array.from(document.querySelectorAll('div'))
              .filter(d => d.scrollHeight > d.clientHeight + 50 && d.getBoundingClientRect().left > window.innerWidth * 0.5)
              .sort((a, b) => b.scrollHeight - a.scrollHeight);
            if (panels[0]) panels[0].scrollTop = 0;
          }
        }, drawerSel);
        await sleep(1000);

        let previousScrollTop = -1;
        let unchangedCount = 0;

        for (let i = 0; i < 150; i++) { // Up to 150 scrolls per pass to handle 800+ members
          // 1. Extract visible members in the current scroll position
          const visibleMembers = await page.evaluate((sel) => {
            const results: string[] = [];
            
            let root = sel ? document.querySelector(sel) : null;
            if (!root) {
              const panels = Array.from(document.querySelectorAll('div'))
                .filter(d => d.getBoundingClientRect().left > window.innerWidth * 0.5 && d.clientHeight > window.innerHeight * 0.5)
                .sort((a, b) => b.scrollHeight - a.scrollHeight);
              if (panels.length > 0) root = panels[0];
            }
            if (!root) return [];

            // Find all participant rows
            const rows = root.querySelectorAll('div[role="listitem"], div[style*="transform"], div[style*="height"]');
            
            rows.forEach(row => {
              let name = "";
              let number = "";
              
              // Extract all text from the row
              const rowText = (row as HTMLElement).innerText || "";
              const lines = rowText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
              
              for (const line of lines) {
                if (line === "You" || line.toLowerCase().includes("admin") || line.toLowerCase().includes("members")) continue;
                
                // Check if line is a phone number
                if (line.startsWith("+") || /^\+?\d[\d\s\-]{7,}\d$/.test(line)) {
                  number = line;
                } else if (!name && line.length > 2) {
                  name = line;
                }
              }

              // Also check title attributes (sometimes numbers are hidden in titles)
              row.querySelectorAll('span[title], div[title]').forEach(el => {
                const title = el.getAttribute("title")?.trim() || "";
                if (title.startsWith("+") || /^\+?\d[\d\s\-]{7,}\d$/.test(title)) {
                  number = title;
                } else if (!name && title.length > 2 && title !== "You" && !title.toLowerCase().includes("admin")) {
                  name = title;
                }
              });

              if (number && name && number !== name) {
                // We have both name and number (saved contact)
                results.push(`${name} - ${number}`);
              } else if (number) {
                // Unsaved contact (just number)
                results.push(number);
              } else if (name) {
                // Saved contact but number not in DOM
                results.push(name);
              }
            });

            return results;
          }, drawerSel);

          // Add to our Set
          visibleMembers.forEach(m => {
            const lower = m.toLowerCase();
            if (!lower.includes("add participant") && !lower.includes("invite link") && !lower.includes("search")) {
              allMembers.add(m);
            }
          });

          // 2. Scroll down
          const scrollInfo = await page.evaluate((sel) => {
            let root = sel ? document.querySelector(sel) : null;
            if (!root) {
              const panels = Array.from(document.querySelectorAll('div'))
                .filter(d => d.scrollHeight > d.clientHeight + 50 && d.getBoundingClientRect().left > window.innerWidth * 0.5)
                .sort((a, b) => b.scrollHeight - a.scrollHeight);
              if (panels[0]) root = panels[0];
            }
            if (root) {
              (root as HTMLElement).scrollTop += 400;
              return { scrollTop: (root as HTMLElement).scrollTop };
            }
            return { scrollTop: -1 };
          }, drawerSel);

          // 3. Check if we reached the bottom
          if (scrollInfo.scrollTop === previousScrollTop && scrollInfo.scrollTop !== -1) {
            unchangedCount++;
            if (unchangedCount >= 3) {
              console.log(`Reached bottom of list on pass ${pass + 1}`);
              break; 
            }
          } else {
            unchangedCount = 0;
            previousScrollTop = scrollInfo.scrollTop;
          }

          await sleep(150);
        }
        await sleep(1000);
      }

      const members = Array.from(allMembers);
      console.log(`✅ Found ${members.length} members`);
      extractedMembers = members;
      currentStatus = "done";

    } catch (error: any) {
      console.error("Scraping error:", error?.message || error);
      currentStatus = "error";
    } finally {
      if (browser) {
        await browser.close().catch(console.error);
        browser = null;
      }
    }
  });

  app.get("/status", (req, res) => {
    res.json({ status: currentStatus, members: extractedMembers, qrCode: currentQrCode });
  });

  app.post("/reset", (req, res) => {
    if (currentStatus !== "qr" && currentStatus !== "scraping") {
      currentStatus = "idle";
      extractedMembers = [];
      currentQrCode = null;
    }
    res.json({ ok: true });
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*all", (req, res) => res.sendFile(path.join(distPath, "index.html")));
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`\n🚀 Server: http://localhost:${PORT}`);
    console.log("📱 Ready to scrape WhatsApp groups directly in the browser!\n");
  });
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

startServer();
