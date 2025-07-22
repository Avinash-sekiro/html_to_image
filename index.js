const express = require("express");
const bodyParser = require("body-parser");
const nodeHtmlToImage = require("node-html-to-image");
const puppeteer = require("puppeteer-core");
const app = express();
app.use(bodyParser.json());

app.post("/image", async (req, res) => {
  try {
    const browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      executablePath: '/usr/bin/chromium-browser' // Adjust if necessary
    });

    const image = await nodeHtmlToImage({
      html: req.body.html,
      puppeteer: {
        args: ['--no-sandbox'],
        browser
      },
      encoding: "buffer"
    });

    await browser.close();

    res.setHeader("Content-Type", "image/png");
    res.send(image);
  } catch (err) {
    console.error("Error:", err);
    res.status(500).send("Failed to convert HTML to image");
  }
});

app.listen(5000, () => console.log("Server started on port 5000"));
