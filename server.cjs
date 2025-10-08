// server.cjs
require("dotenv").config();
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const admin = require("firebase-admin");
const { v4: uuidv4 } = require("uuid");

// Express + CORS
const app = express();
app.use(
  cors({
    origin: [
      "http://localhost:5173", // Vite dev
      "http://localhost:5174",
      "https://be-ensamaine.web.app", // Firebase Hosting
      "https://2beensamaine.com", // Domain
    ],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json());

// Multer (للملفات في الذاكرة)
const upload = multer({ storage: multer.memoryStorage() });

// Firebase Admin
let db = null;
let auth = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  try {
    const serviceAccount = JSON.parse(
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    );
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    db = admin.firestore();
    auth = admin.auth();
    console.log("Firebase Admin initialized ✅");
  } catch (e) {
    console.error("Invalid FIREBASE_SERVICE_ACCOUNT_JSON ❌", e.message);
  }
} else {
  console.warn(
    "⚠️ FIREBASE_SERVICE_ACCOUNT_JSON not provided — token check disabled"
  );
}

// Cloudflare R2 client
const s3 = new S3Client({
  region: process.env.R2_REGION || "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY,
  },
});

// Middleware للتحقق من التوكن (اختياري)
async function verifyTokenIfPresent(req) {
  if (!auth) return null;
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return null;
  try {
    const decoded = await auth.verifyIdToken(token);
    return decoded.uid;
  } catch (e) {
    console.warn("Invalid token:", e.message);
    return null;
  }
}

// Preflight لجميع الـ OPTIONS
app.options(/.*/, (req, res) => {
  res.header("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Authorization,Content-Type");
  res.sendStatus(200);
});

// 📌 Upload endpoint
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "file missing" });

    const folder = req.body.folder || "uploads";
    const safeName = req.file.originalname.replace(/\s+/g, "_");
    const key = `${folder}/${Date.now()}_${uuidv4()}_${safeName}`;

    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      })
    );

    res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
    return res.json({ key });
  } catch (err) {
    console.error("Upload error:", err);
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
    return res.status(500).json({ error: err.message || "upload failed" });
  }
});

// 📌 Media endpoint (Presigned URL)
app.get("/media", async (req, res) => {
  try {
    const fileKey = req.query.file;
    if (!fileKey) return res.status(400).json({ error: "file missing" });

    const uid = await verifyTokenIfPresent(req);

    // إذا كان PUBLIC_MEDIA != true يجب وجود مستخدم
    if (process.env.PUBLIC_MEDIA !== "true" && !uid) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const getCmd = new GetObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: fileKey,
    });

    const url = await getSignedUrl(s3, getCmd, { expiresIn: 300 }); // 5 دقائق
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");

    return res.json({ url, expiresIn: 300 });
  } catch (err) {
    console.error("Media error:", err);
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
    return res.status(500).json({ error: err.message || "server error" });
  }
});

// Run server
const PORT = process.env.PORT || 4000;
console.log("Bucket =", process.env.R2_BUCKET);
console.log("Endpoint =", process.env.R2_ENDPOINT);
console.log("PUBLIC_MEDIA =", process.env.PUBLIC_MEDIA);
app.listen(PORT, () => console.log("🚀 Server listening on", PORT));
