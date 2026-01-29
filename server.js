require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const AdmZip = require('adm-zip');

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const upload = multer({ storage: multer.memoryStorage() });

function detectFlutterVersion(zipBuffer) {
    // نثبت النسخة 3.24.3 لأنها تدعم Dart 3.5 وتتوافق مع معظم الحزم الحديثة
    return '3.38.8.';
}

app.post('/build-flutter', upload.fields([{ name: 'icon', maxCount: 1 }, { name: 'projectZip', maxCount: 1 }]), async (req, res) => {
    try {
        if (!req.files || !req.files['icon'] || !req.files['projectZip']) {
            return res.status(400).json({ error: "Missing files" });
        }

        const { appName, packageName } = req.body;
        const detectedFlutterVersion = detectFlutterVersion(req.files['projectZip'][0].buffer);

        const uploadToCloudinary = (buffer, folder, resourceType, publicId = null) => {
            return new Promise((resolve, reject) => {
                const options = { folder: folder, resource_type: resourceType };
                if (publicId) options.public_id = publicId;
                const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
                    if (error) return reject(error);
                    resolve(result);
                });
                stream.end(buffer);
            });
        };

        const iconResult = await uploadToCloudinary(req.files['icon'][0].buffer, "aite_studio/icons", "image");
        const zipResult = await uploadToCloudinary(req.files['projectZip'][0].buffer, "aite_studio/projects", "raw", `${packageName}_src_${Date.now()}`);

        const requestId = Date.now().toString();

        await axios.post(
            `https://api.github.com/repos/${process.env.GITHUB_REPO_OWNER}/${process.env.GITHUB_REPO_NAME}/dispatches`,
            {
                event_type: "build-flutter",
                client_payload: {
                    app_name: appName ? appName.trim().replace(/[^a-z0-9]/gi, '_').toLowerCase() : "app",
                    display_name: appName || "My App",
                    package_name: packageName || "com.example.app",
                    icon_url: iconResult.secure_url,
                    zip_url: zipResult.secure_url,
                    flutter_version: detectedFlutterVersion,
                    request_id: requestId
                }
            },
            {
                headers: { 
                    'Authorization': `token ${process.env.GITHUB_TOKEN}`, 
                    'Accept': 'application/vnd.github.v3+json' 
                }
            }
        );

        res.json({ success: true, build_id: requestId, detected_version: detectedFlutterVersion });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/check-status/:buildId', async (req, res) => {
    try {
        const { buildId } = req.params;
        const { appName } = req.query;
        const releaseUrl = `https://api.github.com/repos/${process.env.GITHUB_REPO_OWNER}/${process.env.GITHUB_REPO_NAME}/releases/tags/build-${buildId}`;
        try {
            await axios.get(releaseUrl, { headers: { 'Authorization': `token ${process.env.GITHUB_TOKEN}` } });
            const downloadUrl = `https://github.com/${process.env.GITHUB_REPO_OWNER}/${process.env.GITHUB_REPO_NAME}/releases/download/build-${buildId}/${appName}.apk`;
            res.json({ completed: true, download_url: downloadUrl });
        } catch (e) {
            res.json({ completed: false });
        }
    } catch (e) {
        res.status(500).json({ error: "Check failed" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
