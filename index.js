const express = require("express");
const bodyParser = require("body-parser");
const nodeHtmlToImage = require("node-html-to-image");
const puppeteer = require("puppeteer");

const app = express();
app.use(bodyParser.json({ limit: '2mb' }));

app.post("/image", async (req, res) => {
  try {
    const image = await nodeHtmlToImage({
      html: req.body.html,
      puppeteerArgs: {
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      },
      encoding: "buffer"
    });

    res.setHeader("Content-Type", "image/png");
    res.send(image);
  } catch (err) {
    console.error("Error:", err);
    res.status(500).send("Failed to convert HTML to image");
  }
});

app.listen(5000, () => console.log("✅ Server started on port 5000"));
