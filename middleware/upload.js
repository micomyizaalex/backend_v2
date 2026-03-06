const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ─── Profile picture — disk storage ──────────────────────────────────────────
const profilesDir = path.join(__dirname, '..', 'uploads', 'profiles');
if (!fs.existsSync(profilesDir)) fs.mkdirSync(profilesDir, { recursive: true });

const profileStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, profilesDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `profile-${crypto.randomBytes(10).toString('hex')}${ext}`);
  },
});

const profileImageFilter = (_req, file, cb) => {
  const allowed = /jpeg|jpg|png|webp/;
  if (allowed.test(file.mimetype) && allowed.test(path.extname(file.originalname).toLowerCase())) {
    cb(null, true);
  } else {
    cb(new Error('Only JPG, PNG or WebP images are allowed'));
  }
};

const uploadProfileImage = multer({
  storage: profileStorage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
  fileFilter: profileImageFilter,
}).single('profile_image');

// ─── Generic in-memory upload (kept for existing usages) ─────────────────────
const memoryStorage = multer.memoryStorage();

const upload = multer({
  storage: memoryStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const filetypes = /jpeg|jpg|png|webp|gif/;
    if (filetypes.test(file.mimetype) && filetypes.test(path.extname(file.originalname).toLowerCase())) {
      return cb(null, true);
    }
    cb(new Error('Only image files are allowed'));
  },
});

const uploadSingleImage = (fieldName) => upload.single(fieldName);
const uploadMultipleImages = (fieldName, maxCount) => upload.array(fieldName, maxCount);

module.exports = { uploadProfileImage, uploadSingleImage, uploadMultipleImages };
