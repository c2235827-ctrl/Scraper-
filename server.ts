import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Mock state for the scraper
  let currentStatus: "idle" | "qr" | "scraping" | "done" = "idle";
  let extractedMembers: string[] = [];

  // API routes
  app.post("/scrape", (req, res) => {
    const { link } = req.body;
    if (!link) {
      return res.status(400).json({ error: "Link is required" });
    }
    
    // Start scraping process (mocked)
    currentStatus = "qr";
    extractedMembers = [];
    
    // Simulate QR scan after 4 seconds
    setTimeout(() => {
      if (currentStatus === "qr") {
        currentStatus = "scraping";
        
        // Simulate scraping done after 4 more seconds
        setTimeout(() => {
          if (currentStatus === "scraping") {
            currentStatus = "done";
            extractedMembers = [
              "+1 (555) 123-4567 - John Doe",
              "+44 7700 900077 - Alice",
              "+91 98765 43210 - Bob",
              "+1 (555) 987-6543 - Charlie",
              "+61 412 345 678",
              "+49 151 23456789 - Eve",
              "+33 6 12 34 56 78",
              "+1 (555) 111-2222",
              "+44 7700 112233 - David",
              "+91 99887 76655",
              "+1 (555) 333-4444 - Sarah",
              "+61 499 888 777 - Mike",
              "+49 170 1234567",
              "+33 6 98 76 54 32 - Emma"
            ];
          }
        }, 4000);
      }
    }, 4000);

    res.json({ status: "scanning" });
  });

  app.get("/status", (req, res) => {
    res.json({ status: currentStatus, members: extractedMembers });
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
