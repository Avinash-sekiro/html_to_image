const express = require("express");
const nodeHtmlToImage = require("node-html-to-image");

const app = express();
app.use(express.json({ limit: '10mb' }));

app.post("/", async (req, res) => {
  try {
    const { html } = req.body;
    
    if (!html) {
      return res.status(400).json({ error: "html field is required" });
    }

    const image = await nodeHtmlToImage({
      html: html,
      puppeteerArgs: {
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu'
        ]
      },
      encoding: "buffer"
    });

    res.setHeader("Content-Type", "image/png");
    res.send(image);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});