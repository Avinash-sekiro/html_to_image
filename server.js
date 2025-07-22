const express = require('express');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 5000;

app.use(bodyParser.text({ limit: '10mb' }));  // Accept raw HTML

app.post('/convert-html-to-image', async (req, res) => {
    const htmlContent = req.body;

    if (!htmlContent) {
        return res.status(400).send('No HTML content received');
    }

    try {
        const browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });
        const page = await browser.newPage();

        await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

        const imageBuffer = await page.screenshot({ type: 'png', fullPage: true });

        await browser.close();

        res.set('Content-Type', 'image/png');
        res.send(imageBuffer);

    } catch (err) {
        console.error('Conversion error:', err);
        res.status(500).send('Failed to convert HTML to image');
    }
});

app.listen(PORT, () => {
    console.log(`HTML to Image server is running on http://localhost:${PORT}`);
});
