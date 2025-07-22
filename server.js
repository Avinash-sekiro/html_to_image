const express = require('express');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 5000;  // Use dynamic port if provided

app.use(bodyParser.text({ limit: '10mb' }));

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

// 👇 Listen on 0.0.0.0 for Coolify/production
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
});
