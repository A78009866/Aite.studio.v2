const express = require('express');
const multer = require('multer');
const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
const path = require('path'); // ضروري للمسارات
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

// زيادة السعة
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use(cors());

// تحديد مكان واجهة الموقع (مجلد public) بشكل دقيق
const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath));

// المسار الرئيسي: إذا دخل المستخدم للموقع، نعرض له index.html
app.get('/', (req, res) => {
    const indexPath = path.join(publicPath, 'index.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.send(`
            <h1 style="color:red">Error: index.html not found!</h1>
            <p>Please make sure you created a folder named <b>public</b> and put your <b>index.html</b> inside it.</p>
            <p>Current directory searched: ${publicPath}</p>
        `);
    }
});

// إعداد التخزين المؤقت
const uploadDir = path.join('/tmp'); 
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        // تنظيف اسم الملف لتجنب مشاكل الرموز
        const safeName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
        cb(null, safeName);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 100 * 1024 * 1024 } 
});

// نقطة استقبال الطلب
app.post('/trigger-build', upload.fields([{ name: 'file' }, { name: 'icon' }]), async (req, res) => {
    try {
        const { appName, packageName, displayName } = req.body;
        
        if (!req.files || !req.files['file'] || !req.files['icon']) {
            return res.status(400).json({ error: 'Project file (zip) and Icon are required!' });
        }

        const projectFile = req.files['file'][0];
        const iconFile = req.files['icon'][0];

        console.log(`Processing: ${projectFile.originalname} & ${iconFile.originalname}`);

        // 1. رفع المشروع
        const projectFormData = new FormData();
        projectFormData.append('file', fs.createReadStream(projectFile.path));
        
        console.log('Uploading ZIP...');
        const projectUpload = await axios.post('https://file.io/?expires=1d', projectFormData, {
            headers: projectFormData.getHeaders(),
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });

        // 2. رفع الأيقونة
        const iconFormData = new FormData();
        iconFormData.append('file', fs.createReadStream(iconFile.path));
        
        console.log('Uploading Icon...');
        const iconUpload = await axios.post('https://file.io/?expires=1d', iconFormData, {
            headers: iconFormData.getHeaders(),
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });

        if (!projectUpload.data.success || !iconUpload.data.success) {
            throw new Error('Failed to upload files to temporary storage.');
        }

        // 3. إرسال إلى GitHub
        const requestId = Math.floor(Math.random() * 1000000);
        await axios.post(
            `https://api.github.com/repos/${process.env.GITHUB_REPO_OWNER}/${process.env.GITHUB_REPO_NAME}/dispatches`,
            {
                event_type: 'build-flutter',
                client_payload: {
                    zip_url: projectUpload.data.link,
                    icon_url: iconUpload.data.link,
                    app_name: appName || 'app',
                    display_name: displayName || 'My App',
                    package_name: packageName || 'com.example.app',
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

        // تنظيف
        try {
            fs.unlinkSync(projectFile.path);
            fs.unlinkSync(iconFile.path);
        } catch (e) { console.error('Cleanup error:', e); }

        res.json({ success: true, message: 'Build started!', buildId: requestId });

    } catch (error) {
        console.error('SERVER ERROR:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
    console.log(`Serving frontend from: ${publicPath}`);
});
