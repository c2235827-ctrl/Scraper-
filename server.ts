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

    currentStatus = "scanning";
    extractedMembers = [];
    currentQrCode = null;
    res.json({ status: "scanning" });

    try {
      // Extract invite code from the link
      const match = link.match(/chat\.whatsapp\.com\/([A-Za-z0-9]+)/);
      if (!match) {
        throw new Error("Invalid WhatsApp group link");
      }
      const inviteCode = match[1];

      // Launch Puppeteer
      browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });

      const page = await browser.newPage();
      
      // Set a realistic user agent to avoid basic blocking
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

      // Go to WhatsApp Web with the invite code
      await page.goto(`https://web.whatsapp.com/accept?code=${inviteCode}`, { waitUntil: 'networkidle2' });

      currentStatus = "qr";

      // Wait for QR code data-ref
      try {
        await page.waitForSelector('div[data-ref]', { timeout: 30000 });
        const qrData = await page.$eval('div[data-ref]', (el) => el.getAttribute('data-ref'));
        if (qrData) {
          currentQrCode = qrData;
          console.log('\n\n=========================================');
          console.log('SCAN THIS QR CODE WITH WHATSAPP:');
          qrcode.generate(qrData, { small: true });
          console.log('=========================================\n\n');
        }
        
        // Start a loop to keep updating the QR code if it changes (WhatsApp rotates it)
        const qrInterval = setInterval(async () => {
          if (currentStatus !== "qr") {
            clearInterval(qrInterval);
            return;
          }
          try {
            const newQrData = await page.$eval('div[data-ref]', (el) => el.getAttribute('data-ref'));
            if (newQrData && newQrData !== currentQrCode) {
              currentQrCode = newQrData;
            }
          } catch (e) {
            // Element might be gone if logged in
          }
        }, 2000);

      } catch (e) {
        console.log("QR code not found. Might already be logged in or page structure changed.");
      }

      // Wait for the main chat window to load (indicates successful login and group join)
      await page.waitForSelector('#main', { timeout: 60000 });
      currentStatus = "scraping";
      currentQrCode = null; // Clear QR code once logged in

      // Click the group header to open the info sidebar
      await page.click('#main header').catch(() => {});
      
      // Wait a bit for the sidebar animation and members to load
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Extract members
      // WhatsApp DOM is heavily obfuscated and virtualized. This is a heuristic approach.
      const members = await page.evaluate(() => {
        const results = new Set<string>();
        
        // 1. Try to get from the subtitle (comma separated list of names/numbers)
        const subtitleEl = document.querySelector('#main header span[title]');
        if (subtitleEl) {
          const title = subtitleEl.getAttribute('title');
          if (title) {
            title.split(',').forEach(s => {
              const trimmed = s.trim();
              if (trimmed && trimmed.toLowerCase() !== 'you') {
                results.add(trimmed);
              }
            });
          }
        }

        // 2. Try to get from the sidebar DOM (phone numbers)
        // Look for typical member row containers or text elements
        const spans = document.querySelectorAll('span[dir="auto"]');
        spans.forEach(span => {
          const text = span.textContent;
          if (text) {
            // Match phone numbers (e.g., +1 234 567 8900)
            if (text.match(/^\+?\d[\d\s\-()]{7,}\d$/)) {
              results.add(text);
            }
          }
        });

        return Array.from(results);
      });

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
    res.json({ status: currentStatus, members: extractedMembers, qrCode: currentQrCode });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*all', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
