const express = require('express');
const multer = require('multer');
const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
const path = require('path');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

// 1. زيادة سعة استقبال البيانات لـ Express لتجنب أخطاء JSON الكبيرة
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use(cors());

// إعداد مجلد الملفات المؤقتة
const uploadDir = '/tmp'; 
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// 2. إعداد Multer للسماح بملفات كبيرة (حتى 100 ميغا)
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 100 * 1024 * 1024 } // 100 MB Limit
});

app.use(express.static('public'));

app.post('/trigger-build', upload.fields([{ name: 'file' }, { name: 'icon' }]), async (req, res) => {
    try {
        const { appName, packageName, displayName } = req.body;
        const projectFile = req.files['file'] ? req.files['file'][0] : null;
        const iconFile = req.files['icon'] ? req.files['icon'][0] : null;

        if (!projectFile || !iconFile) {
            return res.status(400).json({ error: 'Project file and icon are required' });
        }

        console.log(`Received files: Project=${projectFile.size} bytes, Icon=${iconFile.size} bytes`);

        // رفع الملفات إلى خدمة تخزين مؤقتة (file.io) لأن GitHub Actions لا يستقبل ملفات مباشرة
        // ملاحظة: يمكنك تغيير هذا لاحقاً لاستخدام AWS S3 أو Firebase إذا أردت استقراراً أعلى
        
        // 1. رفع ملف المشروع
        const projectFormData = new FormData();
        projectFormData.append('file', fs.createReadStream(projectFile.path));
        
        console.log('Uploading project zip to temporary storage...');
        const projectUploadResponse = await axios.post('https://file.io/?expires=1d', projectFormData, {
            headers: projectFormData.getHeaders(),
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });

        // 2. رفع ملف الأيقونة
        const iconFormData = new FormData();
        iconFormData.append('file', fs.createReadStream(iconFile.path));
        
        console.log('Uploading icon to temporary storage...');
        const iconUploadResponse = await axios.post('https://file.io/?expires=1d', iconFormData, {
            headers: iconFormData.getHeaders(),
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });

        if (!projectUploadResponse.data.success || !iconUploadResponse.data.success) {
            throw new Error('Failed to upload files to temporary storage');
        }

        const projectUrl = projectUploadResponse.data.link;
        const iconUrl = iconUploadResponse.data.link;

        console.log(`Files uploaded. URLs: \nProject: ${projectUrl} \nIcon: ${iconUrl}`);

        // إرسال الطلب إلى GitHub Actions
        const githubToken = process.env.GITHUB_TOKEN;
        const repoOwner = process.env.GITHUB_REPO_OWNER; 
        const repoName = process.env.GITHUB_REPO_NAME;
        
        // توليد معرف طلب عشوائي
        const requestId = Math.floor(Math.random() * 1000000);

        await axios.post(
            `https://api.github.com/repos/${repoOwner}/${repoName}/dispatches`,
            {
                event_type: 'build-flutter',
                client_payload: {
                    zip_url: projectUrl,
                    icon_url: iconUrl,
                    app_name: appName,
                    display_name: displayName,
                    package_name: packageName,
                    request_id: requestId
                }
            },
            {
                headers: {
                    'Authorization': `token ${githubToken}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            }
        );

        // تنظيف الملفات المؤقتة
        fs.unlinkSync(projectFile.path);
        fs.unlinkSync(iconFile.path);

        res.json({ success: true, message: 'Build triggered successfully!', buildId: requestId });

    } catch (error) {
        console.error('Error:', error.message);
        if (error.response) console.error('Response data:', error.response.data);
        res.status(500).json({ error: error.message });
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
