require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static('public'));
app.use(express.json());

// Cloudinary Configuration
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Multer for Temp Storage
const upload = multer({ dest: '/tmp/' });

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Build Endpoint
app.post('/build-flutter', upload.fields([{ name: 'icon', maxCount: 1 }, { name: 'projectZip', maxCount: 1 }]), async (req, res) => {
    try {
        const { appName, packageName } = req.body;

        // Validation
        if (!req.files || !req.files['icon'] || !req.files['projectZip']) {
            throw new Error("Missing files");
        }

        const iconFile = req.files['icon'][0];
        const zipFile = req.files['projectZip'][0];

        console.log(`Processing build for: ${appName}`);

        // 1. Upload Icon
        const iconUpload = await cloudinary.uploader.upload(iconFile.path, {
            folder: "aite_studio/icons"
        });

        // 2. Upload ZIP (Raw Resource)
        const zipUpload = await cloudinary.uploader.upload(zipFile.path, {
            resource_type: "raw",
            folder: "aite_studio/projects",
            public_id: `${packageName}_source_${Date.now()}`
        });

        // 3. Trigger GitHub Dispatch
        const githubPayload = {
            event_type: "build-flutter",
            client_payload: {
                app_name: appName,
                package_name: packageName,
                icon_url: iconUpload.secure_url,
                zip_url: zipUpload.secure_url,
                request_id: Date.now().toString()
            }
        };

        await axios.post(
            `https://api.github.com/repos/${process.env.GITHUB_REPO_OWNER}/${process.env.GITHUB_REPO_NAME}/dispatches`,
            githubPayload,
            {
                headers: {
                    'Authorization': `token ${process.env.GITHUB_TOKEN}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            }
        );

        // Cleanup
        if (fs.existsSync(iconFile.path)) fs.unlinkSync(iconFile.path);
        if (fs.existsSync(zipFile.path)) fs.unlinkSync(zipFile.path);

        res.json({
            success: true,
            message: "Build triggered successfully",
            build_id: githubPayload.client_payload.request_id,
            icon_url: iconUpload.secure_url,
            zip_url: zipUpload.secure_url
        });

    } catch (error) {
        console.error("Server Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});
// امسح app.listen القديم واستبدله بهذا:
const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;
