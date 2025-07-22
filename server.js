const express = require('express');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer-core');  // 👈 Use puppeteer-core in Docker
const app = express();

const PORT = process.env.PORT || 5000;

// Body parser to handle raw HTML string
app.use(bodyParser.text({ limit: '10mb', type: '*/*' }));

// Convert HTML to image
app.post('/convert-html-to-image', async (req, res) => {
    const htmlContent = req.body;

    if (!htmlContent || typeof htmlContent !== 'string') {
        return res.status(400).send('No valid HTML content received');
    }

    try {
        const browser = await puppeteer.launch({
            executablePath: '/usr/bin/chromium-browser', // ✅ For Docker with Chromium
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-gpu',
                '--disable-dev-shm-usage'
            ],
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

app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on http://0.0.0.0:${PORT}`);
});
